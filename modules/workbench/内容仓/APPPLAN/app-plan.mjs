/** C2 candidate: no transport, renderer, media permissions or production ports. */
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0;
const equalCard=(x,y)=>x?.shopId===y.shopId&&x.productId===y.productId&&x.productVersion===y.productVersion;
const MISSING=Object.freeze(['this_card_authorized_assets','confirmed_copy','this_plan_purpose']);
const CAP=n=>Object.freeze({mode:n,prepare:true,production:false});
const kinds=new Set(['prepare','edit','cancel','confirm','adopt']);
// Only exact, stand-alone denials of *read* operations can be ignored by the
// existing D3 parser. Positive or ambiguous added clauses still fail closed.
const optOut=/^(?:(?:先)?(?:别|不(?:要|用|必|想)?|无需|无须)(?:再)?\s*(?:问|查|报|说|讲|看)(?:本件(?:的)?)?(?:售价|价格|报价|价)|(?:先)?(?:别|不(?:要|用|必|想)?|无需|无须)(?:再)?\s*(?:看|找|查|找回|播放|取回)(?:本件(?:的)?)?(?:旧片|原片|旧视频|原视频)|(?:售价|价格)(?:先)?(?:不用|别)(?:讲|说|报)|(?:旧片|原片|旧视频|原视频)(?:先)?(?:不用|别)(?:看|找|查))(?:了)?$/u;
export function readPlanIntent(text,parseD3){
 if(typeof text!=='string'||typeof parseD3!=='function')return null;
 const original=text.normalize('NFKC').trim();
 const direct=parseD3(original);
 if(!direct||!kinds.has(direct.command))return null;
 if(direct.command!=='prepare')return {...direct,text:original};
 const filtered=original.split(/[，,；;\n。！？!?]+/u).map(s=>s.trim()).filter(s=>s&&!optOut.test(s)).join('，');
 const clean=parseD3(filtered);
 return clean?.command==='prepare'?{...clean,text:filtered}:{...direct,invalid:true,text:original};
}
function base(ctx,x){return {shopId:ctx.shopId,requestId:x.requestId,messageId:x.messageId};}
function stop(meta,status,code,message){return {...meta,status,code,message,actions:[]};}
const clarify=(m,code='D3_PRODUCT_REQUIRED')=>stop(m,'needs_clarification',code,
 code==='D3_REFERENCE_CARD_CONFLICT'?'你说的商品和回复的那条不是同一件。请明确哪件；未准备或制作。':'要给哪件商品准备？请说货号，或回复那件商品的消息。');
