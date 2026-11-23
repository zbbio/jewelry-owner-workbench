import {createHash,randomUUID as uid} from 'node:crypto';
import {execFile} from 'node:child_process';
import {vision,recognitionMethod} from './vision.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const J=JSON.stringify, P=JSON.parse, queues=new WeakMap();
const id=x=>typeof x==='string' && x.trim().length>0 && x.length<=512;
const ver=x=>Number.isSafeInteger(x) && x>=1;
const err=(code,httpStatus=400)=>Object.assign(new Error(code),{code,httpStatus});
function check(ok,code,status){if(!ok) throw err(code,status)}
function target(x){
  if(x.targetProductId===undefined && x.expectedVersion===undefined) return {};
  check(id(x.targetProductId)&&ver(x.expectedVersion),'invalid_target');
  return {targetProductId:x.targetProductId,expectedVersion:x.expectedVersion};
}
function python(mode,input){
  return new Promise((resolve,reject)=>{
    const child=execFile(process.env.ALBUM_PYTHON||'python',['-B','-c',vision,mode],
      {windowsHide:true,timeout:30000,maxBuffer:4*1024*1024},(e,out)=>{
        if(e) return reject(err('vision_unavailable',503));
        try{resolve(P(out))}catch{reject(err('vision_invalid_output',503))}
      });
    child.stdin.on('error',()=>{}); child.stdin.end(input);
  });
}

