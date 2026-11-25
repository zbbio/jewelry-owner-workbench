const card=['shopId','productId','productVersion'];
const op=['requestId','messageId','referenceMessageId',...card];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const pos=x=>Number.isSafeInteger(x)&&x>0;
const same=(a,b,keys)=>!!a&&!!b&&keys.every(k=>a[k]===b[k]);
const take=(q,keys)=>Object.fromEntries(keys.map(k=>[k,q[k]]));
const err=(code,httpStatus)=>Object.assign(new Error(code),{code,httpStatus});

export function createD3CaptionEditor({contentD3}={}){
  if(typeof contentD3?.restore!=='function'||typeof contentD3?.edit!=='function')
    throw err('D3_CAPTION_EDITOR_NOT_CONNECTED',503);
  return function editCaption(ctx,input){
    if(!input||!op.filter(k=>k!=='productVersion').every(k=>id(input[k]))||
       !pos(input.productVersion)||!pos(input.planOrdinal)||!pos(input.shotOrdinal)||
       typeof input.caption!=='string'||input.messageId===input.referenceMessageId)
      throw err('D3_CAPTION_EDIT_INPUT_INVALID',400);
    if(ctx?.role!=='owner'||ctx.shopId!==input.shopId)throw err('D3_STORE_NOT_ENABLED',403);
    const args=take(input,op);
    const denied=(status,code)=>({...args,status,code,deliveryStatus:'not_submitted'});
    let prior;
    try{prior=contentD3.restore(ctx,{messageId:input.referenceMessageId});}
    catch(e){
      if(e.code==='D3_PRODUCT_VERSION_CHANGED')return denied('stale_version',e.code);
      if(e.code==='D3_RESULT_NOT_AVAILABLE')return denied('needs_review','D3_CAPTION_EDIT_REFERENCE_REQUIRED');
      throw e;
    }
    if(!same(prior,args,card)||prior?.messageId!==input.referenceMessageId||
       prior.status!=='drafts_ready'||!id(prior.draftSetId)||!pos(prior.draftSetVersion))
      return denied('needs_review','D3_CAPTION_EDIT_REFERENCE_REQUIRED');
    // Ordinals refer to this message's exact displayed ordering, not to
    // the most recent plan or a browser-supplied replacement list.
    const plan=Array.isArray(prior.plans)?prior.plans[input.planOrdinal-1]:null;
    if(!id(plan?.planId)||!pos(plan.planVersion)||!Array.isArray(plan.shots)||!plan.shots[input.shotOrdinal-1])
      return denied('needs_review','D3_CAPTION_EDIT_TARGET_NOT_FOUND');
    const base=take(prior,['draftSetId','draftSetVersion']);
    const selected=take(plan,['planId','planVersion']);
    const shots=plan.shots.map((s,i)=>({
      ...take(s,['assetId','durationMs','caption']),
      ...(i===input.shotOrdinal-1?{caption:input.caption}:{}),
    }));
    // No extra preflight before edit: the real D3 write owns the active-version
    // check, caption policy/failure receipt, and same-message idempotency.
    const receipt=contentD3.edit(ctx,{...args,...base,...selected,shots});
    return {...receipt,editTarget:{referenceMessageId:args.referenceMessageId,...base,...selected,
      planOrdinal:input.planOrdinal,shotOrdinal:input.shotOrdinal}};
  };
}