const ambiguous=m=>stop(m,'needs_clarification','D3_COMMAND_AMBIGUOUS','请将准备分镜和其他操作分开发；本次没有生成视频。');
const readFailure=m=>stop(m,'failed','D3_PRODUCT_SOURCE_UNAVAILABLE','当前商品资料读不到，请稍后再核。没有准备或制作。');
function blocked(meta,pin,code){
 const a={...meta,...pin,action:'content_prepare',status:'needs_review',result:{code,mode:'read_only_preflight',
  unverified:[...MISSING],nextStep:'isolated_practice',productionAuthorized:false,deliveryStatus:'not_submitted'}};
 return {...meta,...pin,status:'failed',actions:[a]};
}
// Original store: only catalogue selector and ordinary message locator. No
// album bytes, grant lookup/signer, C2 mutation, sales or C3 can be called.
export function createAppPlanPreflight({product,catalog,messages,parseD3}={}){
 if(typeof product?.resolve!=='function'||typeof catalog?.get!=='function'||typeof messages?.reference!=='function'||
    typeof messages?.setProduct!=='function'||typeof parseD3!=='function')throw new TypeError('APPPLAN_READ_PORTS_REQUIRED');
 return Object.freeze({capability:CAP('read_only_preflight'),async turn(ctx,x){
  const i=readPlanIntent(x?.text,parseD3);
  if(i?.command!=='prepare')return null;
  const m=base(ctx,x);
  if(i.invalid||x.batchId!==undefined)return ambiguous(m);
  if(ctx.role!=='owner'||!id(ctx.sessionId)||!id(ctx.shopId))return stop(m,'failed','D3_STORE_NOT_ENABLED','此会话没有内容准备入口。');
  try{
   const mid=x.replyToMessageId??null, r=mid?messages.reference(ctx,mid):null;
   if(mid&&(!r||r.shopId!==ctx.shopId))return clarify(m,'D3_REFERENCE_CARD_CONFLICT');
   const p=await product.resolve(ctx,{requestId:x.requestId,messageId:x.messageId,text:i.text,reference:mid,intent:'detail'});
   if((p?.storeId??p?.shopId)!==ctx.shopId||p.requestId!==x.requestId||p.messageId!==x.messageId)return readFailure(m);
   if(p.status==='source_unavailable')return readFailure(m);
   if(p.status==='version_conflict')return clarify(m,'D3_REFERENCE_CARD_CONFLICT');
   if(p.status!=='matched'||p.total!==1||p.cards?.length!==1)return clarify(m);
   const q=p.cards[0],pin={shopId:ctx.shopId,productId:q.productId,productVersion:q.productVersion};
   if(!id(pin.productId)||!ver(pin.productVersion)||(r&&!equalCard(r,pin)))return clarify(m,'D3_REFERENCE_CARD_CONFLICT');
   const curr=await catalog.get(ctx,pin.productId);
   if(!curr||curr.productId!==pin.productId||curr.productVersion!==pin.productVersion||
      (curr.shopId!==undefined&&curr.shopId!==ctx.shopId))return readFailure(m);
   messages.setProduct(ctx,x.messageId,pin,false);
   return blocked(m,pin,'APPPLAN_INPUTS_REQUIRED');
  }catch{return readFailure(m);}
 }});
}
// Practice is explicitly injected *by product*. Compose above the already
// approved CARD2PLAN/PLANGRANT ordinary D3 adapter, not above a render route.
// D2/P3 and grant confirmations are left to their existing ordinary handlers.
export function createAppPlanPractice({isPracticeOwner,planTurn,parseD3}={}){
 if(typeof isPracticeOwner!=='function'||typeof planTurn!=='function'||typeof parseD3!=='function')
  throw new TypeError('APPPLAN_PRODUCT_PRACTICE_PORTS_REQUIRED');
 return Object.freeze({capability:CAP('isolated_prepare_edit_only'),async turn(ctx,x){
  const i=readPlanIntent(x?.text,parseD3);
  if(!i)return null;
  const m=base(ctx,x);
  if(ctx.role!=='owner'||!id(ctx.shopId)||!id(ctx.sessionId)||await isPracticeOwner(ctx)!==true)
   return stop(m,'failed','D3_STORE_NOT_ENABLED','当前没有获准的独立练习身份；没有准备或制作。');
  if(i.invalid)return ambiguous(m);
  if(i.command==='confirm'||i.command==='adopt')
   return stop(m,'failed','D3_CARDPAGE_PREPARATION_ONLY','本练习只准备或编辑分镜，没有开启制作、采用或发布。');
  // Use the original program's same-message adapter. Retain original message
  // IDs and reference; only remove exact explicit negations of read actions.
  if(!['prepare','edit','cancel'].includes(i.command))return null;
  const v=await planTurn(ctx,{...x,text:i.text});
  if(!v||v.shopId!==m.shopId||v.requestId!==m.requestId||v.messageId!==m.messageId||
     !Array.isArray(v.actions)||v.actions.some(a=>!['content_prepare','content_cancel'].includes(a?.action)||a.taskId!=null||
       a.workRef!=null||a.previewUrl!=null||a.result?.taskId!=null||a.result?.workRef!=null||a.result?.previewUrl!=null))
   return stop(m,'failed','APPPLAN_PRACTICE_RECEIPT_REJECTED','练习分镜回执待核；没有提供播放或制作操作。');
  if(v.actions.some(a=>a.status==='drafts_ready'&&(!Array.isArray(a.result?.plans)||a.result.plans.length!==2)))
   return stop(m,'failed','APPPLAN_PRACTICE_RECEIPT_REJECTED','未收到两套核准分镜；请核对练习入口。');
  return {...v,appPlanMode:'isolated_prepare_edit_only'};
 }});
}
