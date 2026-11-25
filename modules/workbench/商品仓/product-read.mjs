import {projectLabel,labelBasis} from './G1HANDOFF/p2-authority.mjs';
const has=(x,k)=>x!=null&&Object.hasOwn(x,k);
const id=x=>typeof x==='string'&&/^[\w.:-]{1,128}$/u.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const thumbnail=(x,b,a)=>typeof x==='string'&&x==='/api/n22/album/batches/'+b+'/assets/'+a;
const clean=x=>typeof x==='string'?x.normalize('NFKC').trim():'';
const CATEGORY={
  bracelet:['手串','珠串','佛珠'],bangle:['手镯','镯子','圆镯'],pendant:['吊坠','坠子','挂坠'],
  necklace:['项链','锁骨链'],hand_chain:['手链'],ring:['戒指','指环'],earring:['耳环','耳饰','耳钉'],
};
const colorWords={白色:['白色','白'],绿色:['绿色','绿'],红色:['红色','红'],蓝色:['蓝色','蓝'],黑色:['黑色','黑'],紫色:['紫色','紫'],黄色:['黄色','黄']};
const category=x=>Object.entries(CATEGORY).find(([key,labels])=>key===clean(x)||labels.includes(clean(x)))?.[0]??null;
const wordPattern=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const known=(text,token)=>new RegExp('(?<![a-z0-9_-])'+wordPattern(token)+'(?![a-z0-9_-])','iu').test(text);
const error=(code,httpStatus=400)=>Object.assign(new Error(code),{code,httpStatus});
const scopes=ctx=>{if(!id(ctx?.shopId)||!id(ctx?.actorId))throw error('SESSION_REQUIRED',401);};
const validate=(request,extra=[])=>{
  if(!request||typeof request!=='object'||Array.isArray(request)||
     !id(request.requestId)||!id(request.messageId)||
     Object.keys(request).some(k=>!['requestId','messageId',...extra].includes(k)))throw error('INVALID_REQUEST');
};
const validFact=x=>x&&['manual','imported'].includes(x.source)&&x.value!==null&&x.value!==undefined;
const fact=(fields,...keys)=>{const rows=keys.map(field=>({field,value:fields?.[field]})).filter(x=>validFact(x.value));
  const hit=rows.find(x=>x.value.source==='manual')??rows[0],f=hit?.value;if(!f)return null;
  if(typeof f.value!=='string'&&typeof f.value!=='number')return null;
  return {field:hit.field,value:f.value,source:f.source,...(typeof f.unit==='string'?{unit:f.unit}:{}),...(id(f.evidenceRef)?{evidenceRef:f.evidenceRef}:{})};};
export function recordedSalePrice(fields){
  const entries=['retailPrice','salePrice','price'].map(field=>({field,f:fields?.[field]}))
    .filter(({f})=>validFact(f)&&['元','人民币','人民币元','CNY','RMB'].includes(f.unit)&&
      ['string','number'].includes(typeof f.value)&&/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(String(f.value)));
  if(!entries.length||!entries.every(x=>Number(x.f.value)===Number(entries[0].f.value)))return null;
  const {field,f}=entries[0];
  return {amount:Number(f.value).toFixed(2),currency:'CNY',field,source:f.source};
}
const cardFields=s=>{
  const f=s.fields,p=recordedSalePrice(f),dimension=fact(f,'size'),k=fact(f,'category','productType');
  return {productId:s.productId,productVersion:s.productVersion,
    priceYuan:p?.amount??null,priceStatus:p?'recorded':['retailPrice','salePrice','price'].some(k=>f?.[k]?.value!=null)?'needs_review':'unfilled',priceSource:p?.source??null,
    priceField:p?.field??null,
    size:dimension?.source==='manual'&&dimension.unit?dimension:null,
    category:category(k?.value),categorySource:category(k?.value)?k.source:null,
    color:fact(f,'color'),stockStatus:s.inventory?.status??'unknown',
    assetRefs:(s.assetRefs??s.assetIds??[]).map(a=>typeof a==='string'?{assetId:a}
      : {assetId:a.assetId,...(typeof a.decisionSource==='string'?{decisionSource:a.decisionSource}:{}),
        ...(id(a.groupId)&&Number.isSafeInteger(a.groupVersion)?{groupId:a.groupId,groupVersion:a.groupVersion}:{}),
        ...(digest(a.sha256)?{sha256:a.sha256}:{})}),
    source:{system:'catalog',productId:s.productId,productVersion:s.productVersion}};
};
async function provider(fn,...args){if(typeof fn!=='function')return {status:'unavailable'};
  try{const value=await fn(...args);return {status:'ok',value};}catch{return {status:'unavailable'};}}
