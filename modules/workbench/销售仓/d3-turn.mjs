import {isDeepStrictEqual} from 'node:util';
import {parseD3CaptionCommand} from './d3-caption-command.mjs';
import {scopedD3ContentReceipt,projectD3CaptionIssue,projectD3CaptionPolicy,projectD3Preview} from './d3-display.mjs';
import {D3_PURPOSE, d3Identity, checkD3Consent, checkD3Target, createD3ContentConsent, isD3ConsentError} from './d3-consent.mjs';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0;
const sameCard=(x,y)=>x?.shopId===y.shopId&&x.productId===y.productId&&x.productVersion===y.productVersion;
const pair=(x,a,b)=>id(x?.[a])&&ver(x?.[b]);
const actionFor={prepare:'content_prepare',cancel:'content_cancel',confirm:'content_confirm',adopt:'content_adopt'};
const err=(code,httpStatus)=>Object.assign(new Error(code),{code,httpStatus});
const trim=s=>s.replace(/[。！？!?]+$/u,'').trim();
const published=/^(?:请)?(?:立即|直接|帮我)?(?:发布|发给|发送|上架|对外发布)/u;
const byWord={'一':1,'二':2,'1':1,'2':2};
const chooseWord=/第\s*([一二12])\s*(?:版|套|个分镜)/u;
const prepare=/^(?:请)?(?:帮我\s*)?(?:给.{1,36}?\s*)?(?:准备|拟(?:两|2)套|列(?:两|2)套).{0,80}(?:两种风格|两套风格|风格|分镜|本件新片|新片方案)/u;
const cancel=/^(?:请)?取消(?:刚才的?)?(?:这(?:一)?(?:个|套|版))?(?:分镜|方案|准备|制作)?$/u;
const confirm=/^(?:请)?(?:我)?确认(?:刚才的?)?(?:按|用|制作|做)?(?:这个分镜|这(?:一)?(?:套|版|个计划)|第\s*[一二12]\s*(?:版|套|个分镜))(?:分镜)?(?:来)?(?:做|制作|出片|渲染)?$/u;
const adopt=/^(?:请)?(?:我)?(?:确认)?采用(?:刚才的?)?(?:这(?:一)?版|这个作品|第\s*[一二12]\s*版)(?:作品)?$/u;
const noAction=/^(?:先)?(?:别|不(?:要|用|必)?|无需)(?:再)?(?:制作|做|新做|渲染|出片|发布|发送|外发|采用|确认|上架)/u;
const harmless=/^(?:先)?(?:别|不(?:要|用|必)?|无需)(?:再)?(?:制作|做|新做|渲染|出片|发布|发送|外发|上架)(?:本件|这版|新片|视频)?(?:了)?$/u;

