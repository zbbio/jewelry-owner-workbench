import {createHash,randomUUID as uid} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {vision,visionCore,recognitionMethod} from './vision.mjs';
import {inspectOriginal} from './intake-image.mjs';

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
const traceImage=visionCore+'\ntrace={}\nr=inspect(sys.stdin.buffer.read(),trace)\nprint(json.dumps({**r,"trace":trace}))\n';
// The Python loader has location-dependent path literals. Fingerprint exact source
// bytes instead, so matching installations share a semantic extractor version.
const extractionFiles=['vision.mjs','local-surface.mjs','subject-locate.py','subject-match.py'];
const referenceExtractor=Object.freeze({method:recognitionMethod,version:hash(J([
  'a3-read-source-trace-v1',recognitionMethod,...extractionFiles.map(file=>hash(readFileSync(new URL(file,import.meta.url))))
]))});
const refLimits=Object.freeze({maxAssets:32,maxOriginalBytes:12*1024*1024,maxSingleOriginal:8*1024*1024,
  maxCacheEntries:48,maxCacheBytes:16*1024*1024,ttlMs:10*60*1000,maxPairs:600,maxExtractMs:24000});
function referenceCache(){
  const entries=new Map();let bytes=0;
  function drop(key){const old=entries.get(key);if(old){bytes-=old.bytes;entries.delete(key);}}
  return {
    get(scope,digest){
      const key=J([scope,digest,referenceExtractor.version]),x=entries.get(key);
      if(x?.until>Date.now())return x.value;
      drop(key);return null;
    },
    put(scope,digest,value){
      const key=J([scope,digest,referenceExtractor.version]),size=Buffer.byteLength(J(value));
      if(size>refLimits.maxCacheBytes)return;
      drop(key);
      for(const [k,v] of entries)if(v.until<=Date.now())drop(k);
      while(entries.size>=refLimits.maxCacheEntries||bytes+size>refLimits.maxCacheBytes)drop(entries.keys().next().value);
      entries.set(key,{scope,value,bytes:size,until:Date.now()+refLimits.ttlMs});bytes+=size;
    },
    revoke(scope){for(const [k,x] of entries)if(x.scope===scope)drop(k);}
  };
}
function python(mode,input,timeout=30000){
  return new Promise((resolve,reject)=>{
    const child=execFile(process.env.ALBUM_PYTHON||'python',['-B','-c',mode==='trace_image'?traceImage:vision,mode],
      {windowsHide:true,timeout,maxBuffer:4*1024*1024},(e,out)=>{
        if(e) return reject(err('vision_unavailable',503));
        try{resolve(P(out))}catch{reject(err('vision_invalid_output',503))}
      });
    child.stdin.on('error',()=>{}); child.stdin.end(input);
  });
}

