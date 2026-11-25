import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateCaptionPlan,resolveCaptionFont} from './caption-policy.mjs';
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const assert=(ok,code)=>{if(!ok)fail(code);};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(x);
const version=x=>Number.isSafeInteger(x)&&x>0;
const line=(x,max=180)=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f]/u.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const MAX_ASSET_BYTES=8*1024*1024;
export const MIME_EXT=Object.freeze({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'});
export const byteHash=x=>createHash('sha256').update(x).digest('hex');
const validAssetId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(x);
const distinctIDs=ids=>new Set(ids.map(x=>x.toLowerCase())).size===ids.length;
const rights=(a,s)=>id(a?.assetId)&&hash(a.sha256)&&a.shopId===s.shopId&&a.productId===s.productId&&a.productVersion===s.productVersion&&
  a.kind==='product_shot'&&a.usage==='draft_planning'&&a.active===true&&id(a.grantId)&&version(a.grantVersion);
function owner(ctx,s){
  assert(id(ctx?.shopId)&&id(ctx?.actorId)&&ctx.role==='owner'&&ctx.shopId===s?.shopId&&ctx.actorId===s.actorId,'C2_SCOPE_DENIED');
}
function source(ctx,s){
  owner(ctx,s);
  assert(s.sessionId===undefined||(id(s.sessionId)&&ctx.sessionId===s.sessionId),'C2_SCOPE_DENIED');
  assert(s.allowPlanning===true&&id(s.productId)&&version(s.productVersion)&&id(s.messageId)&&
    id(s.copyId)&&version(s.copyVersion)&&line(s.confirmedCopy,400)&&id(s.preferenceId)&&version(s.preferenceVersion),'C2_SOURCE_NEEDS_REVIEW');
  assert(Array.isArray(s.assets)&&s.assets.length>=2&&s.assets.length<=6&&s.assets.every(a=>rights(a,s)&&validAssetId(a.assetId))&&
    distinctIDs(s.assets.map(a=>a.assetId)),'C2_SOURCE_NEEDS_REVIEW');
  return {shopId:s.shopId,actorId:s.actorId,productId:s.productId,productVersion:s.productVersion,messageId:s.messageId,
    ...(s.sessionId?{sessionId:s.sessionId}:{}),
    copyId:s.copyId,copyVersion:s.copyVersion,confirmedCopy:s.confirmedCopy,preferenceId:s.preferenceId,preferenceVersion:s.preferenceVersion,
    assets:s.assets.map(({assetId,sha256,grantId,grantVersion})=>({assetId,sha256,grantId,grantVersion}))};
}
const styles=[
 {styleId:'tea-table',label:'茶桌慢镜头',visualNote:'偏暖、稳定构图；只做构图建议，不替换实物或颜色。',durationMs:3800,overlay:'从近景看这件的细节'},
 {styleId:'coastal-clean',label:'海边清爽',visualNote:'清爽留白；海边是构图提案，不是产地、实景或已授权背景。',durationMs:2600,overlay:'从整体到细节看这件'}
];
// Caller supplies authoritative product/copy/preference and independently approved planning assets.
// These functions do not persist, launch a renderer, approve, price or publish.
export function prepareTwoPlans(ctx,s,{readApprovedAsset}={}){
  const snapshot=source(ctx,s), sourceDigest=digest(snapshot);
  assert(typeof readApprovedAsset==='function','C2_APPROVED_READER_REQUIRED');
  const assetPins=Object.freeze(snapshot.assets.map(a=>{
    const m=readApprovedAsset(ctx,{productId:snapshot.productId,productVersion:snapshot.productVersion,
      assetId:a.assetId,grantId:a.grantId,grantVersion:a.grantVersion});
    assert(m&&m.assetId===a.assetId&&m.shopId===snapshot.shopId&&m.productId===snapshot.productId&&
      m.productVersion===snapshot.productVersion&&m.grantId===a.grantId&&m.grantVersion===a.grantVersion&&
      Buffer.isBuffer(m.bytes),'C2_ASSET_MISSING');
    assert(m.bytes.length>0&&m.bytes.length<=MAX_ASSET_BYTES&&Object.hasOwn(MIME_EXT,m.mime),'C2_ASSET_INVALID');
    const sha256=byteHash(m.bytes);
    assert(sha256===a.sha256,'C2_ASSET_DIGEST_MISMATCH');
    return Object.freeze({...a,sha256,size:m.bytes.length,mime:m.mime});
  }));
  const plans=styles.map((st,i)=>{
    const order=i?[...snapshot.assets].reverse():snapshot.assets;
    return {planId:'plan-'+digest([sourceDigest,st.styleId]).slice(0,24),planVersion:1,styleId:st.styleId,label:st.label,
      visualNote:st.visualNote,audio:'none',factCopy:snapshot.confirmedCopy,
      shots:order.map((a,n)=>({assetId:a.assetId,durationMs:st.durationMs,caption:n===0?st.overlay:'本件实拍'}))};
  });
  const {profile:captionProfile}=resolveCaptionFont();
  for(const p of plans)validateCaptionPlan(p,captionProfile);
  return {schema:'n22.c2-plan/v2',draftSetId:'plans-'+sourceDigest.slice(0,24),version:1,state:'editable',
    shopId:snapshot.shopId,actorId:snapshot.actorId,productId:snapshot.productId,productVersion:snapshot.productVersion,
    ...(snapshot.sessionId?{sessionId:snapshot.sessionId}:{}),
    messageId:snapshot.messageId,sourceDigest,assetPins,assetPinsDigest:digest(assetPins),captionProfile,plans};
}
// Only a server-loaded plan version belongs here; an export manifest or a
// client-provided draft object is not an authority.
export function readPlanPins(state,plan){
  assert(state?.schema==='n22.c2-plan/v2'&&state.state==='editable'&&Array.isArray(state.plans)&&plan&&
    state.plans.some(p=>isDeepStrictEqual(plan,p)),'C2_APPROVED_PLAN_REQUIRED');
  const pins=state.assetPins;
  assert(Array.isArray(pins)&&pins.length>=2&&pins.length<=6&&pins.every(x=>validAssetId(x?.assetId)&&hash(x.sha256)&&
      version(x.size)&&x.size<=MAX_ASSET_BYTES&&Object.hasOwn(MIME_EXT,x.mime)&&id(x.grantId)&&version(x.grantVersion))&&
    distinctIDs(pins.map(x=>x.assetId))&&state.assetPinsDigest===digest(pins),'C2_APPROVED_PINS_REQUIRED');
  assert(Array.isArray(plan.shots)&&plan.shots.length===pins.length&&
    plan.shots.every(x=>validAssetId(x?.assetId)&&pins.some(p=>p.assetId===x.assetId))&&
    distinctIDs(plan.shots.map(x=>x.assetId)),'C2_PROJECT_SHOTS_MISMATCH');
  return plan.shots.map(s=>pins.find(p=>p.assetId===s.assetId));
}
function prior(ctx,s,previous,expected){
  const snapshot=source(ctx,s);
  assert(previous?.schema==='n22.c2-plan/v2'&&previous.shopId===s.shopId&&previous.actorId===s.actorId&&previous.productId===s.productId&&previous.productVersion===s.productVersion&&
    previous.messageId===s.messageId&&previous.sessionId===s.sessionId&&previous.sourceDigest===digest(snapshot),'C2_CONTEXT_CHANGED');
  assert(previous.version===expected,'C2_VERSION_CONFLICT');
  assert(Array.isArray(previous.assetPins)&&previous.assetPinsDigest===digest(previous.assetPins)&&
    isDeepStrictEqual(previous.assetPins.map(({assetId,sha256,grantId,grantVersion})=>({assetId,sha256,grantId,grantVersion})),snapshot.assets),
    'C2_APPROVED_PINS_REQUIRED');
  return snapshot;
}
export function editPlan(ctx,s,previous,{expectedVersion,planId,shots}={}){
  const snapshot=prior(ctx,s,previous,expectedVersion);
  assert(previous.state==='editable','C2_SET_CANCELED');
  const plan=previous.plans.find(x=>x.planId===planId);
  assert(plan,'C2_PLAN_NOT_AVAILABLE');
  assert(Array.isArray(shots)&&shots.length===snapshot.assets.length&&new Set(shots.map(a=>a?.assetId)).size===shots.length&&
    shots.every(a=>snapshot.assets.some(p=>p.assetId===a?.assetId)&&Number.isSafeInteger(a.durationMs)&&a.durationMs>=1000&&a.durationMs<=7000),
      'C2_INVALID_EDIT');
  const changed={...plan,planVersion:plan.planVersion+1,shots:shots.map(({assetId,durationMs,caption})=>({assetId,durationMs,caption}))};
  const {profile:captionProfile}=validateCaptionPlan(changed,previous.captionProfile);
  return {...previous,version:previous.version+1,captionProfile,plans:previous.plans.map(p=>p===plan?changed:p)};
}
export function cancelPlans(ctx,s,previous,{expectedVersion}={}){
  prior(ctx,s,previous,expectedVersion);
  if(previous.state==='canceled')return previous;
  assert(previous.state==='editable','C2_PLAN_NOT_AVAILABLE');
  // Keep the version IDs for caller audit; cancelled input must never enter C3.
  return {...previous,version:previous.version+1,state:'canceled'};
}