const totals=()=>({catalogCreated:0,catalogUpdated:0,cardAssetLinksAdded:0});
const summary=(request,ctx)=>({requestId:request.requestId,messageId:request.messageId,storeId:ctx.shopId,effects:totals()});
function evidence(x,ctx,batchId,a,kind){
  if(!x||x.shopId!==ctx.shopId||x.assetId!==a.assetId||x.batchId!==batchId||!digest(a.sha256)||
     x.sha256!==a.sha256||!id(x.evidenceRef))return null;
  if(kind==='pixel_rule'){
    if(x.analysisKind!=='pixel_rule'||!id(x.ruleId)||!id(x.ruleVersion)||typeof x.decoded!=='boolean'||
       !['heuristic_strong','insufficient'].includes(x.confidence)||
       typeof x.reason!=='string'||!/^PIXEL_[A-Z_]{1,64}$/u.test(x.reason))return null;
    const k=x.decoded&&x.confidence==='heuristic_strong'?category(x.category):null;
    return {source:kind,category:k,evidenceRef:x.evidenceRef,ruleId:x.ruleId,ruleVersion:x.ruleVersion,
      confidence:k?'heuristic_strong':'insufficient',reason:x.reason,decoded:x.decoded,
      ...(id(x.runtime)?{runtime:x.runtime}:{}),features:x.features??{}};
  }
  if(kind==='image_inference'&&x.analysisKind==='reference_embedding'){
    if(!id(x.modelId)||!id(x.modelVersion)||!id(x.referenceVersion)||typeof x.readImage!=='boolean'||
       typeof x.reason!=='string'||!(/^[A-Z_]{1,64}$/u.test(x.reason)))return null;
    const k=x.readImage&&x.status==='suggested'?category(x.category):null;
    return {source:kind,category:k,evidenceRef:x.evidenceRef,modelId:x.modelId,modelVersion:x.modelVersion,
      referenceVersion:x.referenceVersion,readImage:x.readImage,reason:x.reason,
      ...(Number.isFinite(x.score)?{score:x.score}:{}),...(Number.isFinite(x.margin)?{margin:x.margin}:{})};
  }
  if(!category(x.category))return null;
  if(kind==='original_label'&&x.matched!==true||
     kind==='image_inference'&&(x.readImage!==true||!id(x.modelId)||!id(x.modelVersion))||
     kind==='human'&&x.confirmed!==true)return null;
  return {source:kind,category:category(x.category),evidenceRef:x.evidenceRef,
    ...(kind==='image_inference'?{modelId:x.modelId,modelVersion:x.modelVersion}:{}),
    ...(kind==='original_label'&&id(x.sourceVersion)?{sourceVersion:x.sourceVersion}:{}),
    ...(kind==='human'&&Number.isInteger(x.reviewVersion)&&x.reviewVersion>0?
      {reviewVersion:x.reviewVersion,previousCategory:category(x.previousCategory)}:{})};
}