export function createAlbum({db,dataDir,catalog}){
  // Store originals as BLOBs in the caller's database under dataDir.
  db.exec([
    'CREATE TABLE IF NOT EXISTS alb_asset(s TEXT,id TEXT,h TEXT,m TEXT,b BLOB,f TEXT,PRIMARY KEY(s,id),UNIQUE(s,h))',
    'CREATE TABLE IF NOT EXISTS alb_task(s TEXT,id TEXT,child TEXT,items TEXT,analysis TEXT,PRIMARY KEY(s,id),UNIQUE(s,child))',
    'CREATE TABLE IF NOT EXISTS alb_op(s TEXT,k TEXT,r TEXT,sig TEXT,t TEXT,reply TEXT,PRIMARY KEY(s,k,r))',
    'CREATE TABLE IF NOT EXISTS alb_grp(s TEXT,id TEXT,p TEXT,v INTEGER,a TEXT,PRIMARY KEY(s,id),UNIQUE(s,p))',
    'CREATE TABLE IF NOT EXISTS alb_send(s TEXT,id TEXT,t TEXT,k TEXT,r TEXT,body TEXT,ids TEXT,proof TEXT,receipt TEXT,fault TEXT,PRIMARY KEY(s,id))',
    'CREATE INDEX IF NOT EXISTS alb_send_task ON alb_send(s,t)',
    'CREATE INDEX IF NOT EXISTS alb_send_op ON alb_send(s,k,r)'
  ].join(';'));
  const one=(q,...p)=>db.prepare(q).get(...p), all=(q,...p)=>db.prepare(q).all(...p);
  const run=(q,...p)=>db.prepare(q).run(...p);
  const tx=f=>{db.exec('BEGIN IMMEDIATE');try{const x=f();db.exec('COMMIT');return x}catch(e){db.exec('ROLLBACK');throw e}};
  const shop=c=>{check(id(c?.shopId)&&id(c?.actorId),'forbidden',403);return c.shopId};
  if(!queues.has(db)) queues.set(db,new Map());
  const queue=queues.get(db);
  function serial(c,f){
    const s=shop(c), next=(queue.get(s)||Promise.resolve()).catch(()=>{}).then(()=>f(s));
    queue.set(s,next);const clear=()=>{if(queue.get(s)===next) queue.delete(s)};
    next.then(clear,clear);return next;
  }
  const op=(s,k,r)=>one('SELECT * FROM alb_op WHERE s=? AND k=? AND r=?',s,k,r);
  const task=(s,t)=>one('SELECT * FROM alb_task WHERE s=? AND (id=? OR child=?)',s,t,t);
  const sends=(s,t)=>all('SELECT * FROM alb_send WHERE s=? AND t=? ORDER BY rowid',s,t);
  function view(s,t){
    const row=task(s,t); if(!row) return null;
    const jobs=sends(s,row.id), reserved=new Set(jobs.filter(j=>!j.fault).flatMap(j=>P(j.ids)));
    const items=P(row.items), pending=items.filter(i=>i.assetId&&!reserved.has(i.assetId)).map(i=>i.assetId);
    const linked=new Set(jobs.filter(j=>j.receipt).flatMap(j=>P(j.ids)));
    for(const i of items)if(i.assetId)i.groupStatus=linked.has(i.assetId)?'linked':reserved.has(i.assetId)?'awaiting_receipt':'pending_confirmation';
    const child=t===row.child, waiting=jobs.filter(j=>!j.receipt&&!j.fault);
    return {taskId:t,kind:child?'group_review':'import',...(child?{parentTaskId:row.id}:{}),
      items:child?items.filter(i=>pending.includes(i.assetId)):items,pendingAssetIds:pending,
      status:pending.length?'pending_confirmation':waiting.length?'awaiting_receipt':
        items.some(i=>i.status==='failed')?'finished_with_errors':'finished',
      ...(!child&&pending.length?{pendingTask:{taskId:row.child,parentTaskId:row.id}}:{}),
      receipts:jobs.filter(j=>j.receipt).map(j=>P(j.receipt)),analysis:P(row.analysis),
      handoffs:jobs.map(j=>({input:P(j.body),evidence:P(j.proof),error:j.fault?P(j.fault):null,
        status:j.receipt?'committed':j.fault?'failed':'awaiting_receipt'}))};
  }
  async function card(c,x){
    if(!x.targetProductId)return null;
    const p=await catalog.get(c,x.targetProductId);
    check(p&&p.productId===x.targetProductId,'not_found',404);
    check(p.productVersion===x.expectedVersion,'version_conflict',409);return p;
  }
  async function classify(c,s,fresh){
    const plans=[],refreshed=[],analysis={method:recognitionMethod,pairs:[]};
    if(!fresh.length)return {plans,analysis};
    let cards;
    try{cards=await catalog.list(c)}catch(e){
      if([401,403].includes(e.httpStatus??e.status))throw e;
      analysis.note='card_lookup_unavailable';return {plans,analysis};
    }
    const assets=new Map(fresh.map(a=>[a.id,a.f]));
    const known=[...new Set(cards.flatMap(p=>p.assetIds))], n=fresh.length;
    if(n*(known.length+(n-1)/2)>600){analysis.note='comparison_budget';return {plans,analysis}}
    let featureBytes=fresh.reduce((acc,a)=>acc+J(a.f).length,0),upgradeBytes=0,attempts=0;
    for(const a of known){
      const stored=one('SELECT f FROM alb_asset WHERE s=? AND id=?',s,a)?.f||'null';
      featureBytes+=stored.length;
      if(featureBytes>16*1024*1024){analysis.note='comparison_byte_budget';return {plans,analysis}}
      let f=P(stored);
      // Old tasks/receipts/cards stay intact. Recompute only V1 features from
      // hash-verified original bytes, within this batch's explicit budget.
      if(Array.isArray(f)&&f[3]?.v!==22){
        analysis.legacyReferences=(analysis.legacyReferences||0)+1;
        const row=one('SELECT h,length(b) n FROM alb_asset WHERE s=? AND id=?',s,a);
        if(attempts<4&&row?.n>0&&row.n<=8*1024*1024&&upgradeBytes+row.n<=12*1024*1024){
          attempts++;upgradeBytes+=row.n;
          const raw=Buffer.from(one('SELECT b FROM alb_asset WHERE s=? AND id=?',s,a).b);
          if(hash(raw)===row.h){
            try{
              const im=await python('image',raw);
              if(im.f?.[3]?.v===22){
                f=im.f;const encoded=J(f);featureBytes+=encoded.length-stored.length;
                if(featureBytes>16*1024*1024){analysis.note='comparison_byte_budget';return {plans,analysis}}
                refreshed.push([encoded,s,a,stored]);
              }
            }catch{/* Missing witness only yields weak geometry; no V1 promotion. */}
          }
        }
      }
      assets.set(a,f);
    }
    if(analysis.legacyReferences)analysis.legacyUpgraded=refreshed.length;
    const ids=[...assets.keys()], pairs=[],grid=ids.map(()=>new Map());
    const conflict=ids.map(()=>new Set());
    for(let i=0;i<n;i++)for(let j=i+1;j<ids.length;j++)
      if(assets.get(ids[i])&&assets.get(ids[j]))pairs.push([i,j]);
    let values;
    try{values=pairs.length?await python('pairs',J([[...assets.values()],pairs])):[]}
    catch{analysis.note='matcher_unavailable';return {plans,analysis}}
    for(let z=0;z<pairs.length;z++){
      const [i,j]=pairs[z],[level,mutual,inliers,reason]=values[z];
      grid[i].set(ids[j],level);grid[j].set(ids[i],level);
      if(['local_surface_conflict','subject_conflict'].includes(reason)){conflict[i].add(ids[j]);conflict[j].add(ids[i]);}
      analysis.pairs.push({left:ids[i],right:ids[j],level,mutual,inliers,reason});
    }
    const seen=new Set();
    for(let i=0;i<n;i++){
      if(seen.has(i))continue;
      const g=[i];seen.add(i);
      for(const a of g)for(let b=0;b<n;b++)if(!seen.has(b)&&grid[a].get(ids[b])===2){seen.add(b);g.push(b)}
      if(!g.every(a=>g.every(b=>a===b||grid[a].get(ids[b])===2)))continue;
      if(g.some(a=>fresh.some((_,b)=>!g.includes(b)&&grid[a].get(ids[b])>0)))continue;
      const candidates=cards.filter(p=>g.some(a=>p.assetIds.some(b=>grid[a].get(b)>0)));
      let p=null;
      if(candidates.length===1&&g.every(a=>candidates[0].assetIds.some(b=>grid[a].get(b)===2)&&
        !candidates[0].assetIds.some(b=>conflict[a].has(b))))p=candidates[0];
      else if(cards.length||g.length<2)continue;
      plans.push({ids:g.map(a=>ids[a]),p,why:'verified_aligned_surfaces',src:'system_checked'});
    }
    const disputed=new Set();
    for(const a of plans)for(const b of plans)if(a!==b&&a.p&&a.p.productId===b.p?.productId&&
      a.ids.some(x=>b.ids.some(y=>conflict[ids.indexOf(x)].has(y))))disputed.add(a.p.productId);
    return {plans:plans.filter(a=>!a.p||!disputed.has(a.p.productId)),analysis,refreshed};
  }
  function enqueue(s,c,t,k,r,plans){
    const merged=[];
    for(const a of plans){
      const old=a.p&&merged.find(b=>b.p?.productId===a.p.productId);
      if(old)old.ids.push(...a.ids);else merged.push({...a,ids:[...a.ids]});
    }
    for(const a of merged){
      const p=a.p, prev=p&&one('SELECT * FROM alb_grp WHERE s=? AND p=?',s,p.productId);
      if(p){
        const busy=all('SELECT body FROM alb_send WHERE s=? AND receipt IS NULL AND fault IS NULL',s)
          .some(j=>{const b=P(j.body);return b.targetProductId===p.productId||b.keptAssetIds.some(i=>p.assetIds.includes(i))});
        if(busy&&a.src==='system_checked')continue;
        check(!busy,'group_busy',409);
      }
      const body={requestId:uid(),taskId:t,groupId:prev?.id||uid(),groupVersion:(prev?.v||0)+1,
        keptAssetIds:[...new Set([...(prev?P(prev.a):[]),...a.ids])],decisionSource:a.src,evidenceRef:uid(),
        ...(p?{targetProductId:p.productId,expectedVersion:p.productVersion}:{})};
      const proof={evidenceRef:body.evidenceRef,source:a.src,reason:a.why,assetIds:a.ids,
        ...(a.src==='owner_confirmed'?{actorId:c.actorId}:{}),taskId:t};
      run('INSERT INTO alb_send VALUES(?,?,?,?,?,?,?,?,NULL,NULL)',s,body.requestId,t,k,r,J(body),J(a.ids),J(proof));
    }
  }
  async function deliver(c,s,k,r,t){
    let first;
    for(const j of all('SELECT * FROM alb_send WHERE s=? AND k=? AND r=? ORDER BY rowid',s,k,r)){
      if(j.receipt)continue;
      if(j.fault){const v=P(j.fault);first??=err(v.code,v.httpStatus);continue}
      const b=P(j.body);let a;
      try{a=await catalog.acceptGroup(c,b)}catch(e){
        const status=e.httpStatus??e.status;
        const definite=[400,403,404,409,422].includes(status)||/version_conflict|idempotency_conflict/i.test(e.code||'');
        const fault=err(e.code||'catalog_unavailable',status||(definite?409:503));
        if(definite)run('UPDATE alb_send SET fault=? WHERE s=? AND id=?',J({code:fault.code,httpStatus:fault.httpStatus}),s,j.id);
        first??=fault;continue;
      }
      if(!(a?.status==='committed'&&['requestId','taskId','groupId','groupVersion'].every(x=>a[x]===b[x])
        &&id(a.productId)&&(!b.targetProductId||a.productId===b.targetProductId)&&ver(a.productVersion)
        &&['created','images_added','unchanged'].includes(a.outcome)&&Array.isArray(a.linkedAssetIds)
        &&b.keptAssetIds.every(x=>a.linkedAssetIds.includes(x))&&Array.isArray(a.addedAssetIds)
        &&a.addedAssetIds.every(x=>a.linkedAssetIds.includes(x)))){
        first??=err('unverified_receipt',502);continue;
      }
      tx(()=>{
        run('INSERT INTO alb_grp VALUES(?,?,?,?,?) ON CONFLICT(s,id) DO UPDATE SET v=excluded.v,a=excluded.a WHERE alb_grp.v<excluded.v',
          s,b.groupId,a.productId,b.groupVersion,J(b.keptAssetIds));
        run('UPDATE alb_send SET receipt=? WHERE s=? AND id=?',J(a),s,j.id);
      });
    }
    if(first)throw Object.assign(first,{taskId:t,requestId:r});
    const reply={requestId:r,...view(s,t)};
    run('UPDATE alb_op SET reply=? WHERE s=? AND k=? AND r=?',J(reply),s,k,r);
    return reply;
  }
  async function write(c,k,r,signature,prepare){
    check(id(r),'invalid_request_id');
    return serial(c,async s=>{
      const sig=hash(J(signature)),old=op(s,k,r);
      if(old){check(old.sig===sig,'idempotency_conflict',409);return old.reply?P(old.reply):deliver(c,s,k,r,old.t)}
      const {t,save,plans}=await prepare(s);
      tx(()=>{save();run('INSERT INTO alb_op VALUES(?,?,?,?,?,NULL)',s,k,r,sig,t);enqueue(s,c,t,k,r,plans)});
      return deliver(c,s,k,r,t);
    });
  }
  async function importBatch(c,x){
    c={shopId:shop(c),actorId:c.actorId};check(x&&typeof x==='object','invalid_request');const dest=target(x);
    check(Array.isArray(x.files)&&x.files.length>0&&x.files.length<=64,'invalid_files');
    check(x.files.reduce((n,f)=>n+(Buffer.isBuffer(f?.bytes)?f.bytes.length:0),0)<=36*1024*1024,'batch_too_large',413);
    const data=x.files.map(f=>Buffer.isBuffer(f?.bytes)?Buffer.from(f.bytes):null), hashes=data.map(b=>b?hash(b):null);
    return write(c,'import',x.requestId,[dest,hashes],async s=>{
      const p=await card(c,dest),t=uid(),items=[],fresh=[],byHash=new Map();
      for(let i=0;i<data.length;i++){
        const b=data[i],h=hashes[i],item={itemId:uid()}; items.push(item);
        const found=h&&(byHash.get(h)||one('SELECT id FROM alb_asset WHERE s=? AND h=?',s,h)?.id);
        if(found){Object.assign(item,{status:'duplicate',duplicateOf:found});continue}
        let im;
        if(!b?.length||b.length>8*1024*1024)im={error:b?.length?'image_too_large':'invalid_image'};
        else try{im=await python('image',b)}catch(e){im={error:e.code}}
        if(im.error){Object.assign(item,{status:'failed',reason:im.error});continue}
        const a={id:uid(),h,b,m:im.mime,f:im.f};
        fresh.push(a);byHash.set(h,a.id);Object.assign(item,{status:'kept',assetId:a.id});
      }
      const {plans,analysis,refreshed=[]}=p?{plans:fresh.length?[{p,ids:fresh.map(a=>a.id),why:'target_card_selection',src:'owner_confirmed'}]:[],analysis:{method:'target_card'}}:await classify(c,s,fresh);
      return {t,plans,save:()=>{
        for(const row of refreshed)run('UPDATE alb_asset SET f=? WHERE s=? AND id=? AND f=?',...row);
        for(const a of fresh)run('INSERT INTO alb_asset VALUES(?,?,?,?,?,?)',s,a.id,a.h,a.m,a.b,J(a.f));
        run('INSERT INTO alb_task VALUES(?,?,?,?,?)',s,t,uid(),J(items),J(analysis));
      }};
    });
  }
  async function resolve(c,x){
    c={shopId:shop(c),actorId:c.actorId};check(id(x?.taskId)&&Array.isArray(x.groups)&&x.groups.length,'invalid_resolution');
    const tid=x.taskId,groups=x.groups.map(g=>{check(Array.isArray(g?.assetIds)&&g.assetIds.length&&g.assetIds.every(id),'invalid_group');
      return {assetIds:[...g.assetIds],...target(g)}});
    return write(c,'resolve',x.requestId,[tid,groups],async s=>{
      const row=task(s,tid);check(row,'not_found',404);
      const avail=new Set(view(s,row.id).pendingAssetIds),plans=[];
      for(const g of groups){
        for(const a of g.assetIds)check(avail.delete(a),'asset_not_pending',409);
        plans.push({ids:g.assetIds,p:await card(c,g),why:'owner_group_choice',src:'owner_confirmed'});
      }
      return {t:row.id,plans,save:()=>{}};
    });
  }
  // Re-open the existing outbox. The caller never supplies a group, target, version
  // or original write body. A lost catalog response is recovered with the exact
  // previously saved catalog requestId so a committed card is never created twice.
  async function retryTask(c,x){
    c={shopId:shop(c),actorId:c.actorId};
    check(x&&id(x.taskId)&&id(x.requestId)&&Object.keys(x).every(k=>k==='taskId'||k==='requestId'),'invalid_retry');
    const {taskId,requestId}=x;
    return serial(c,async s=>{
      const row=task(s,taskId);check(row,'not_found',404);
      const signature=hash(J([taskId])),old=op(s,'retry',requestId);
      if(old){check(old.sig===signature,'idempotency_conflict',409);if(old.reply)return P(old.reply)}
      else run('INSERT INTO alb_op VALUES(?,?,?,?,?,NULL)',s,'retry',requestId,signature,row.id);
      const pending=all('SELECT k,r FROM alb_send WHERE s=? AND t=? AND receipt IS NULL AND fault IS NULL GROUP BY k,r ORDER BY MIN(rowid)',s,row.id);
      let first;
      for(const {k,r} of pending){
        try{await deliver(c,s,k,r,row.id)}catch(e){
          // A permanent failure in a sibling handoff must stay visible for human
          // correction, not prevent recovering a different committed handoff.
          if(one('SELECT 1 FROM alb_send WHERE s=? AND t=? AND k=? AND r=? AND receipt IS NULL AND fault IS NULL',s,row.id,k,r))first??=e;
        }
      }
      if(first)throw Object.assign(first,{taskId:row.id,requestId});
      const out={requestId,...view(s,row.id)};
      run('UPDATE alb_op SET reply=? WHERE s=? AND k=? AND r=?',J(out),s,'retry',requestId);
      return out;
    });
  }
  const getTask=(c,t)=>view(shop(c),t);
  function listTasks(c){const s=shop(c);return all('SELECT id,child FROM alb_task WHERE s=? ORDER BY rowid DESC',s)
    .flatMap(r=>{const v=view(s,r.id);return v.pendingTask?[v,view(s,r.child)]:[v]})}
  const hasAsset=(c,a)=>!!one('SELECT 1 FROM alb_asset WHERE s=? AND id=?',shop(c),a);
  function readAsset(c,a){
    const x=one('SELECT b,m,h FROM alb_asset WHERE s=? AND id=?',shop(c),a);if(!x)return null;
    const b=Buffer.from(x.b);check(hash(b)===x.h,'asset_integrity',500);return {bytes:b,mime:x.m};
  }
  return {importBatch,resolve,retryTask,listTasks,getTask,readAsset,hasAsset};
}
