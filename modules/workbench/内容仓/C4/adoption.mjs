const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0;
const must=(p,code)=>{if(!p)throw Object.assign(new Error(code),{code});};

// C4 does not publish. Adoption is not inferred from preview or production.
export function createAdoption({studio,getProductVersion,authorizeAdoption,readWorkPlanProof}){
 must(typeof readWorkPlanProof==='function','C4_WORK_SOURCE_READER_REQUIRED');
 function bound(ctx,x,requireOwner){
   must(id(ctx?.shopId)&&id(ctx?.actorId)&&(!requireOwner||ctx.role==='owner'),'C4_SCOPE_DENIED');
   must(id(x?.productId)&&ver(x.productVersion)&&id(x.workId)&&ver(x.workVersion),'C4_PIN_REQUIRED');
   must(getProductVersion(ctx,x.productId)===x.productVersion,'C4_PRODUCT_VERSION_CHANGED');
 }
 function proof(ctx,x){
   const r=readWorkPlanProof(ctx,x);
   must(r,'WORK_NOT_AVAILABLE');
   must(r.productId===x.productId&&r.productVersion===x.productVersion&&r.workId===x.workId&&r.workVersion===x.workVersion&&
     /^[a-f0-9]{64}$/.test(r.assetPinsDigest??'')&&/^[a-f0-9]{64}$/.test(r.sha256??''),'C4_WORK_SOURCE_UNVERIFIED');
   return r;
 }
 function preview(ctx,x){
   bound(ctx,x,true);
   const boundWork=proof(ctx,x);
   const data=studio.openPreview(ctx,x);
   must(data.productId===x.productId&&data.workId===x.workId&&data.workVersion===x.workVersion&&
     data.mime==='video/mp4'&&Buffer.isBuffer(data.bytes)&&data.bytes.length>0&&data.sha256===boundWork.sha256,'C4_PREVIEW_UNAVAILABLE');
   return {...data,productVersion:x.productVersion,deliveryStatus:'not_submitted'};
 }
 function adopt(ctx,x){
   bound(ctx,x,true);must(id(x.requestId)&&id(x.confirmationId),'C4_EXACT_ADOPTION_REQUIRED');
   const a=authorizeAdoption(ctx,x.confirmationId);
   must(a&&a.active===true&&a.purpose==='adopt_selected_work'&&a.shopId===ctx.shopId&&a.actorId===ctx.actorId&&
     a.productId===x.productId&&a.productVersion===x.productVersion&&a.workId===x.workId&&a.workVersion===x.workVersion&&
     a.requestId===x.requestId,'C4_ADOPTION_NOT_CONFIRMED');
   const boundWork=proof(ctx,x);
   const row=studio.approve(ctx,{requestId:x.requestId,productId:x.productId,workId:x.workId,workVersion:x.workVersion});
   must(row.status==='approved'&&row.productVersion===x.productVersion&&row.workId===x.workId&&row.workVersion===x.workVersion&&
     row.sha256===boundWork.sha256&&row.assetPinsDigest===boundWork.assetPinsDigest,
     'C4_ADOPTION_RESULT_MISMATCH');
   return {productId:x.productId,productVersion:x.productVersion,requestId:x.requestId,status:'adopted',
     workRef:{workId:row.workId,workVersion:row.workVersion},sha256:row.sha256,deliveryStatus:'not_submitted'};
 }
 function reopen(ctx,x){
   bound(ctx,x,false);
   const boundWork=proof(ctx,x);
   const m=studio.openOldVideo(ctx,{productId:x.productId,productVersion:x.productVersion,workId:x.workId,workVersion:x.workVersion});
   must(m.productId===x.productId&&m.productVersion===x.productVersion&&m.workId===x.workId&&m.workVersion===x.workVersion&&
     m.sha256===boundWork.sha256,'C4_REOPEN_MISMATCH');
   return {...m,deliveryStatus:'not_submitted'};
 }
 return {preview,adopt,reopen};
}