export function createAlbum({db,dataDir,catalog}){
  const refCache=referenceCache();
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
  async function classify(c,s,fresh,draftRefs){
    const plans=[],refreshed=[],analysis={method:recognitionMethod,pairs:[]};
    if(!fresh.length)return {plans,analysis};
    let cards;
    try{cards=draftRefs?.cards??await catalog.list(c)}catch(e){
      if([401,403].includes(e.httpStatus??e.status))throw e;
      analysis.note='card_lookup_unavailable';return {plans,analysis};
    }
    const assets=new Map(fresh.map(a=>[a.id,a.f]));
    const known=[...new Set(cards.flatMap(p=>p.assetIds))], n=fresh.length;
    if(n*(known.length+(n-1)/2)>600){analysis.note='comparison_budget';return {plans,analysis}}
    let featureBytes=fresh.reduce((acc,a)=>acc+J(a.f).length,0),upgradeBytes=0,attempts=0;
    for(const a of known){
      if(draftRefs){
        const feature=draftRefs.features.get(a)??null;
        featureBytes+=J(feature).length;
        if(featureBytes>16*1024*1024){analysis.note='comparison_byte_budget';return {plans,analysis};}
        assets.set(a,feature);continue;
      }
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
  // N22 A1/A2 never enters enqueue/deliver or classify, including replay.
  function saveOrganized(c,r,signature,prepare){
    check(id(r),'invalid_request_id');
    return serial(c,async s=>{
      const k='organize',sig=hash(J(signature)),old=op(s,k,r);
      if(old){check(old.sig===sig,'idempotency_conflict',409);check(old.reply,'incomplete_organize',500);return P(old.reply)}
      const {t,save}=await prepare(s);
      return tx(()=>{
        save();
        const reply={requestId:r,...view(s,t)};
        run('INSERT INTO alb_op VALUES(?,?,?,?,?,?)',s,k,r,sig,t,J(reply));
        return reply;
      });
    });
  }
  async function storeBatch(c,x,organize){
    c={shopId:shop(c),actorId:c.actorId};check(x&&typeof x==='object','invalid_request');
    if(organize)check(id(x.messageId)&&Object.keys(x).every(k=>['requestId','messageId','files'].includes(k)),'invalid_organize_request');
    const dest=organize?{}:target(x);
    check(Array.isArray(x.files)&&x.files.length>0&&x.files.length<=64,'invalid_files');
    check(x.files.reduce((n,f)=>n+(Buffer.isBuffer(f?.bytes)?f.bytes.length:0),0)<=36*1024*1024,'batch_too_large',413);
    const data=x.files.map(f=>Buffer.isBuffer(f?.bytes)?Buffer.from(f.bytes):null), hashes=data.map(b=>b?hash(b):null);
    const prepare=async s=>{
      const p=organize?null:await card(c,dest),t=uid(),items=[],fresh=[],byHash=new Map();
      for(let i=0;i<data.length;i++){
        const b=data[i],h=hashes[i],item={itemId:uid()}; items.push(item);
        if(organize)Object.assign(item,{source:'selected_upload',ordinal:i,sha256:h});
        const found=h&&(byHash.get(h)||one('SELECT id FROM alb_asset WHERE s=? AND h=?',s,h)?.id);
        if(found){Object.assign(item,{status:'duplicate',duplicateOf:found});continue}
        let im;
        if(!b?.length||b.length>8*1024*1024)im={error:b?.length?'image_too_large':'invalid_image'};
        else try{im=organize?await inspectOriginal(b):await python('image',b)}catch(e){im={error:e.code||'vision_unavailable'}}
        if(im.error){Object.assign(item,{status:'failed',reason:im.error});continue}
        const a={id:uid(),h,b,m:im.mime,f:im.f};
        fresh.push(a);byHash.set(h,a.id);Object.assign(item,{status:'kept',assetId:a.id});
      }
      const only={plans:[],analysis:{method:'same_shop_sha256_only',mode:'organize_only',messageId:x.messageId,requestId:x.requestId}};
      const {plans,analysis,refreshed=[]}=organize?only:p?{plans:fresh.length?[{p,ids:fresh.map(a=>a.id),why:'target_card_selection',src:'owner_confirmed'}]:[],analysis:{method:'target_card'}}:await classify(c,s,fresh);
      return {t,plans,save:()=>{
        for(const row of refreshed)run('UPDATE alb_asset SET f=? WHERE s=? AND id=? AND f=?',...row);
        for(const a of fresh)run('INSERT INTO alb_asset VALUES(?,?,?,?,?,?)',s,a.id,a.h,a.m,a.b,J(a.f));
        run('INSERT INTO alb_task VALUES(?,?,?,?,?)',s,t,uid(),J(items),J(analysis));
      }};
    };
    return organize?saveOrganized(c,x.requestId,[x.messageId,hashes],prepare):write(c,'import',x.requestId,[dest,hashes],prepare);
  }
  // The product port controls the currently approved shop, owner, session,
  // card version and every original asset. Do not enumerate album holdings or
  // accept product/asset identifiers supplied by a client.
  async function allowedCardProjection(c,s,catalogRead){
    const rows=await catalogRead.list(c);
    check(Array.isArray(rows),'invalid_catalog_projection',503);
    check(rows.length<=refLimits.maxPairs,'comparison_budget',413);
    const cards=[],seen=new Set();
    for(const listed of rows){
      check(id(listed?.productId)&&!seen.has(listed.productId)&&
        (listed.shopId===undefined||listed.shopId===s),'invalid_catalog_projection',503);
      seen.add(listed.productId);
      const p=await catalogRead.get(c,listed.productId);
      check(p?.productId===listed.productId&&p.productVersion===listed.productVersion&&
        (p.shopId===undefined||p.shopId===s)&&ver(p.productVersion)&&Array.isArray(p.assetIds)&&
        p.assetIds.every(id)&&new Set(p.assetIds).size===p.assetIds.length&&
        J(p.assetIds)===J(listed.assetIds),'invalid_catalog_projection',503);
      if(p.assetIds.length)cards.push({productId:p.productId,productVersion:p.productVersion,assetIds:[...p.assetIds]});
    }
    return cards.sort((a,b)=>a.productId<b.productId?-1:a.productId>b.productId?1:0);
  }
  function blankReading(status,note,authorization=status){
    return {status,cards:[],references:[],possiblePairs:0,matcherCalls:0,pairs:[],queryEvidence:[],
      strongPairs:0,candidates:[],note,extractor:referenceExtractor,limits:refLimits,
      authorization:{state:authorization,cardCount:0,referenceCount:0,rechecked:false},
      counts:{originalsVerified:0,extractionAttempts:0,cacheHits:0,featureReady:0}};
  }
  async function inspectCardReferences(c,s,fresh,catalogRead,items){
    const empty=(status,note,authorization)=>({out:blankReading(status,note,authorization),plans:[]});
    if(typeof catalogRead?.list!=='function'||typeof catalogRead?.get!=='function')return empty('not_mounted',null);
    if(c.role!=='owner'||!id(c.sessionId)||!id(c.actorId)||c.shopId!==s)
      return empty('denied','reference_access_requires_scoped_owner');
    if(!items.length)return empty('not_requested','no_kept_queries');
    const scope=J([s,c.actorId,c.sessionId]);
    let cards;
    try{cards=await allowedCardProjection(c,s,catalogRead);}
    catch(e){
      refCache.revoke(scope);
      return e?.code==='comparison_budget'?empty('budget','comparison_budget'):
        empty('unavailable','catalog_lookup_unavailable');
    }
    const out=blankReading('checked',null,'approved'),ids=[...new Set(cards.flatMap(p=>p.assetIds))];
    out.cards=cards;
    out.authorization={state:'approved',cardCount:cards.length,referenceCount:ids.length,rechecked:false};
    out.possiblePairs=items.length*ids.length;
    if(!ids.length){out.note='no_authorized_references';return {out,plans:[]};}
    const stable=J(cards);
    async function verifyScope(){
      try{return J(await allowedCardProjection(c,s,catalogRead))===stable;}
      catch{return false;}
    }
    const redact=()=>{
      refCache.revoke(scope);
      return empty('permission_changed','catalog_reference_projection_changed','changed');
    };
    if(ids.length>refLimits.maxAssets||out.possiblePairs+items.length*(items.length-1)/2>refLimits.maxPairs){
      if(!await verifyScope())return redact();
      out.authorization.rechecked=true;out.status='budget';out.note='comparison_budget';return {out,plans:[]};
    }
    const features=new Map(),deadline=Date.now()+refLimits.maxExtractMs;
    let total=0;
    for(const assetId of ids){
      const trace={assetId,sha256:null,extractorVersion:referenceExtractor.version,cache:'not_consulted',
        bytesVerified:false,extractionStarted:false,state:'unavailable',firstReject:null};
      out.references.push(trace);
      const row=one('SELECT h,length(b) n FROM alb_asset WHERE s=? AND id=?',s,assetId);
      if(!row){trace.firstReject='authorized_asset_bytes_unavailable';continue;}
      if(row.n>refLimits.maxSingleOriginal||total+row.n>refLimits.maxOriginalBytes){
        out.note='reference_extraction_budget';trace.firstReject='reference_extraction_budget';continue;
      }
      if(Date.now()>=deadline){out.note='reference_extraction_budget';trace.firstReject='reference_extraction_budget';continue;}
      total+=row.n;
      try{
        const a=readOriginal(c,assetId);
        // Recheck bytes even on a cache hit. A new DB row or a reused ID is
        // never allowed to borrow an older original's witness.
        if(!a||a.bytes.length!==row.n||a.sha256!==row.h){
          trace.firstReject='authorized_asset_bytes_unavailable';continue;
        }
        trace.bytesVerified=true;trace.sha256=row.h;out.counts.originalsVerified++;
        let x=refCache.get(scope,row.h);
        if(x){trace.cache='hit';out.counts.cacheHits++;}
        else{
          trace.cache='miss';trace.extractionStarted=true;out.counts.extractionAttempts++;
          x=await python('trace_image',a.bytes,Math.max(1,deadline-Date.now()));
          if(x.error||!(Array.isArray(x.f)||x.f===null)){
            trace.firstReject=x.error??'vision_invalid_output';continue;
          }
          refCache.put(scope,row.h,x);
        }
        trace.firstReject=x.trace?.firstReject??null;
        trace.state=x.f?'feature_ready':'no_comparable_feature';
        trace.foreground=x.trace?.foreground??null;
        trace.keypoints=x.trace?.validKeypoints??null;
        trace.descriptorRows=x.trace?.descriptorRows??null;
        if(x.f){features.set(assetId,x.f);out.counts.featureReady++;}
      }catch(e){trace.firstReject=e.code??'vision_unavailable';}
    }
    const {plans,analysis}=await classify(c,s,fresh,{cards,features});
    const existing=new Set(ids);
    out.pairs=analysis.pairs.filter(p=>existing.has(p.right)&&!existing.has(p.left));
    out.matcherCalls=out.pairs.length;
    out.strongPairs=out.pairs.filter(x=>x.level===2).length;
    if(analysis.note){out.status='incomplete';out.note=analysis.note;}
    if(out.references.some(x=>x.state==='unavailable')){
      out.status='incomplete';out.note??='authorized_reference_incomplete';
    }
    // If scope, version or asset membership changed across Python awaits, the
    // old references and card IDs are no longer public even as diagnostics.
    if(!await verifyScope())return redact();
    out.authorization.rechecked=true;
    const eligible=out.status==='checked'?plans.filter(p=>p.p&&p.p.assetIds.every(id=>features.has(id))):[];
    const candidateRows=new Map(eligible.flatMap(x=>x.ids.map(assetId=>[assetId,x])));
    for(const item of items){
      const assetId=item.assetId,comparisons=out.pairs.filter(x=>x.left===assetId),best=candidateRows.get(assetId);
      const peers=cards.map(card=>{
        const p=comparisons.filter(x=>card.assetIds.includes(x.right));
        return {productId:card.productId,productVersion:card.productVersion,compared:p.length,
          weakOrStrong:p.filter(x=>x.level>0).length,strong:p.filter(x=>x.level===2).length,
          conflicts:p.filter(x=>['local_surface_conflict','subject_conflict'].includes(x.reason)).length};
      });
      const stage=best?'suggested_only':out.status==='incomplete'?'reference_incomplete':
        !fresh.find(p=>p.id===assetId)?.f?'query_feature_unavailable':
        !comparisons.length?'reference_feature_unavailable':
        peers.filter(x=>x.weakOrStrong).length>1?'competing_cards':'no_unique_strong_evidence';
      out.queryEvidence.push({assetId,potentialPairs:ids.length,actualPairs:comparisons.length,stage,perCard:peers});
    }
    out.candidates=eligible.map(x=>({assetIds:[...x.ids],productId:x.p.productId,productVersion:x.p.productVersion,
      role:'readonly_suggestion',authorizedReferenceCount:ids.length,byteVerifiedCount:out.counts.originalsVerified,
      featureReadyCount:out.counts.featureReady,actualPairs:out.pairs.filter(p=>x.ids.includes(p.left)).length,
      strongPairs:out.pairs.filter(p=>x.ids.includes(p.left)&&x.p.assetIds.includes(p.right)&&p.level===2).length}));
    return {out,plans:eligible};
  }
  // A3 uses the frozen matcher. Optional card comparisons are read-only suggestions.
  async function inspectOrganizeBatch(c,t,{catalogRead}={}){
    const s=shop(c),row=task(s,t);
    check(row&&row.id===t&&P(row.analysis).mode==='organize_only','not_found',404);
    const items=P(row.items).filter(x=>x.status==='kept'&&id(x.assetId));
    check(items.length<=12,'a3_batch_limit',413);
    const evidence=[],fresh=[];
    for(const i of items) {
      try{
        const a=readOriginal(c,i.assetId);
        check(a&&a.bytes.length<=8*1024*1024,'a3_asset_unavailable',503);
        const result=await python('trace_image',a.bytes);
        if(result.error){evidence.push({assetId:i.assetId,state:'unavailable',reason:result.error});continue;}
        fresh.push({id:i.assetId,f:result.f});
        evidence.push({assetId:i.assetId,sha256:a.sha256,bytesVerified:true,extractorVersion:referenceExtractor.version,
          state:result.f?'feature_ready':'no_comparable_feature',firstReject:result.trace?.firstReject??null,
          foreground:result.trace?.foreground??null,keypoints:result.trace?.validKeypoints??null,
          descriptorRows:result.trace?.descriptorRows??null});
      }catch(e){evidence.push({assetId:i.assetId,state:'unavailable',reason:e.code??'vision_unavailable'});}
    }
    // Do not pass any merchant catalogue into in-batch grouping, even if a
    // caller also injected a normal writer catalogue into createAlbum.
    const {plans,analysis}=await classify(c,s,fresh,{cards:[],features:new Map()});
    const refs=await inspectCardReferences(c,s,fresh,catalogRead,items);
    // Optional D2 cross-card diagnostics cannot suppress or reshape a batch
    // group. A suggestion may annotate an exact batch group or stand on its own.
    const joined=[...plans];
    for(const p of refs.plans){
      const hits=joined.filter(a=>a.ids.some(x=>p.ids.includes(x)));
      if(!hits.length)joined.push(p);
      else if(hits.length===1&&hits[0].ids.length===p.ids.length&&hits[0].ids.every(x=>p.ids.includes(x)))
        joined[joined.indexOf(hits[0])]=p;
    }
    return {taskId:t,method:recognitionMethod,eligibleAssetIds:items.map(x=>x.assetId),evidence,
       pairEvidence:analysis.pairs,cardReferences:refs.out,note:analysis.note??null,proposals:joined.map(x=>({keptAssetIds:x.ids,
       reason:x.why,...(x.p?{suggestedProductId:x.p.productId,suggestedProductVersion:x.p.productVersion}:{})}))};
  }
  const importBatch=(c,x)=>storeBatch(c,x,false);
  const organizeBatch=(c,x)=>storeBatch(c,x,true);
  async function resolve(c,x){
    c={shopId:shop(c),actorId:c.actorId};check(id(x?.taskId)&&Array.isArray(x.groups)&&x.groups.length,'invalid_resolution');
    const tid=x.taskId,groups=x.groups.map(g=>{check(Array.isArray(g?.assetIds)&&g.assetIds.length&&g.assetIds.every(id),'invalid_group');
      return {assetIds:[...g.assetIds],...target(g)}});
    return write(c,'resolve',x.requestId,[tid,groups],async s=>{
      const row=task(s,tid);check(row,'not_found',404);
      check(P(row.analysis).mode!=='organize_only','organize_batch_requires_explicit_handoff',409);
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
      check(P(row.analysis).mode!=='organize_only','organize_batch_requires_explicit_handoff',409);
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
  function readOriginal(c,a){
    const x=one('SELECT b,m,h FROM alb_asset WHERE s=? AND id=?',shop(c),a);if(!x)return null;
    const b=Buffer.from(x.b);check(hash(b)===x.h,'asset_integrity',500);return {bytes:b,mime:x.m,sha256:x.h};
  }
  function readAsset(c,a){
    const x=readOriginal(c,a);
    return x?{bytes:x.bytes,mime:x.mime}:null;
  }
  return {importBatch,organizeBatch,inspectOrganizeBatch,resolve,retryTask,listTasks,getTask,readAsset,hasAsset};
}