// Exact, conservative ordinary-text commands. The returned intent never doubles
// as a grant or a product/media identifier.
export function parseD3Command(text){
 if(typeof text!=='string')return null;
 const edit=parseD3CaptionCommand(text);if(edit)return edit;
 const clauses=text.split(/[，,；;\n。！？!?]+/u).map(trim).filter(Boolean);
 if(!clauses.length)return null;
 let cmd=null, ordinal=null, invalid=false, noRender=false, noPublish=false;
 for(const q of clauses){
  if(harmless.test(q)){
   noRender ||= /制作|出片|渲染|做/u.test(q);
   noPublish ||= /发布|发送|外发|上架/u.test(q);
   continue;
  }
  const i=confirm.test(q)?'confirm':adopt.test(q)?'adopt':cancel.test(q)?'cancel':prepare.test(q)?'prepare':null;
  if(!i||noAction.test(q)||published.test(q)||/顺便|同时|再去发布|并发布|并发送/u.test(q)){invalid=true;continue;}
  if(cmd!==null){invalid=true;continue;}
  cmd=i;ordinal=byWord[q.match(chooseWord)?.[1]]??null;
 }
 // Do not capture S1's “找旧片，不要新做”. An recognized D3 command is
 // never allowed to fall through to quote on ambiguity or upstream failure.
 if(!cmd)return null;
 return {command:cmd,ordinal,invalid:invalid||(cmd==='confirm'&&noRender),noPublish};
}
const expected=x=>Object.fromEntries(['shopId','productId','productVersion'].map(k=>[k,x[k]]));
const byAction=(r,a)=>r.actions?.filter(x=>a.includes(x?.action))??[];
const scopedAction=(a,r)=>a?.requestId===r.requestId&&a?.messageId===r.messageId&&sameCard(a,r);
function planOptions(r){
 if(!r||!pair(r,'draftSetId','draftSetVersion')||!Array.isArray(r.plans)||r.plans.length<1||r.plans.length>2||
    r.plans.some(p=>!pair(p,'planId','planVersion'))||
    new Set(r.plans.map(p=>p.planId)).size!==r.plans.length)return null;
 return r;
}
const work=x=>pair(x,'workId','workVersion')?{workId:x.workId,workVersion:x.workVersion}:null;
const matching=(x,y)=>Object.keys(y).every(k=>x?.[k]===y[k]);
const safeText=(s,n)=>typeof s==='string'&&s.length<=n?s:undefined;
export function showDraft(r){
 const checked=planOptions(r);
 if(!checked)return null;
 const policy=projectD3CaptionPolicy(r.captionPolicy);
 return {draftSetId:r.draftSetId,draftSetVersion:r.draftSetVersion,...(policy?{captionPolicy:policy}:{}),plans:r.plans.map(p=>({
  planId:p.planId,planVersion:p.planVersion,label:safeText(p.label,120),
  ...(Array.isArray(p.shots)&&p.shots.length<=6?{shots:p.shots.map(s=>({
   assetId:id(s.assetId)?s.assetId:undefined,durationMs:Number.isSafeInteger(s.durationMs)?s.durationMs:undefined,
   caption:safeText(s.caption,400)
  }))}:{})
 }))};
}
const blockCodes=new Set(['needs_source','needs_review','canceled','stale_version','confirmation_required']);
// Product's structured editor joins the same conversation. Its handler must
// authenticate, resolve the active plan, and bind the message before use.
export function projectD3EditReceipt(input,raw){
 const changed=raw?.status==='drafts_ready';
 if(!scopedD3ContentReceipt(changed?{...input,draftSetVersion:undefined}:input,raw)||raw.taskId!=null||raw.workRef!=null||
    !pair(input,'draftSetId','draftSetVersion')||!pair(input,'planId','planVersion'))return null;
 if(changed&&(raw.draftSetVersion!==input.draftSetVersion+1||
     !raw.plans?.some?.(p=>p.planId===input.planId&&p.planVersion===input.planVersion+1)))return null;
 const result=changed?showDraft(raw):blockCodes.has(raw.status)?(projectD3CaptionIssue(input,raw)??{}):null;
 if(result===null)return null;
 const fields={...expected(input),requestId:input.requestId,messageId:input.messageId};
 return {...fields,status:raw.status==='drafts_ready'?'completed':'failed',actions:[
  {...fields,action:'content_prepare',status:raw.status,result:{...result,deliveryStatus:'not_submitted'}}]};
}
// The only browser-visible edit pointer has no draft/plan IDs or raw
// diagnostics. Compare both the content adapter's exact OLD target and the
// NEW public plan snapshots before allowing CAPUI to project the result.
function captionProjection(input,intent,old,raw){
 const editTarget={referenceMessageId:input.referenceMessageId,draftSetId:input.draftSetId,draftSetVersion:input.draftSetVersion,
  planId:input.planId,planVersion:input.planVersion,planOrdinal:intent.ordinal,shotOrdinal:intent.shotOrdinal};
 if(!matching(raw?.editTarget,editTarget)||raw?.captionCheck&&raw.captionCheck.shotIndex!==intent.shotOrdinal)return null;
 if(raw.status==='drafts_ready'){
  const want=showDraft(old), got=showDraft(raw);
  if(!want||!got)return null;
  want.draftSetVersion++;
  const plan=want.plans[intent.ordinal-1];
  plan.planVersion++;
  plan.shots[intent.shotOrdinal-1].caption=intent.caption;
  if(!isDeepStrictEqual(want,got))return null;
 }
 const answer=projectD3EditReceipt(input,raw);
 if(!answer)return null;
 return {...answer,actions:answer.actions.map(a=>({...a,result:{...a.result,captionEdit:{
  referenceMessageId:input.referenceMessageId,planOrdinal:intent.ordinal,shotOrdinal:intent.shotOrdinal}}}))};
}
const currentEditContext=(ctx,input,target,clock)=>target?.state==='current'&&
 matching(target,{shopId:ctx.shopId,actorId:ctx.actorId,sessionId:ctx.sessionId,requestId:input.requestId,messageId:input.messageId})&&
 id(target.referenceMessageId)&&target.referenceMessageId!==input.messageId&&id(target.productId)&&ver(target.productVersion)&&
 (input.referenceMessageId===null||target.referenceMessageId===input.referenceMessageId)&&
 typeof target.expiresAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(target.expiresAt)&&
 Date.parse(target.expiresAt)>clock();