export function createProductRead({catalog,aliases=()=>({}),readReference,readAuthorizedBatch,readLabel,readLabelStatus,readVision,readHuman,authorizeP2Asset,verifyDuplicate,channelRead}={}){
  if(typeof catalog?.list!=='function'||typeof catalog?.getSummary!=='function')throw new TypeError('catalog read ports required');
  async function resolve(ctx,req){
    scopes(ctx);validate(req,['text','reference','intent']);
    if(typeof req.text!=='string'||!clean(req.text)||req.text.length>750||
       (has(req,'reference')&&req.reference!==null&&!id(req.reference))||
       (has(req,'intent')&&!['search','detail'].includes(req.intent)))throw error('INVALID_REQUEST');
    const base=summary(req,ctx),text=clean(req.text),respond=(status,more={})=>({...base,status,...more});
    // Negated object clauses do not become positive matches. Never inspect session's old selected card.
    const clauses=text.split(/[，,。；;！!？?]/u).filter(p=>!/^(?:先)?(?:不查|别查|不要查|不用查|别找|不要找)/u.test(p.trim()));
    const query=clauses.join(' ');
    const explicit=[...query.matchAll(/(?:货号|商品号|卡号|SKU)\s*[:：#]?\s*([a-z0-9][a-z0-9_.-]{0,127})/giu)].map(x=>x[1].toUpperCase());
    const name=Object.entries(CATEGORY).filter(([,names])=>names.some(n=>query.includes(n))).map(([k])=>k);
    const color=Object.entries(colorWords).filter(([,names])=>names.some(n=>name.length&&(n.length>1?query.includes(n):new RegExp(n+'(?:色)?(?:的)?(?:手串|珠串|佛珠|手镯|吊坠|项链|手链|戒指|耳饰)','u').test(query)))).map(([k])=>k);
    const ref=has(req,'reference')?req.reference:null;
    if(!query&&!ref)return respond('unsupported',{reason:'NO_POSITIVE_OBJECT'});
    let rows,map;
    try{rows=catalog.list(ctx);map=aliases(ctx);}catch{return respond('source_unavailable',{reason:'CATALOG_READ_FAILED'});}
    const index=rows.map(x=>{
      const f=x.fields;
      const keys=[x.productId,map?.[x.productId],fact(f,'sku','itemCode','labelCode')?.value];
      return {x,keys:keys.filter(k=>typeof k==='string'&&k.length>0)};
    });
    const matched=index.filter(o=>o.keys.some(k=>explicit.length?explicit.includes(k.toUpperCase()):known(query,k)));
    const exactNames=explicit.length||matched.length;
    let candidate=matched,refHit=null;
    if(!exactNames&&ref){
      const take=await provider(readReference,ctx,ref);
      const x=take.value;
      if(take.status!=='ok'||!x||x.shopId!==ctx.shopId||!id(x.productId)||!Number.isSafeInteger(x.productVersion))
        return respond('needs_clarification',{reason:'REFERENCE_NOT_VERIFIED'});
      refHit=x;candidate=index.filter(o=>o.x.productId===x.productId);
      if(candidate[0]&&candidate[0].x.productVersion!==x.productVersion)return respond('version_conflict',{reason:'REFERENCE_VERSION_STALE'});
    }else if(!exactNames&&(name.length||color.length)){
      candidate=index.filter(o=>{
        const c=category(fact(o.x.fields,'category','productType')?.value),f=clean(fact(o.x.fields,'color')?.value);
        return (!name.length||name.includes(c))&&(!color.length||color.some(k=>colorWords[k].includes(f)));
      });
    }else if(!exactNames)return respond('needs_clarification',{reason:'NO_VERIFIED_OBJECT'});
    if(!candidate.length)return respond('not_found',{reason:refHit?'REFERENCED_CARD_NOT_FOUND':'NO_LOCAL_MATCH'});
    let cards;
    try{cards=candidate.slice(0,20).map(({x})=>{const s=catalog.getSummary(ctx,x.productId);
       if(!s||s.productVersion!==x.productVersion)throw error('CATALOG_CHANGED',409);
       return {...cardFields(s),alias:map?.[x.productId]??null};});}
    catch(e){return respond(e.code==='CATALOG_CHANGED'?'version_conflict':'source_unavailable',{reason:e.code==='CATALOG_CHANGED'?'CATALOG_CHANGED':'CATALOG_READ_FAILED'});}
    return respond(cards.length===1?'matched':'multiple',{reason:exactNames?'EXPLICIT_ID':refHit?'SESSION_REFERENCE':'VERIFIED_FIELDS',
      total:candidate.length,cards});
  }
  async function classify(ctx,req){
    scopes(ctx);validate(req,['batchId']);
    if(!id(req.batchId))throw error('INVALID_REQUEST');
    const base={...summary(req,ctx),batchId:req.batchId};
    const v=await provider(readAuthorizedBatch,ctx,req.batchId),batch=v.value;
    if(v.status!=='ok')return {...base,status:'source_unavailable',reason:'BATCH_SOURCE_UNAVAILABLE',items:[]};
    if(!batch||batch.shopId!==ctx.shopId||batch.batchId!==req.batchId)return {...base,status:'not_found',reason:'BATCH_NOT_IN_SCOPE',items:[]};
    if(!Array.isArray(batch.assets)||batch.assets.length>500||batch.assets.some(a=>!a||!id(a.itemId??a.assetId)||
        a.status==='kept'&&!id(a.assetId)||!['kept','duplicate','unreadable','not_authorized'].includes(a.status))||
        new Set(batch.assets.map(a=>a.itemId??a.assetId)).size!==batch.assets.length)
      return {...base,status:'source_unavailable',reason:'BATCH_SOURCE_INVALID',items:[]};
    const kept=new Map(batch.assets.filter(x=>x.status==='kept').map(x=>[x.assetId,x]));
    const items=[];
    for(const a of batch.assets){
      const item={itemId:a.itemId??a.assetId,assetId:a.assetId??null,category:null,source:null};
      if(a.status==='duplicate'){
        const valid=id(a.duplicateOf)&&digest(a.sha256)&&(kept.get(a.duplicateOf)?.sha256===a.sha256||
          (await provider(verifyDuplicate,ctx,{batchId:req.batchId,assetId:a.duplicateOf,sha256:a.sha256})).value===true);
        if(!valid)
          items.push({...item,status:'pending',reason:'DUPLICATE_LINK_UNVERIFIED'});
        else items.push({...item,status:'duplicate',duplicateOf:a.duplicateOf,reason:'EXACT_BYTES'});
        continue;
      }
      if(a.status!=='kept'){items.push({...item,status:a.status});continue;}
      const asset={batchId:req.batchId,assetId:a.assetId,sha256:a.sha256};
      const denied=()=>({itemId:a.itemId??a.assetId,assetId:null,category:null,source:null,status:'not_authorized',reason:'ASSET_READ_NOT_AUTHORIZED'});
      const mayRead=async()=>!authorizeP2Asset||(await provider(authorizeP2Asset,ctx,asset)).value===true;
      if(!await mayRead()){items.push(denied());continue;}
      const marker=(await provider(readLabel,ctx,asset)).value;
      const source=(await provider(readLabelStatus,ctx)).value;
      const original=projectLabel(ctx,asset,marker,source,category),label=original.evidence;
      const basis=labelBasis(original);
      const h=await provider(readHuman,ctx,asset,basis);
      const human=evidence(h.value,ctx,req.batchId,a,'human');
      // Pixels remain separate evidence: they cannot settle a conflicted/withdrawn original label.
      const w=await provider(readVision,ctx,asset);
      if(!await mayRead()){items.push(denied());continue;}
      const pixel=evidence(w.value,ctx,req.batchId,a,'pixel_rule');
      const vision=pixel?null:evidence(w.value,ctx,req.batchId,a,'image_inference');
      const candidate=vision?.category?vision:pixel?.category?pixel:null;
      const parts={originalLabel:label,imageInference:vision,pixelRule:pixel,humanCorrection:human};
      const conflict=label&&candidate&&label.category!==candidate.category;
      const restricted=['blocked','unavailable'].includes(original.status.status);
      const prior=h.value?.status==='needs_reconfirmation'&&h.value.shopId===ctx.shopId&&
        h.value.batchId===req.batchId&&h.value.assetId===a.assetId&&h.value.sha256===a.sha256&&
        Number.isSafeInteger(h.value.reviewVersion)&&h.value.reviewVersion>0;
      const picked=human??(restricted||prior||conflict?null:label??candidate);
      items.push({...item,status:picked?(['image_inference','pixel_rule'].includes(picked.source)?'suggested':'classified'):'pending',
        category:picked?.category??null,source:picked?.source??null,...(picked?{evidenceRef:picked.evidenceRef}:{}),
        reason:human?'HUMAN_CONFIRMED':restricted?original.status.reason:prior?'HUMAN_RECONFIRMATION_REQUIRED':conflict?'EVIDENCE_DISAGREES':picked?.source==='pixel_rule'?pixel.reason:
          picked?.source==='image_inference'&&vision?.reason?vision.reason:
          picked?'EVIDENCE_LINKED':pixel?.reason??vision?.reason??'NO_VERIFIED_CATEGORY',
        ...(thumbnail(a.thumbnailRef,req.batchId,a.assetId)?{thumbnailRef:a.thumbnailRef}:{}),evidence:parts,
        ...(original.status.status!=='not_configured'?{originalLabelStatus:original.status}:{}),
        ...(authorizeP2Asset?{assetSha256:a.sha256,originalLabelBasis:basis}:{}),
        ...(prior?{humanReviewStatus:{status:'needs_reconfirmation',reviewVersion:h.value.reviewVersion}}:{})});
    }
    const counts={classified:0,suggested:0,pending:0,duplicate:0,unreadable:0,not_authorized:0};
    for(const i of items)counts[i.status]++;
    const provenanceCounts={visualSuggested:0,effectiveSuggestions:counts.suggested,
      originalLabelMatched:0,humanConfirmed:0,humanChanged:0,humanFilledPending:0};
    for(const i of items){
      const e=i.evidence;
      if(e?.imageInference?.category||e?.pixelRule?.category)provenanceCounts.visualSuggested++;
      if(e?.originalLabel?.category)provenanceCounts.originalLabelMatched++;
      if(i.source==='human'){
        provenanceCounts.humanConfirmed++;
        const h=e.humanCorrection;
        if(h.reviewVersion&&h.previousCategory===null)provenanceCounts.humanFilledPending++;
        if(h.previousCategory&&h.previousCategory!==h.category)provenanceCounts.humanChanged++;
      }
    }
    return {...base,status:'classified_read_only',...(id(batch.messageId)?{batchOriginMessageId:batch.messageId}:{}),items,counts,provenanceCounts};
  }
  // Explicit, separate DTO. Sales/local facts keep using resolve and the catalog, never the channel payload.
  const readChannelOffers=channelRead?((ctx,req)=>{scopes(ctx);return channelRead.read(ctx,req);}):undefined;
  return Object.freeze({resolve,classify,...(readChannelOffers?{readChannelOffers}:{})});
}
