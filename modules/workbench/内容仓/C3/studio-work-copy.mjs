import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createContent,ContentError} from '../../../../../店主工作台/content/index.mjs';
import {createLocalVideoStore} from '../../../../../店主工作台/content/local-video.mjs';
import {renderCard} from '../../../../../店主工作台/content/render-card.mjs';

const fail=(code,st,msg)=>{const e=new ContentError(code,st);e.message=msg;throw e;};
const id=(x)=>typeof x==='string'&&x.trim()&&x.length<=200?x.trim():fail('INVALID_INPUT',400,'编号缺失或过长。');
const ver=x=>Number.isSafeInteger(x)&&x>0?x:fail('INVALID_INPUT',400,'请指定有效版本。');
const scope=c=>c?.shopId&&c?.actorId?{shopId:id(c.shopId),actorId:id(c.actorId)}:fail('UNAUTHORIZED',401,'需要本店有效身份。');
function owner(c){const s=scope(c);if(c.role!=='owner')fail('OWNER_REQUIRED',403,'请由店主确认。');return s;}
const sha=b=>createHash('sha256').update(b).digest('hex');
const block=(blockedOutcome,nextAction)=>({blockedOutcome,nextAction});

export function createStudio({db,catalog,album,mediaRoot,renderPlan}) {
  if(!path.isAbsolute(mediaRoot)||/^(?:\\\\|\/\/)/.test(mediaRoot))throw TypeError('absolute local mediaRoot required');
  fs.mkdirSync(mediaRoot,{recursive:true});
  const root=fs.realpathSync(mediaRoot),media=createLocalVideoStore(root);
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_choices(
      shop TEXT NOT NULL, id TEXT NOT NULL, product TEXT NOT NULL, pver INTEGER NOT NULL, version INTEGER NOT NULL,
      template TEXT NOT NULL, shots TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(shop,id), UNIQUE(shop,product,version));
    CREATE TABLE IF NOT EXISTS studio_works(
      shop TEXT NOT NULL, product TEXT NOT NULL, pver INTEGER NOT NULL, work TEXT NOT NULL, version INTEGER NOT NULL,
      task TEXT NOT NULL, choice TEXT NOT NULL, media_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
      status TEXT NOT NULL, info TEXT NOT NULL, approved_by TEXT, approved_at TEXT,
      PRIMARY KEY(shop,work,version), UNIQUE(shop,task));
    CREATE UNIQUE INDEX IF NOT EXISTS studio_active_approval ON studio_works(shop,product) WHERE status='approved';
    CREATE TABLE IF NOT EXISTS studio_receipts(
      shop TEXT NOT NULL, op TEXT NOT NULL, rid TEXT NOT NULL, body TEXT NOT NULL, reply TEXT NOT NULL,
      PRIMARY KEY(shop,op,rid));`);
  const one=(sql,...args)=>db.prepare(sql).get(...args), all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const qChoice=(s,cid)=>one('SELECT * FROM studio_choices WHERE shop=? AND id=?',s.shopId,cid);
  const latest=(s,p)=>one('SELECT * FROM studio_choices WHERE shop=? AND product=? AND pver=? ORDER BY version DESC LIMIT 1',s.shopId,p.productId,p.productVersion);
  const choiceTask=(s,cid)=>one("SELECT task_id FROM content_tasks WHERE shop_id=? AND json_extract(locked_json,'$.choiceId')=?",s.shopId,cid)?.task_id;
  const qWork=(s,p,w,v)=>one('SELECT * FROM studio_works WHERE shop=? AND product=? AND work=? AND version=?',s.shopId,p,w,v);
  function requireProduct(s,pid){const p=catalog.get(s,id(pid));if(!p)fail('PRODUCT_NOT_FOUND',404,'没有本店这张商品卡。');return p;}
  function orig(s,assetId){
    try{const a=album.readAsset(s,assetId);return a?.bytes&&['image/jpeg','image/png','image/webp'].includes(a.mime)?{...a,digest:sha(a.bytes)}:null;}
    catch(e){if(e.code==='asset_integrity')return null;throw e;}
  }
  function source(s,assetId,shot){
    if(!shot?.choiceId)return null;
    const c=qChoice(s,shot.choiceId);
    if(!c||c.revoked||c.product!==shot.productId)return null;
    const pinned=JSON.parse(c.shots).find(a=>a.assetId===assetId);
    if(!pinned||orig(s,assetId)?.digest!==pinned.digest)return null;
    return {...pinned,kind:'product_shot',rights:'usable',withdrawn:false,shopId:s.shopId};
  }
  function allLive(s,p,c){return c && !c.revoked && c.product===p.productId && c.pver===p.productVersion &&
    JSON.parse(c.shots).every(a=>p.assetIds.includes(a.assetId)&&source(s,a.assetId,{productId:p.productId,choiceId:c.id}));}
  function choiceView(s,c){
    const tid=choiceTask(s,c.id);
    return {choiceId:c.id,choiceVersion:c.version,productId:c.product,productVersion:c.pver,template:c.template,
      assetIds:JSON.parse(c.shots).map(a=>a.assetId),status:c.revoked?'withdrawn':tid?'consumed':'ready',...(tid?{taskId:tid}:{})};
  }
  function getChoice(ctx,productId){
    const s=scope(ctx),p=requireProduct(s,productId),c=latest(s,p);
    return allLive(s,p,c)?choiceView(s,c):null;
  }
  function tx(fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}
    catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}}
  function once(s,op,b,exec,onReplay){
    const key=id(b.requestId),body=JSON.stringify(b),r=one('SELECT body,reply FROM studio_receipts WHERE shop=? AND op=? AND rid=?',s.shopId,op,key);
    if(r){if(r.body!==body)fail('IDEMPOTENCY_CONFLICT',409,'同次操作内容发生变化。');const old=JSON.parse(r.reply);return onReplay?onReplay(old):old;}
    const out=exec();run('INSERT INTO studio_receipts VALUES(?,?,?,?,?)',s.shopId,op,key,body,JSON.stringify(out));return out;
  }
  function saveChoice(ctx,b){
    const s=owner(ctx),pid=id(b?.productId),pv=ver(b?.productVersion);
    if(b.grantOriginalUse!==true)fail('SOURCE_PERMISSION_REQUIRED',403,'未获得店主对此次使用本件原图的许可。');
    if(b.template!=='portrait_card')fail('INVALID_TEMPLATE',400,'请选择本件竖版图文短片。');
    if(b.assetId!==undefined&&b.assetIds!==undefined)fail('INVALID_INPUT',400,'请选择一种传图方式。');
    const ids=b.assetIds??[b.assetId];
    if(!Array.isArray(ids)||!ids.length||ids.length>6)fail('INVALID_INPUT',400,'请选择本件 1–6 张原图。');
    const a=ids.map(id);if(new Set(a).size!==a.length)fail('INVALID_INPUT',400,'同一原图请勿重复选择。');
    const input={requestId:id(b.requestId),productId:pid,productVersion:pv,assetIds:a,template:b.template,grantOriginalUse:true};
    return tx(()=>{
      const p=requireProduct(s,pid);
      return once(s,'choice',input,()=>{
        if(p.productVersion!==pv)fail('VERSION_CONFLICT',409,'商品已变，重新打开原卡。');
        if(!p.copyId||p.copyProductVersion!==pv)fail('COPY_REVIEW_REQUIRED',409,'请先在原卡确认当前版本的商品介绍。');
        const refs=catalog.getSummary(s,pid).assetRefs;
        const shots=a.map(assetId=>{
          const ref=refs.find(r=>r.assetId===assetId);
          if(!ref?.evidenceRef||!ref.groupId||!p.assetIds.includes(assetId))fail('NOT_THIS_PRODUCT_SOURCE',409,'所选原图不全属于这张商品卡。');
          const raw=orig(s,assetId);if(!raw)fail('SOURCE_UNAVAILABLE',409,'本件原图缺失或摘要异常，请补拍或复核。');
          return {assetId,digest:raw.digest,groupId:ref.groupId,groupVersion:ref.groupVersion,decisionSource:ref.decisionSource,evidenceRef:ref.evidenceRef};
        });
        const version=one('SELECT COALESCE(MAX(version),0)+1 v FROM studio_choices WHERE shop=? AND product=?',s.shopId,pid).v,cid=randomUUID();
        run('INSERT INTO studio_choices(shop,id,product,pver,version,template,shots,confirmed_by,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?)',
          s.shopId,cid,pid,pv,version,b.template,JSON.stringify(shots),s.actorId,new Date().toISOString());
        return choiceView(s,qChoice(s,cid));
      },old=>{
        const c=qChoice(s,old.choiceId),v=choiceView(s,c);
        return {...v,status:p.productVersion!==c.pver?'stale':v.status==='ready'&&latest(s,p)?.id!==c.id?'superseded':v.status};
      });
    });
  }
  function resolve(s,p,demand,b){
    if(!p.assetIds.length)return block('needs_source','补拍本件原图，或从原卡加入实拍。');
    if(!p.copyId||p.copyProductVersion!==p.productVersion)return block('needs_review','请先保存并确认本卡当前版本的商品介绍。');
    const current=latest(s,p),c=b.choiceId?qChoice(s,b.choiceId):current;
    if(!c)return block('needs_review','还没有本次原图许可；请选择本件照片并确认仅用于这次制作。');
    if(!allLive(s,p,c)||c.id!==current?.id&&!choiceTask(s,c.id))return block('needs_review','本次选择已失效，或原图归属、许可待复核。');
    return {choiceId:c.id,copyId:p.copyId,copyVersion:p.copyVersion,copyText:p.copyText,
      preferenceVersion:c.version,preferenceSnapshot:{scope:'this_production_only',template:c.template,choiceId:c.id},
      assets:JSON.parse(c.shots).map(a=>({...a,kind:'product_shot',shopId:s.shopId,productId:p.productId,choiceId:c.id,rights:'usable'}))};
  }
  function oldClips(s,pid){
    const p=requireProduct(s,pid);
    const current=latest(s,p);
    return all("SELECT * FROM studio_works WHERE shop=? AND product=? AND pver=? AND status='approved' ORDER BY approved_at DESC,version DESC",s.shopId,pid,p.productVersion)
      .flatMap(w=>{
        const live=allLive(s,p,qChoice(s,w.choice));
        // A revoked work is never returned. A fresh explicit permission for a
        // different production may start over; it never relicenses the old work.
        if(!live&&current?.id!==w.choice&&allLive(s,p,current))return [];
        return [{shopId:s.shopId,productId:pid,workId:w.work,workVersion:w.version,rights:live?'usable':'withdrawn',
          mediaKey:w.media_key,mediaSha256:w.digest}];
      });
  }
  const base=createContent({db,getProduct:catalog.get,mediaRoot:root,listOldVideos:oldClips,readSourceState:source,resolveInputs:resolve});
  // Only the gated C3 adapter may use this private production port. Keep the
  // ordinary lookup path on the existing old-clip-first service.
  const confirmedPlanBase=renderPlan&&createContent({db,getProduct:catalog.get,mediaRoot:root,listOldVideos:()=>[],readSourceState:source,resolveInputs:resolve});
  function requestConfirmedPlan(ctx,b){
    const s=owner(ctx);
    if(!confirmedPlanBase)fail('PLAN_RENDERER_NOT_MOUNTED',503,'需要明确分镜制作适配器。');
    return confirmedPlanBase.requestVideo(s,b);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS studio_one_job_per_choice ON content_tasks(shop_id,json_extract(locked_json,'$.choiceId')) WHERE json_type(locked_json,'$.choiceId')='text'");
  function requestVideo(ctx,b){
    const s=scope(ctx),r=base.requestVideo(s,b);
    if(r.outcome==='queued'){
      const t=base.getTask(s,r.taskId);
      if(t.needsReview)return {requestId:r.requestId,productId:r.productId,productVersion:r.productVersion,outcome:'needs_review',nextAction:t.nextAction,deliveryStatus:'not_submitted'};
      if(t.status==='approved'){
        const w=one('SELECT * FROM studio_works WHERE shop=? AND task=?',s.shopId,t.taskId);
        const ok=w&&media.readPlayable(w.media_key,w.digest);
        if(!ok)return {requestId:r.requestId,productId:r.productId,productVersion:r.productVersion,outcome:'needs_review',nextAction:'已确认版文件缺失或损坏，请复核，尚无可播放交付。',deliveryStatus:'not_submitted'};
      }
    }
    return r;
  }
  function getTask(ctx,taskId){
    const s=scope(ctx),t=base.getTask(s,id(taskId));
    const w=one('SELECT work,version FROM studio_works WHERE shop=? AND task=?',s.shopId,taskId);
    return {...t,kind:'content_video',...(w?{workRef:{workId:w.work,workVersion:w.version}}:{}),deliveryStatus:'not_submitted'};
  }
  function listTasks(ctx){const s=scope(ctx);return all('SELECT task_id FROM content_tasks WHERE shop_id=? ORDER BY rowid DESC',s.shopId)
    .map(r=>getTask(s,r.task_id));}
  const view=(w,p,live)=>({productId:w.product,productVersion:w.pver,workId:w.work,workVersion:w.version,taskId:w.task,
    status:w.pver!==p.productVersion?'stale':!live?'needs_review':w.status,recordedStatus:w.status,
    ...JSON.parse(w.info),deliveryStatus:'not_submitted'});
  function listWorks(ctx,pid){const s=scope(ctx),p=requireProduct(s,pid);return all('SELECT * FROM studio_works WHERE shop=? AND product=? ORDER BY version DESC',s.shopId,pid)
    .map(w=>view(w,p,allLive(s,p,qChoice(s,w.choice))&&
      (!['approved','awaiting_approval'].includes(w.status)||!!media.readPlayable(w.media_key,w.digest))));}
  function readyTask(s,tid){const t=getTask(s,tid);
    if(t.needsReview||!t.lockedInputs?.choiceId)fail('TASK_REVIEW_REQUIRED',409,'商品版本、原图或许可已变化，请在原卡重新核对。');
    return t;}
  function render(ctx,b){
    const s=owner(ctx),input={requestId:id(b?.requestId),taskId:id(b?.taskId)};
    let createdKey;
    try{return tx(()=>{
      const t=readyTask(s,input.taskId),p=requireProduct(s,t.productId);
      function existing(){return one('SELECT * FROM studio_works WHERE shop=? AND task=?',s.shopId,t.taskId);}
      function check(w){if(!w||!media.readPlayable(w.media_key,w.digest))fail('WORK_NOT_AVAILABLE',409,'当前作品文件缺失或发生变化，请复核。');return view(w,p,true);}
      return once(s,'render',input,()=>{
        const prior=existing();if(prior)return check(prior);
        const pins=t.lockedInputs, shots=pins.assets.map(a=>{
          const raw=orig(s,a.assetId);if(!raw||raw.digest!==a.digest)fail('SOURCE_CHANGED',409,'原图已改变。');
          return {...raw,digest:a.digest};
        });
        const key=randomUUID()+'.mp4', info=renderPlan ? renderPlan({shopId:s.shopId,productId:p.productId,productVersion:p.productVersion,taskId:t.taskId,root,key,shots,copyText:pins.copyText}) : renderCard(root,key,shots,pins.copyText);createdKey=key;
        const decoded=media.readPlayable(key);
        if(!decoded||decoded.frames!==info.frames||Math.abs(decoded.durationSeconds-info.durationSeconds)>.04)fail('OUTPUT_VERIFICATION_FAILED',503,'成片未通过完整解码，仍未出片。');
        const old=one('SELECT work,version FROM studio_works WHERE shop=? AND product=? ORDER BY version DESC LIMIT 1',s.shopId,p.productId);
        const work=old?.work??randomUUID(),wv=(old?.version??0)+1;
        const metadata={...info,codec:decoded.codec,mime:decoded.mime,sha256:decoded.sha256,copyId:pins.copyId,copyVersion:pins.copyVersion,choiceVersion:pins.preferenceVersion};
        run('INSERT INTO studio_works(shop,product,pver,work,version,task,choice,media_key,digest,status,info) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          s.shopId,p.productId,t.productVersion,work,wv,t.taskId,pins.choiceId,key,decoded.sha256,'awaiting_approval',JSON.stringify(metadata));
        run("UPDATE content_tasks SET status='awaiting_approval' WHERE shop_id=? AND task_id=?",s.shopId,t.taskId);
        return view(existing(),p,true);
      },()=>check(existing()));
    });}catch(e){if(createdKey&&fs.existsSync(path.join(root,createdKey)))fs.unlinkSync(path.join(root,createdKey));throw e;}
  }
  function approve(ctx,b){
    const s=owner(ctx),input={requestId:id(b?.requestId),productId:id(b?.productId),workId:id(b?.workId),workVersion:ver(b?.workVersion)};
    return tx(()=>{
      const p=requireProduct(s,input.productId),w=qWork(s,input.productId,input.workId,input.workVersion);
      if(!w)fail('WORK_NOT_AVAILABLE',404,'指定作品版本不属于这件货。');
      readyTask(s,w.task);if(!media.readPlayable(w.media_key,w.digest))fail('WORK_NOT_AVAILABLE',409,'指定版文件未通过播放检查。');
      const reply=()=>view(qWork(s,input.productId,input.workId,input.workVersion),p,true);
      return once(s,'approve',input,()=>{
        if(w.status==='superseded')fail('SUPERSEDED_WORK',409,'该版已被新确认取代，请重新复核。');
        run("UPDATE content_tasks SET status='superseded' WHERE shop_id=? AND task_id IN (SELECT task FROM studio_works WHERE shop=? AND product=? AND status='approved' AND version<>?)",s.shopId,s.shopId,p.productId,w.version);
        run("UPDATE studio_works SET status='superseded' WHERE shop=? AND product=? AND status='approved' AND version<>?",s.shopId,p.productId,w.version);
        if(w.status!=='approved')run("UPDATE studio_works SET status='approved',approved_by=?,approved_at=? WHERE shop=? AND work=? AND version=?",s.actorId,new Date().toISOString(),s.shopId,w.work,w.version);
        run("UPDATE content_tasks SET status='approved' WHERE shop_id=? AND task_id=?",s.shopId,w.task);return reply();
      },reply);
    });
  }
  function openPreview(ctx,b){
    const s=owner(ctx),p=requireProduct(s,b?.productId),w=qWork(s,p.productId,id(b?.workId),ver(b?.workVersion));
    if(!w||!['awaiting_approval','approved'].includes(w.status)||!allLive(s,p,qChoice(s,w.choice)))fail('WORK_NOT_AVAILABLE',404,'指定版不在本卡当前可预览范围。');
    const data=media.readPlayable(w.media_key,w.digest);if(!data)fail('WORK_NOT_AVAILABLE',404,'指定版文件没有通过校验。');
    return {productId:p.productId,workId:w.work,workVersion:w.version,...data};
  }
  function revokeChoice(ctx,b){
    const s=owner(ctx),input={requestId:id(b?.requestId),productId:id(b?.productId),choiceId:id(b?.choiceId)};
    return tx(()=>{requireProduct(s,input.productId);const c=qChoice(s,input.choiceId);if(!c||c.product!==input.productId)fail('CHOICE_NOT_FOUND',404,'该许可不属于本件。');
      return once(s,'revokeChoice',input,()=>{run('UPDATE studio_choices SET revoked=1 WHERE shop=? AND id=?',s.shopId,c.id);return {...choiceView(s,c),status:'withdrawn'};});});
  }
  return {saveChoice,getChoice,revokeChoice,requestVideo,requestConfirmedPlan,render,approve,getTask,listTasks,listWorks,openPreview,openOldVideo:base.openOldVideo};
}
