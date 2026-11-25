import {createHash} from 'node:crypto';
import {readPlanPins} from '../content/c2-plan-prep.mjs';
import {validateCaptionPlan} from '../content/caption-policy.mjs';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/u.test(x);
const num=x=>Number.isSafeInteger(x)&&x>0;
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const must=(ok,code)=>{if(!ok)fail(code);};

// Keep each old Studio transaction separate; retry uses deterministic stage keys.
export function createPlanProduction({db,studio,resolveConfirmation,readActivePlanVersion,checkpoint=()=>{}}){
 must(typeof readActivePlanVersion==='function','C3_APPROVED_PLAN_READER_REQUIRED');
 db.exec('CREATE TABLE IF NOT EXISTS n22_plan_jobs(shop TEXT NOT NULL, confirmation TEXT NOT NULL, hash TEXT NOT NULL, '+
   'product TEXT NOT NULL,pver INTEGER NOT NULL,phase TEXT NOT NULL,task TEXT,choice TEXT,locked TEXT NOT NULL, '+
   'PRIMARY KEY(shop,confirmation), UNIQUE(shop,task))');
 const get=db.prepare('SELECT * FROM n22_plan_jobs WHERE shop=? AND confirmation=?');
 const task=db.prepare('SELECT * FROM n22_plan_jobs WHERE shop=? AND task=?');
 const add=db.prepare("INSERT OR IGNORE INTO n22_plan_jobs(shop,confirmation,hash,product,pver,phase,locked) VALUES(?,?,?,?,?,'confirmed',?)");
 const bind=db.prepare("UPDATE n22_plan_jobs SET choice=?,task=?,phase='queued' WHERE shop=? AND confirmation=? AND task IS NULL");
 const complete=db.prepare("UPDATE n22_plan_jobs SET phase='awaiting_adoption' WHERE shop=? AND confirmation=?");
 const linked=db.prepare('SELECT w.digest,w.info,j.locked FROM studio_works w JOIN n22_plan_jobs j ON '+
   'j.shop=w.shop AND j.task=w.task AND j.product=w.product AND j.pver=w.pver '+
   'WHERE w.shop=? AND w.product=? AND w.pver=? AND w.work=? AND w.version=?');
 function lock(ctx,q){
   must(ctx?.role==='owner'&&id(ctx.actorId)&&id(ctx.shopId),'C3_OWNER_REQUIRED');
   must(id(q?.confirmationId)&&id(q.productId)&&num(q.productVersion)&&id(q.draftSetId)&&num(q.draftSetVersion)&&
     id(q.planId)&&num(q.planVersion),'C3_EXACT_CONFIRMATION_REQUIRED');
   const c=resolveConfirmation(ctx,q.confirmationId);
   must(c&&c.active===true&&c.purpose==='render_selected_plan'&&c.shopId===ctx.shopId&&c.actorId===ctx.actorId&&c.productId===q.productId&&
     c.productVersion===q.productVersion&&c.currentProductVersion===q.productVersion&&c.draftSetId===q.draftSetId&&
     c.draftSetVersion===q.draftSetVersion&&c.planId===q.planId&&c.planVersion===q.planVersion,'C3_CONFIRMATION_NOT_AVAILABLE');
   const {assets}=c;
   // Independent authority: no draft from an exported folder or the confirmation payload.
   const draftSet=readActivePlanVersion(ctx,q.draftSetId,q.draftSetVersion);
   must(draftSet?.state==='editable'&&draftSet.shopId===ctx.shopId&&draftSet.actorId===ctx.actorId&&
      (draftSet.sessionId===undefined||draftSet.sessionId===ctx.sessionId)&&draftSet.productId===q.productId&&draftSet.productVersion===q.productVersion&&
      draftSet.draftSetId===q.draftSetId&&draftSet.version===q.draftSetVersion&&Array.isArray(draftSet.plans),'C3_CANCELED_OR_STALE');
   const plan=draftSet.plans.find(x=>x.planId===q.planId&&x.planVersion===q.planVersion);
   must(plan&&Array.isArray(plan.shots)&&plan.audio==='none'&&Array.isArray(assets)&&plan.shots.length===assets.length&&
     new Set(plan.shots.map(y=>y.assetId)).size===assets.length&&plan.shots.every(y=>assets.some(a=>a.assetId===y.assetId&&
       a.shopId===ctx.shopId&&a.productId===q.productId&&a.productVersion===q.productVersion&&a.active===true&&a.usage==='render_this_plan'&&
       a.confirmationId===q.confirmationId&&/^[a-f0-9]{64}$/.test(a.sha256))),'C3_SOURCE_NOT_APPROVED');
   const {profile:captionProfile}=validateCaptionPlan(plan,draftSet.captionProfile);
   const pins=readPlanPins(draftSet,plan);
   must(pins.every(p=>assets.some(a=>a.assetId===p.assetId&&a.sha256===p.sha256)),'C3_SOURCE_NOT_APPROVED');
   return {draftSetId:q.draftSetId,draftSetVersion:q.draftSetVersion,plan,planSha256:sha(plan),
       assetPinsDigest:draftSet.assetPinsDigest,captionProfile,assets:pins.map(({assetId,sha256,size,mime})=>({assetId,sha256,size,mime}))};
 }
 function run(ctx,q){
   const plan=lock(ctx,q), fingerprint=sha([ctx.actorId,q.productId,q.productVersion,q.draftSetId,q.draftSetVersion,q.planId,q.planVersion,plan]);
   const sh=ctx.shopId,k=q.confirmationId;
   add.run(sh,k,fingerprint,q.productId,q.productVersion,JSON.stringify(plan));
   let r=get.get(sh,k);must(r.hash===fingerprint,'C3_CONFIRMATION_CONFLICT');
   const base='n22-'+sha([sh,k]);
   if(!r.task){
     const choice=studio.saveChoice(ctx,{requestId:base+'-choice',productId:q.productId,productVersion:q.productVersion,
       assetIds:plan.plan.shots.map(s=>s.assetId),template:'portrait_card',grantOriginalUse:true});
     checkpoint('after_choice',choice);
     const result=studio.requestConfirmedPlan(ctx,{requestId:base+'-request',productId:q.productId,productVersion:q.productVersion,
       demand:'经本条明确确认的本件分镜',choiceId:choice.choiceId});
     must(result.outcome==='queued'&&id(result.taskId),'C3_PRODUCTION_NOT_QUEUED');
     bind.run(choice.choiceId,result.taskId,sh,k);
     r=get.get(sh,k);
   }
   must(r?.task&&r.choice,'C3_TASK_NOT_LINKED');
   checkpoint('before_render',{taskId:r.task});
   const result=studio.render(ctx,{requestId:base+'-render',taskId:r.task});
   must(result.planSha256===plan.planSha256&&result.assetPinsDigest===plan.assetPinsDigest&&
     ['awaiting_approval','approved'].includes(result.status),'C3_RENDER_RESULT_MISMATCH');
   checkpoint('after_render',result);
   complete.run(sh,k);
   return {confirmationId:k,taskId:r.task,productId:r.product,productVersion:r.pver,planRef:result.planRef,
     workRef:{workId:result.workId,workVersion:result.workVersion},status:result.status,sha256:result.sha256,
     durationSeconds:result.durationSeconds,frames:result.frames,assetPinsDigest:result.assetPinsDigest,deliveryStatus:'not_submitted'};
 }
 return {run,forTask({shopId,productId,productVersion,taskId}){
   const r=task.get(shopId,taskId);
   must(r&&r.product===productId&&r.pver===productVersion,'C3_TASK_BINDING');
   return JSON.parse(r.locked);
 },readWorkPlanProof(ctx,x){
   const r=linked.get(ctx.shopId,x.productId,x.productVersion,x.workId,x.workVersion);
   if(!r)return null;
   const locked=JSON.parse(r.locked), info=JSON.parse(r.info);
   must(/^[a-f0-9]{64}$/.test(locked.assetPinsDigest??'')&&info.assetPinsDigest===locked.assetPinsDigest&&
     info.planSha256===locked.planSha256&&info.sha256===r.digest,'C4_WORK_SOURCE_UNVERIFIED');
   return {productId:x.productId,productVersion:x.productVersion,workId:x.workId,workVersion:x.workVersion,
     assetPinsDigest:locked.assetPinsDigest,sha256:r.digest};
 }};
}