const knownErrors={
 C2_ASSET_MISSING:'needs_source',C2_SOURCE_NEEDS_REVIEW:'needs_source',C2_ASSET_DIGEST_MISMATCH:'needs_review',
 C2_CONTEXT_CHANGED:'stale_version',C2_VERSION_CONFLICT:'stale_version',C2_SET_CANCELED:'canceled',
 D3_REFERENCE_VERSION_CHANGED:'stale_version',D3_PRODUCT_VERSION_CHANGED:'stale_version',D3_PRODUCTION_ALREADY_CONFIRMED:'stale_version',
 C3_CANCELED_OR_STALE:'stale_version',C3_SOURCE_NOT_APPROVED:'needs_review',
 C3_CONFIRMATION_NOT_AVAILABLE:'confirmation_required',C4_ADOPTION_NOT_CONFIRMED:'confirmation_required',
 C4_PRODUCT_VERSION_CHANGED:'stale_version'
};

// Content is a service port, not a model tool. Product owns the authoritative
// message ledger and names the isolated writable store. Without both, fail closed.
export function createD3TurnPort({product,catalog,canUse,contentD3,messageLedger,
 isWritableTestStore=()=>false,authorizeCommand,readPlanSelection,readCurrentTarget,withConsent,consentClock=Date.now,
 editCaption,readCaptionEditContext,captionClock=Date.now}={}){
 const contentExit=createD3ContentConsent({contentD3,withConsent,messageLedger,catalog,consentClock});
 return async function route(ctx,x){
  const intent=parseD3Command(x?.text);
  if(!intent)return null;
  if(ctx?.role!=='owner'||!id(ctx.shopId)||!id(ctx.actorId)||!id(ctx.sessionId)||await canUse?.(ctx)!==true)
   throw err('FORBIDDEN',403);
  if(!id(x.requestId)||!id(x.messageId)||x.text.length>500||x.replyToMessageId!=null&&!id(x.replyToMessageId)||
     Object.keys(x).some(k=>!['text','messageId','requestId','replyToMessageId'].includes(k)))throw err('INVALID_REQUEST',400);
  const {command,ordinal,invalid}=intent;
  const envelope={shopId:ctx.shopId,requestId:x.requestId,messageId:x.messageId};
  const stop=(status,code,message)=>({...envelope,status,code,actions:[],message});
  if(invalid)return stop('needs_clarification','D3_COMMAND_AMBIGUOUS',command==='edit'?
   '请只指定第几套、第几镜，把新字幕放在引号里；这条不确认制作。':
   '请单独发出一条明确的准备、取消、确认制作或采用指令。');
  if(await isWritableTestStore(ctx)!==true)return stop('failed','D3_STORE_NOT_ENABLED','这家店没有开放本次内容写入。');
  if(command==='edit'&&(typeof editCaption!=='function'||typeof readCaptionEditContext!=='function'||
     typeof messageLedger?.read!=='function'||typeof messageLedger?.bind!=='function'||typeof messageLedger?.restore!=='function'))
   return stop('failed','D3_CAPTION_EDITOR_NOT_CONNECTED','本店普通对话尚未接通字幕编辑。未建立制作任务。');
  if(command!=='edit'&&(typeof contentD3?.[command]!=='function'||typeof messageLedger?.read!=='function'||
     typeof messageLedger?.bind!=='function'||typeof messageLedger?.restore!=='function'))
   return stop('failed','D3_NOT_CONNECTED','本店普通对话尚未接通内容制作服务。');
  let mid=x.replyToMessageId??null;
  if(mid===x.messageId)return stop('needs_clarification','D3_REPLY_REQUIRED','请回复前一条属于本件的结果。');
  let reference=null, prior=null, picked, ref, grant, draft, editContext;
  try{
   if(command==='edit'){
    const selector={...envelope,referenceMessageId:mid};
    editContext=await readCaptionEditContext(ctx,selector);
    if(!currentEditContext(ctx,selector,editContext,captionClock))
     return stop('needs_clarification','D3_CAPTION_EDIT_REFERENCE_REQUIRED','请回复本件仍有效的分镜；选件、权限或时间已变更时须重新准备。');
    editContext={...editContext}; // Snapshot; do not accept an in-place change across awaits.
    mid=editContext.referenceMessageId;
   }
   if(mid){
    reference=await messageLedger.read(ctx,mid);
    prior=await messageLedger.restore(ctx,mid);
    if(!reference||!prior||prior.messageId!==mid||!id(prior.requestId)||prior.status!=='completed'||
       reference.shopId!==ctx.shopId||!sameCard(reference,prior))
      return stop('needs_clarification','D3_REPLY_NOT_AVAILABLE','找不到本店本会话里这条有效结果，请重新选定。');
   }
   if(command==='prepare'){
    const found=await product.resolve(ctx,{requestId:x.requestId,messageId:x.messageId,text:x.text,reference:mid,intent:'detail'});
    if(found?.requestId!==x.requestId||found?.messageId!==x.messageId||(found?.storeId??found?.shopId)!==ctx.shopId)
     return stop('failed','D3_PRODUCT_LOOKUP_REJECTED','商品回执不匹配。');
    if(found.status==='version_conflict')return stop('failed','D3_STALE_OR_WRONG_CARD','商品版本已变更，请重新准备。');
    if(found.status==='source_unavailable')return stop('failed','D3_PRODUCT_SOURCE_UNAVAILABLE','商品服务暂不可用。');
    if(found.status!=='matched'||found.total!==1||found.cards?.length!==1)
     return stop('needs_clarification','D3_PRODUCT_REQUIRED','请说具体货号，或回复本件商品消息。');
    picked={shopId:ctx.shopId,productId:found.cards[0].productId,productVersion:found.cards[0].productVersion};
    if(reference&&!sameCard(reference,picked))return stop('failed','D3_REFERENCE_CARD_CONFLICT','指定商品与被回复消息不一致。');
   }else{
    if(!mid)return stop('needs_clarification','D3_REPLY_REQUIRED','请回复具体分镜或作品消息。');
    picked=expected(reference);
    const possible=byAction(prior,command==='adopt'?['content_confirm']:['content_prepare']);
    if(possible.length!==1||!scopedAction(possible[0],prior))
     return stop('needs_clarification','D3_REPLY_KIND_MISMATCH','请回复对应的准备结果或待采用作品。');
    const a=possible[0];
    if(command==='adopt'){
     if(a.status!=='awaiting_approval'||ordinal!==null)return stop('needs_clarification','D3_EXACT_WORK_REQUIRED','请直接回复待采用的指定作品版。');
     ref=work(a.result?.workRef);
     if(!ref)return stop('failed','D3_WORK_REFERENCE_INVALID','该作品版本不可核对。');
    }else{
     const plans=a.status==='drafts_ready'?planOptions(a.result):null;
     if(!plans)return stop('failed','D3_PLAN_REFERENCE_INVALID','该分镜版本不可核对。');
     ref={draftSetId:plans.draftSetId,draftSetVersion:plans.draftSetVersion};
     if(command==='edit'){
      const p=plans.plans[ordinal-1];
      if(!sameCard(editContext,picked))
       return stop('failed','D3_STALE_OR_WRONG_CARD','当前选件与回复的分镜不一致。');
      if(!p||!Array.isArray(p.shots)||!p.shots[intent.shotOrdinal-1])
       return stop('needs_clarification','D3_CAPTION_EDIT_TARGET_NOT_FOUND','请指定这条分镜里确有的方案和镜头。');
      draft=plans;
      ref={...ref,planId:p.planId,planVersion:p.planVersion};
     }
     if(command==='confirm'){
      // “这个” can refer to a single plan or an independently persisted UI
      // selection. Two presented plans do not silently select the first.
      const selected=ordinal!==null?plans.plans[ordinal-1]:plans.plans.length===1?plans.plans[0]:
       await readPlanSelection?.(ctx,{referenceMessageId:mid,...picked,...ref});
      const p=selected&&plans.plans.find(v=>v.planId===selected.planId&&v.planVersion===selected.planVersion);
      if(!p)return stop('needs_clarification','D3_EXACT_PLAN_REQUIRED','请回复并指定第一或第二套分镜。');
      ref={...ref,planId:p.planId,planVersion:p.planVersion};
     }
    }
   }
   if(!id(picked.productId)||!ver(picked.productVersion))return stop('failed','D3_CARD_INVALID','商品号或版本无效。');
   const current=await catalog.get(ctx,picked.productId);
   if(!current||current.shopId!=null&&current.shopId!==ctx.shopId||
      current.productId!==picked.productId||current.productVersion!==picked.productVersion)
    return stop('failed','D3_STALE_OR_WRONG_CARD','商品版本已变更或不可用，请重新准备。');
   // No raw client content, id, confirmation flag or globally selected item.
   const commandInput={...envelope,...picked,referenceMessageId:mid,...ref};
   await messageLedger.bind(ctx,x,picked,[]);
   if(!sameCard(await messageLedger.read(ctx,x.messageId),picked))throw err('D3_MESSAGE_BIND_FAILED',409);
   if(command==='edit'){
    const selector={...envelope,referenceMessageId:mid};
    const target=await readCaptionEditContext(ctx,selector);
    if(!currentEditContext(ctx,selector,target,captionClock)||!sameCard(target,picked))
     return stop('failed','D3_CAPTION_EDIT_CONTEXT_CHANGED','编辑期间分镜上下文变更；未提交字幕。');
    // No client shot array, plan id, consent, publication or render flag.
    const raw=await editCaption(ctx,Object.freeze({...envelope,...picked,referenceMessageId:mid,
     planOrdinal:ordinal,shotOrdinal:intent.shotOrdinal,caption:intent.caption}));
    const view=captionProjection(commandInput,intent,draft,raw);
    return view??stop('failed','D3_CAPTION_EDIT_RECEIPT_REJECTED','字幕编辑回执未能核实，请查看原分镜，不自动重试。');
   }
   if(D3_PURPOSE[command]){
    const identity=d3Identity(ctx,commandInput,command);
    grant=await authorizeCommand?.(ctx,identity);
    const deny=checkD3Consent(ctx,identity,grant,consentClock());
    if(deny)throw err(deny);
    if(typeof readCurrentTarget!=='function'||typeof withConsent!=='function')throw err('D3_CONSENT_NOT_CONNECTED');
    const targetDeny=checkD3Target(ctx,identity,await readCurrentTarget(ctx,identity));
    if(targetDeny)throw err(targetDeny);
    const last=checkD3Consent(ctx,identity,grant,consentClock());
    if(last)throw err(last);
   }
   const raw=grant?await contentExit[command](ctx,Object.freeze({...commandInput,confirmationId:grant.confirmationId})):
    await contentD3[command](ctx,Object.freeze(commandInput));
   const part=(state,result,status='completed')=>({...envelope,...picked,status,
    actions:[{...envelope,...picked,action:actionFor[command],status:state,result:{...result,deliveryStatus:'not_submitted'}}]});
   if(!raw||!matching(raw,commandInput)||raw.deliveryStatus!=='not_submitted')
    return stop('failed','D3_CONTENT_RECEIPT_REJECTED','内容回执未通过本店本件核验，请查服务端记录。');
   if(blockCodes.has(raw.status)&&raw.taskId==null&&raw.workRef==null)
    return part(raw.status,projectD3CaptionIssue(commandInput,raw)??{},'failed');
   if(command==='prepare'&&raw.status==='drafts_ready'&&raw.taskId==null&&raw.workRef==null&&showDraft(raw))
    return part(raw.status,showDraft(raw));
   if(command==='cancel'&&raw.status==='cancelled'&&raw.taskId==null&&raw.workRef==null&&
      ver(raw.cancelledVersion)&&raw.cancelledVersion>ref.draftSetVersion)
    return part(raw.status,{...ref,cancelledVersion:raw.cancelledVersion});
   if(command==='confirm'&&['queued','awaiting_approval'].includes(raw.status)&&id(raw.taskId)&&
      (raw.status==='queued'?raw.workRef==null:work(raw.workRef))){
    const media=raw.status==='awaiting_approval'?work(raw.workRef):null;
    const previewUrl=media?projectD3Preview(commandInput,raw,media):null;
    return part(raw.status,{...ref,taskId:raw.taskId,...(media?{workRef:media}:{}) ,...(previewUrl?{previewUrl}:{})});
   }
   if(command==='adopt'&&raw.status==='adopted'&&raw.taskId==null&&matching(work(raw.workRef),ref)){
    const previewUrl=projectD3Preview(commandInput,raw,ref);
    return part(raw.status,{workRef:ref,...(previewUrl?{previewUrl}:{})});
   }
   return stop('failed','D3_CONTENT_RECEIPT_REJECTED','未获得符合约定的内容回执。');
  }catch(e){
   if(knownErrors[e?.code])return stop('failed',knownErrors[e.code].toUpperCase(),'素材、版本或确认状态已变化，请核对。');
   if(e?.httpStatus===403)throw e;
   if(isD3ConsentError(e?.code))return stop('failed',e.code,'本次确认未通过时间、权限或版本核验；未继续提交。');
   return stop('failed','D3_SOURCE_UNAVAILABLE','内容服务未完成；请查看原操作回执，不自动重试。');
  }
 };
}
