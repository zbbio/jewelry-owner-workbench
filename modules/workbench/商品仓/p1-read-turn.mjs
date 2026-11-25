import {actionsOf} from './local-read-intent.mjs';
const id=x=>typeof x==='string'&&/^[\w.:-]{1,128}$/u.test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0;
const catWords='手串|珠串|佛珠|手镯|镯子|吊坠|坠子|项链|手链|戒指|指环|耳饰|耳环|耳钉';
const colors='白色|黑色|红色|绿色|蓝色|紫色|黄色|白|黑|红|绿|蓝|紫|黄';
const itemSearch=new RegExp('^(?:请\\s*)?(?:(?:帮我|给我)\\s*)?(?:查找|找|搜索|搜|查|看看|看)\\s*(?:(?:[一两二三四五六七八九十]|[0-9]{1,2})\\s*(?:个|条|件|款)\\s*)?(?:'+colors+')?\\s*(?:的)?(?:'+catWords+')(?:\\s*(?:有哪几件|都有哪几件|有哪些))?$','u');
const categoryMention=new RegExp(catWords,'u');
const sku=/(?:货号|商品号|卡号|SKU)\s*[:：#]?\s*[a-z0-9][a-z0-9_.:-]{0,127}/iu;
const details=/商品资料|资料|商品卡|卡片信息|商品详情|卡片详情|详情|是什么材质|什么材质|材质(?:是什么|呢)|珠径是多少|什么颜色|尺寸是多少/u;
const wantedMaterial=/是什么材质|什么材质|材质是什么|查(?:看|询)?(?:本件|这件)?材质/u;
const positiveVerb=/^(?:请\s*)?(?:(?:帮我|给我|只想|只要|只)\s*)?(?:查询|查看|查找|查|看(?:看)?|找|搜(?:索)?|核对|读|列)/u;
const deictic=/(?:这(?:一)?[件条款个]|本[件条款]|刚建的这件)/u;
const comparison=/预算|\d+(?:\.\d+)?\s*元(?:以内|内|以下)/u;
const controls=/(?:库存|有货|现货|没货|售罄|待办|给顾客|拟回复|客服|店规|优惠|保养|鉴定|撤回|更正|改(?:价|为|成|尺寸)|修改|更新|补图|补卡|建档|建卡|分镜|字幕|归组|分组|分类|上传|发给|发布|制作|确认|采用)/u;
const noRead=/^(?:先\s*)?(?:不(?:要|用|必|需要|想)?|别|无需|无须)\s*(?:再\s*)?(?:(?:查找|寻找|查询|查看|看|找|查|问|报|提|播放|要)\s*)?(?:(?:报价|售价|价格|价钱|价|多少钱|视频|旧片|旧视频|原片|原视频|短片|片子)(?:\s*(?:和|与|或|及|、)\s*(?:报价|售价|价格|价|视频|旧片|原片|短片))*)\s*(?:了)?$/u;
const stopQuery=/^(?:先\s*)?(?:不(?:要|用|必|需要|想)?|别|无需|无须)\s*(?:再\s*)?(?:查|看|找|搜|读)/u;
const clean=s=>s.normalize('NFKC').trim();
const missing='请说货号，或明确回复本店本会话的那条商品资料。';
const listOrdinal=/^(?:(?:请|帮我|我想|想)\s*)?(?:(?:查(?:看|询)?|看(?:看)?|选|要)\s*)?(?:(?:上一条|上条|上一次|上次)(?:搜索|查询|查找|商品资料)?(?:结果|列表|清单)|刚才(?:那条|的)?(?:结果|列表|清单)|这条(?:结果|列表|清单)|这(?:份|张)(?:列表|清单))(?:里|中|内)?的?\s*第\s*([一二两三四五六七八九十]{1,3}|[0-9]{1,3})\s*(?:件|条|个|款)(?:的?\s*(?:商品资料|资料|商品详情|详情))?\s*[。！？!?]?$/u;
const ordinalMention=/第\s*(?:[一二两三四五六七八九十]{1,3}|[0-9]{1,3})\s*(?:件|条|个|款)/u;
const cn='一二三四五六七八九';
function readOrdinal(raw){
 if(/^\d{1,3}$/u.test(raw))return Number(raw);
 const n=raw.replaceAll('两','二');
 if(n.length===1)return n==='十'?10:cn.indexOf(n)+1;
 const p=/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(n);
 return p?(p[1]?cn.indexOf(p[1])+1:1)*10+(p[2]?cn.indexOf(p[2])+1:0):0;
}
const ordinalCopies={
 P1_LIST_REF_REQUIRED:'请点所指列表里的查看按钮，或明确回复那一份候选列表和序号。',
 P1_LIST_REF_INVALID:'这条引用不是本店本会话里可核对的候选列表，请重选那份列表。',
 P1_LIST_ORDINAL_RANGE:'该序号不在这条列表实际显示的候选内，请重选序号。',
 P1_LIST_CARD_UNAVAILABLE:'该列表所指的卡已不在本店可核对范围，请重新列出。',
 P1_LIST_VERSION_STALE:'原列表所指卡版已变化，请重新列出后再选。'
};
const face={
 needs_clarification:missing,not_found:'本店已核商品资料没有找到匹配，不代表没有库存。',
 source_unavailable:'本店商品资料暂不可读，没有核实候选。',
 version_conflict:'原消息的商品版本已变，请重新按货号查本件。',
 multiple:'有多件符合的本店卡，请明确选哪件；未默认第一件。',
 matched:'已读取本件卡资料。'
};
// Product-owned command selection. This reads only. Anything recognized as a
// positive sales action, stock, write or budget request must stay in its port.
export function classifyP1Text(value){
 if(typeof value!=='string'||value.length>500||!clean(value))return null;
 const text=clean(value);
 if(comparison.test(text)||actionsOf(text).length)return null;
 // The ordinal only names a position. Neither classifier nor current session selects a card.
 if(!controls.test(text)&&!stopQuery.test(text)){
  const at=listOrdinal.exec(text);
  if(at)return {intent:'detail',query:text,materialOnly:false,ordinal:readOrdinal(at[1])};
  if(ordinalMention.test(text)&&(positiveVerb.test(text)||/(?:结果|列表|清单)/u.test(text)))
   return {intent:'detail',query:text,materialOnly:false,ordinal:null};
 }
 const parts=text.split(/[，,。；;！？!?\n]/u).map(s=>s.trim()).filter(Boolean);
 const kept=parts.filter(s=>!noRead.test(s));
 if(!kept.length)return null;
 if(kept.some(s=>controls.test(s)))return null;
 const q=kept.join(' ');
 if(stopQuery.test(q))return null;
 const isSku=sku.test(q)&&positiveVerb.test(q);
 const inCard=details.test(q)&&(positiveVerb.test(q)||deictic.test(q)||/什么材质|尺寸是多少|什么颜色/u.test(q))||
  positiveVerb.test(q)&&/(?:材质|颜色|珠径|尺寸)/u.test(q);
 if(isSku||inCard){
  // Unsupported positive qualifiers (negated non-price/clip fields,
  // coordinated alternative, unit constraints) may not silently broaden.
  const explicit=/不要|不许|排除|只(?:看|查).{0,15}(?:以外|之外)|或者|\d\s*(?:mm|cm|毫米|厘米)/u.test(q);
  return {intent:'detail',query:q,materialOnly:wantedMaterial.test(q)||/材质\s*$/u.test(q)&&!/(?:资料|颜色|珠径|尺寸)/u.test(q),unclear:explicit};
 }
 if(itemSearch.test(q))return {intent:'search',query:q,materialOnly:false,unclear:false};
 if(positiveVerb.test(q)&&categoryMention.test(q))
  return {intent:'search',query:q,materialOnly:false,unclear:true};
 return null;
}

const lookupStates=new Set(['needs_clarification','not_found','source_unavailable','version_conflict','multiple','matched']);
const fields=[['title','title'],['category','category','productType'],['material','material'],['color','color'],
 ['size','size'],['beadDiameter','beadDiameter']];
const unsafeCopy=/(?:[<>\u0000-\u001f\u007f]|https?:|[A-Za-z]:[\\/]|\b1[3-9]\d{9}\b|@|\bsk[-_]\w+|￥|¥|\d\s*元|[万千百]元|人民币|\bCNY\b|\bRMB\b|报价|售价|价格|成本|视频|短片|旧片|原片)/iu;
const scalar=s=>typeof s==='string'&&s.trim().length>0&&s.length<=96&&!unsafeCopy.test(s);
const lengthUnit=/^(?:mm|cm|m|毫米|厘米|米|公分|英寸|in)$/iu;
const measure=x=>typeof x==='number'&&Number.isFinite(x)&&x>0||
  typeof x==='string'&&/^\d{1,6}(?:\.\d{1,4})?(?:\s*[x×]\s*\d{1,6}(?:\.\d{1,4})?){0,2}$/iu.test(x)&&Number(x.split(/[x×]/iu)[0])>0;

function safeFact(key,field,v){
 if(!v||!['manual','imported'].includes(v.source))return null;
 const dimension=['size','beadDiameter'].includes(key);
 if(dimension?typeof v.unit!=='string'||!lengthUnit.test(v.unit)||!measure(v.value):!scalar(v.value))return null;
 return {field,value:v.value,source:v.source,...(dimension?{unit:v.unit}:{}),
  ...(id(v.evidenceRef)?{evidenceRef:v.evidenceRef}:{})};
}
function summarize(s,row,materialOnly){
 const allowed=materialOnly?fields.filter(([key])=>key==='title'||key==='material'):fields;
 const facts={};
 for(const [key,...names] of allowed){
  for(const field of names){
   const v=safeFact(key,field,s.fields?.[field]);
   if(v&&(key!=='material'||!/待核|待确认|未核|未填|未录|疑似|未知|不详|未提供|^n\/?a$/iu.test(v.value))){facts[key]=v;break;}
  }
 }
 return {productId:row.productId,productVersion:row.productVersion,
  ...(scalar(row.alias)&&/^[\p{L}\p{N}_.:-]{1,36}$/u.test(row.alias)?{alias:row.alias}:{}),
  fields:facts,missingFields:allowed.map(x=>x[0]).filter(k=>!facts[k]),
  materialStatus:facts.material?'recorded':'pending_verification',source:{system:'catalog',productId:row.productId,productVersion:row.productVersion}};
}
const error=(code,httpStatus)=>Object.assign(Error(code),{code,httpStatus});
function listCandidates(c,mid,hit){
 if(hit?.shopId!==c.shopId||hit.messageId!==mid||!id(hit.requestId)||hit.productId!=null||
    hit.productVersion!=null||hit.status!=='needs_clarification'||!Array.isArray(hit.actions)||hit.actions.length!==1)return null;
 const a=hit.actions[0],p=a?.result;
 if(a?.action!=='product_read'||a.status!=='multiple'||p?.status!=='multiple'||
    p.bound!==false||p.readOnly!==true||p.deliveryStatus!=='not_submitted'||
    ![a,p].every(x=>x.shopId===c.shopId&&x.messageId===mid&&x.requestId===hit.requestId&&x.productId==null&&x.productVersion==null)||
    !Array.isArray(p.cards)||p.cards.length<1||p.cards.length>20||!Number.isSafeInteger(p.total)||
    p.total<Math.max(2,p.cards.length))return null;
 if(new Set(p.cards.map(row=>row?.productId)).size!==p.cards.length||
    !p.cards.every(row=>id(row?.productId)&&ver(row.productVersion)&&row.source?.system==='catalog'&&
      row.source.productId===row.productId&&row.source.productVersion===row.productVersion))return null;
 return p.cards;
}
export function createP1ReadTurn({product,catalog,messages}={}){
 if(typeof product?.resolve!=='function'||typeof catalog?.getSummary!=='function'||
    typeof messages?.reference!=='function'||typeof messages?.restore!=='function'||typeof messages?.setProduct!=='function')
  throw new TypeError('P1 real read and scoped ledger required');
 return async function p1(c,x){
  const q=classifyP1Text(x?.text);
  if(!q)return null;
  if(c?.role!=='owner'||![c.shopId,c.actorId,c.sessionId].every(id))throw error('FORBIDDEN',403);
  if(!id(x.requestId)||!id(x.messageId)||x.replyToMessageId!=null&&!id(x.replyToMessageId)||x.batchId!==undefined)
   throw error('INVALID_REQUEST',400);
  const meta={shopId:c.shopId,requestId:x.requestId,messageId:x.messageId};
  const reply=x.replyToMessageId??null;
  const respond=(state,cards=[],total=cards.length,reason)=>{
   const one=state==='matched'?cards[0]:null;
   const ref=one?{productId:one.productId,productVersion:one.productVersion}:{};
   const msg=ordinalCopies[reason]??(one&&one.materialStatus==='pending_verification'?'已读取本件卡资料；材质待核实。':face[state]);
   return {...meta,...ref,status:state==='matched'||state==='not_found'?'completed':
     state==='source_unavailable'||state==='version_conflict'?'failed':'needs_clarification',
     actions:[{...meta,...ref,action:'product_read',status:state,result:{...meta,...ref,status:state,
       mode:q.intent,cards,total,message:msg,...(reason?{reason}:{}),
       bound:!!one,readOnly:true,deliveryStatus:'not_submitted'}}]};
  };
  if(q.unclear)return respond('needs_clarification',[],0,'P1_CONDITION_UNSUPPORTED');
  const isOrdinal=Object.hasOwn(q,'ordinal');
  let parent, listRow;
  if(isOrdinal){
   if(q.ordinal===null||!reply)return respond('needs_clarification',[],0,'P1_LIST_REF_REQUIRED');
   if(reply===x.messageId)return respond('needs_clarification',[],0,'P1_LIST_REF_INVALID');
   let cards;
   try{cards=listCandidates(c,reply,await messages.restore(c,reply));}
   catch{return respond('source_unavailable');}
   if(!cards)return respond('needs_clarification',[],0,'P1_LIST_REF_INVALID');
   if(q.ordinal<1||q.ordinal>cards.length)return respond('needs_clarification',[],0,'P1_LIST_ORDINAL_RANGE');
   listRow=cards[q.ordinal-1]; // preserve this already-displayed order; never use total, alias or current rank
  }else if(reply){
   if(reply===x.messageId)return respond('needs_clarification',[],0,'REFERENCE_NOT_VERIFIED');
   parent=await messages.reference(c,reply);
   if(parent?.shopId!==c.shopId||!id(parent.productId)||!ver(parent.productVersion))
    return respond('needs_clarification',[],0,'REFERENCE_NOT_VERIFIED');
  }
  let r;
  try{r=await product.resolve(c,{requestId:x.requestId,messageId:x.messageId,
    text:listRow?'查货号 '+listRow.productId:q.query,reference:listRow?null:reply,intent:q.intent});}
  catch{return respond('source_unavailable');}
  if(r?.storeId!==c.shopId||r?.requestId!==x.requestId||r?.messageId!==x.messageId||!lookupStates.has(r?.status))
   return respond('source_unavailable',[],0,'P1_RECEIPT_SCOPE');
  if(listRow){
   if(r.status==='version_conflict')return respond('version_conflict',[],0,'P1_LIST_VERSION_STALE');
   if(r.status==='source_unavailable')return respond('source_unavailable');
   if(r.status!=='matched'||r.total!==1||r.cards?.length!==1||r.cards[0]?.productId!==listRow.productId)
    return respond('version_conflict',[],0,'P1_LIST_CARD_UNAVAILABLE');
   if(r.cards[0].productVersion!==listRow.productVersion)return respond('version_conflict',[],0,'P1_LIST_VERSION_STALE');
  }
  if(!['matched','multiple'].includes(r.status))return respond(r.status);
  if(!reply&&deictic.test(q.query)&&r.reason!=='EXPLICIT_ID')return respond('needs_clarification');
  if(!Array.isArray(r.cards)||r.cards.length===0||r.cards.length>20||!Number.isSafeInteger(r.total)||
     r.total<r.cards.length||new Set(r.cards.map(row=>row?.productId)).size!==r.cards.length||
     r.status==='matched'&&(r.cards.length!==1||r.total!==1)||r.status==='multiple'&&r.total<2)
   return respond('source_unavailable',[],0,'P1_RECEIPT_SCOPE');
  if(parent&&(r.cards.length!==1||r.cards[0]?.productId!==parent.productId))
   return respond('needs_clarification',[],0,'P1_REFERENCE_CONFLICT');
  if(parent&&r.cards[0].productVersion!==parent.productVersion)return respond('version_conflict');
  const out=[];
  for(const row of r.cards){
   if(!id(row?.productId)||!ver(row.productVersion)||row.source?.system!=='catalog'||
      row.source.productId!==row.productId||row.source.productVersion!==row.productVersion)
    return respond('source_unavailable',[],0,'P1_RECEIPT_SCOPE');
   let live;
   try{live=await catalog.getSummary(c,row.productId);}catch{return respond('source_unavailable');}
   if(!live||live?.shopId!=null&&live.shopId!==c.shopId||live.productId!==row.productId)
    return listRow?respond('version_conflict',[],0,'P1_LIST_CARD_UNAVAILABLE'):respond('source_unavailable',[],0,'P1_RECEIPT_SCOPE');
   if(live.productVersion!==row.productVersion)return respond('version_conflict',[],0,listRow?'P1_LIST_VERSION_STALE':undefined);
   out.push(summarize(live,row,q.materialOnly));
  }
  if(r.status==='matched'){
   const p=out[0];
   messages.setProduct(c,x.messageId,{shopId:c.shopId,productId:p.productId,productVersion:p.productVersion},false);
  }
  return respond(r.status,out,r.total,listRow?'P1_LIST_ORDINAL':undefined);
 };
}
