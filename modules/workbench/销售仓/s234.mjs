import {randomUUID} from 'node:crypto';
import {inventorySentence, readStock} from '../../../../店主工作台/sales/card-evidence.mjs';
import {readRecordedPrice} from './price-source.mjs';
import {independentDraftSuggestions} from './s4-draft-text.mjs';
import {cleanCustomerQuote} from './s4-source.mjs';
import {parseComparison,comparableColor,comparableCategory,micron,valueMm} from './s2-conditions.mjs';
export {parseComparison} from './s2-conditions.mjs';

const fail=(code,httpStatus=400)=>{throw Object.assign(Error(code),{code,httpStatus});};
const ident=x=>typeof x==='string'&&/^[\p{L}\p{N}_.:-]{1,120}$/u.test(x);
function scope(c,allow,op) {
 if(!ident(c?.shopId)||!ident(c?.actorId)||!ident(c?.sessionId))fail('SESSION_REQUIRED',401);
 if(allow(c,op)!==true)fail('FORBIDDEN',403);
 return c;
}
function matchCard(c,card,id,v) {
 return card&&(card.shopId===undefined||card.shopId===c.shopId)&&card.productId===id&&card?.productVersion===v&&ident(id)&&Number.isSafeInteger(v)&&v>0;
}
const acknowledged=x=>x&&['manual','imported'].includes(x.source)&&(typeof x.value==='string'||typeof x.value==='number');
const fieldFact=x=>({value:x.value,unit:x.unit??null,source:x.source});
const factBy=(fields,...keys)=>{
 for(const key of keys)if(fields?.[key]!=null)return {key,fact:fields[key]};
 return {key:keys[0],fact:null};
};
function proveConditions(fields,f){
 const checks=[];
 function add(field,{key,fact},read,meets){
  const v=acknowledged(fact)?read(fact):null;
  checks.push({field,key,fact,v,ok:v!=null&&meets(v)});
 }
 if(f.category)add('category',factBy(fields,'category','productType'),x=>comparableCategory(x.value),v=>v===f.category);
 if(f.purpose)add('purpose',factBy(fields,'occasion','purpose'),x=>{
  const xs=typeof x.value==='string'?x.value.trim().split(/[、,，;；\s]+/u).filter(Boolean):[];
  return xs.length?xs:null;
 },v=>v.includes(f.purpose));
 if(f.color)add('color',factBy(fields,'color'),x=>comparableColor(x.value),
  v=>(!f.color.required||f.color.required===v)&&!f.color.excluded.includes(v));
 if(f.beadDiameter)add('beadDiameter',factBy(fields,'beadDiameter'),x=>micron(x.value,x.unit),
  v=>valueMm(v)===f.beadDiameter.valueMm);
 if(checks.some(x=>x.v!==null&&!x.ok))return {outcome:'mismatch'};
 if(checks.some(x=>x.v===null))return {outcome:'unknown'};
 return {outcome:'matched',evidence:Object.fromEntries(checks.map(x=>[x.field,{field:x.key,...fieldFact(x.fact),
  ...(x.field==='beadDiameter'?{valueMm:valueMm(x.v)}:x.field==='color'?{normalizedColor:x.v}:{})}]))};
}
export function createComparison({catalog,canUse=()=>false,lookupOldVideo=null}={}){
 if(typeof catalog?.list!=='function'||typeof catalog?.get!=='function')throw new TypeError('catalog reads required');
 return async(ctx,x)=>{
  scope(ctx,canUse,'compare');
  if(!ident(x?.requestId)||!ident(x?.messageId))fail('INVALID_INPUT');
  const f=parseComparison(x.text);
  const base={requestId:x.requestId,messageId:x.messageId,shopId:ctx.shopId};
  if(!f||f.issue)return {...base,status:'needs_clarification',items:[],...(f?.issue?{clarification:f.issue}:{})};
  const a=await catalog.list(ctx);
  if(!Array.isArray(a))return {...base,status:'catalog_unavailable',items:[]};
  let unknownPriceExcluded=0,unknownConditionExcluded=0,conditionMismatchExcluded=0;
  const eligible=[];
  for(const ref of a){
   if(!matchCard(ctx,ref,ref?.productId,ref?.productVersion))continue;
   const x=await catalog.get(ctx,ref.productId);
   if(!matchCard(ctx,x,ref.productId,ref.productVersion))continue;
   const p=readRecordedPrice(x);
   if(p.state==='unknown'){unknownPriceExcluded++;continue;}
   if(Number(p.amount)>Number(f.budgetYuan))continue;
   const checked=proveConditions(x.fields,f);
   if(checked.outcome==='mismatch'){conditionMismatchExcluded++;continue;}
   if(checked.outcome==='unknown'){unknownConditionExcluded++;continue;}
   const attributes={};
   for(const k of ['material','color','size','beadDiameter']) {
    const v=x.fields?.[k]; if(acknowledged(v))attributes[k]=fieldFact(v);
   }
   eligible.push({productId:x.productId,productVersion:x.productVersion,price:{...p,amount:Number(p.amount).toFixed(2)},attributes,
     conditionEvidence:checked.evidence,
     reason:[f.category&&'已登记品类符合',f.purpose&&'已登记用途符合',f.color&&'已登记颜色符合',
      f.beadDiameter&&'已登记珠径符合','售价在预算内'].filter(Boolean)});
  }
  const items=eligible.sort((a,b)=>Number(a.price.amount)-Number(b.price.amount)||a.productId.localeCompare(b.productId)).slice(0,f.count);
  const contrasts=[];
  if(items.length>1){
   for(const field of ['amount','material','color','size','beadDiameter']){
    const facts=items.map(x=>field==='amount'?{value:x.price.amount,unit:x.price.currency,source:x.price.source}:x.attributes[field]??null);
    const units=new Set(facts.map(x=>x?.unit??null));
    const comparable=facts.every(Boolean)&&units.size===1&&(!['size','beadDiameter'].includes(field)||facts.every(x=>typeof x.unit==='string'&&x.unit.length>0));
    const values=facts.map(x=>x?.value??null);
    contrasts.push({field,values,facts,comparable,knownDifference:comparable&&new Set(values.map(String)).size>1});
   }
  }
  if(x.includeOldVideo===true)await Promise.all(items.map(async item=>{
   try{
    const v=await lookupOldVideo?.(ctx,{messageId:x.messageId,productId:item.productId,productVersion:item.productVersion});
    item.videoStatus=v?.shopId===ctx.shopId&&v?.productId===item.productId&&v.productVersion===item.productVersion&&
      ['existing_available','no_verified_old_clip','needs_review'].includes(v.status)?v.status:'not_connected_or_unverified';
   }catch{item.videoStatus='temporarily_unavailable';}
  }));
  return {...base,status:items.length?'completed':'no_confirmed_match',criteria:f,items,contrasts,
   requestedCount:f.count,eligibleCount:eligible.length,unknownPriceExcluded,unknownConditionExcluded,conditionMismatchExcluded,suppliersNotTreatedAsInStore:true};
 };
}
function initTaskTables(db){
 // Original sales tables/keys, plus an existing operation name namespace.
 // Mount only against approved isolated writable sales storage.
 db.exec(`CREATE TABLE IF NOT EXISTS sales_receipts(shop_id TEXT, operation TEXT, request_id TEXT, body TEXT, receipt TEXT, PRIMARY KEY(shop_id,operation,request_id));
 CREATE TABLE IF NOT EXISTS sales_tasks(shop_id TEXT, task_id TEXT, product_id TEXT, kind TEXT, status TEXT, PRIMARY KEY(shop_id,task_id));
 CREATE INDEX IF NOT EXISTS sales_task_subject ON sales_tasks(shop_id,product_id,kind,status);
 CREATE TABLE IF NOT EXISTS sales_task_origins(shop_id TEXT NOT NULL,task_id TEXT NOT NULL,question TEXT NOT NULL,request_id TEXT NOT NULL,
  product_version INTEGER NOT NULL,PRIMARY KEY(shop_id,task_id));`);
}
export function createStockS3({catalog,db=null,canUse=()=>false,canCreateTask=()=>false,now=Date.now,maxAgeMs=86400000,searchSupplierTier=null}={}){
 if(typeof catalog?.get!=='function'||typeof catalog?.getSummary!=='function'||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<0)
   throw new TypeError('catalog/inventory ports required');
 if(db) initTaskTables(db);
 const r=(c,p,v)=>{
   const card=catalog.get(c,p),summary=catalog.getSummary(c,p);
   if(!matchCard(c,card,p,v))fail('PRODUCT_SCOPE_OR_VERSION_CHANGED',409);
   return readStock(card,summary,c.shopId,now(),maxAgeMs);
 };
 function task(c,x) {
   if(!db)return {taskStatus:'not_connected',taskId:null,notified:false};
   if(canCreateTask(c,x)!==true)fail('TASK_PERMISSION_REQUIRED',403);
   const namespace='n22_inventory_verify', digest=JSON.stringify({actorId:c.actorId,sessionId:c.sessionId,messageId:x.messageId,
      productId:x.productId,productVersion:x.productVersion});
   db.exec('BEGIN IMMEDIATE');
   try{
    const old=db.prepare('SELECT body,receipt FROM sales_receipts WHERE shop_id=? AND operation=? AND request_id=?').get(c.shopId,namespace,x.requestId);
    if(old&&old.body!==digest)fail('REQUEST_REUSE_CONFLICT',409);
    const state=r(c,x.productId,x.productVersion);
    if(!['unknown','stale'].includes(state.inventoryState)) {
     db.exec('COMMIT');return {taskStatus:'not_needed_current_stock_verified',taskId:null,notified:false};
    }
    if(old){db.exec('COMMIT');return {...JSON.parse(old.receipt),taskStatus:'replayed',notified:false};}
    const prior=db.prepare("SELECT task_id FROM sales_tasks WHERE shop_id=? AND product_id=? AND kind='verify_inventory' AND status='open' ORDER BY rowid LIMIT 1")
      .get(c.shopId,x.productId);
    const taskId=prior?.task_id??randomUUID();
    if(!prior){
      db.prepare('INSERT INTO sales_tasks VALUES(?,?,?,?,?)').run(c.shopId,taskId,x.productId,'verify_inventory','open');
      db.prepare('INSERT INTO sales_task_origins VALUES(?,?,?,?,?)').run(c.shopId,taskId,'请核实本件库存',x.requestId,x.productVersion);
    }
    const receipt={taskId,taskStatus:prior?'existing_open_task':'created',notified:false};
    db.prepare('INSERT INTO sales_receipts VALUES(?,?,?,?,?)').run(c.shopId,namespace,x.requestId,digest,JSON.stringify(receipt));
    db.exec('COMMIT');return receipt;
   }catch(e){db.exec('ROLLBACK');throw e;}
 }
 async function supplierAlternatives(ctx,x){
  if(!searchSupplierTier)return {status:'directory_not_connected',items:[]};
  for(const tier of ['frequent','other']){
   let r;
   try{r=await searchSupplierTier(ctx,{productId:x.productId,productVersion:x.productVersion,tier});}catch{return {status:'directory_unavailable',items:[]};}
   if(r?.status!=='ok'||!Array.isArray(r?.items))return {status:'directory_unavailable',items:[]};
   const safe=r.items.filter(y=>y?.shopId===ctx.shopId&&ident(y?.candidateId)&&y.authorized===true)
      .map(y=>({candidateId:y.candidateId,source:'supplier_directory',tier,availabilityNotPromised:true}));
   if(safe.length)return {status:'matched',items:safe};
  }
  return {status:'no_match',items:[]};
 }
 return async(ctx,x)=>{
  scope(ctx,canUse,'stock_read');
  if(!ident(x?.requestId)||!ident(x?.messageId)||!ident(x?.productId)||!Number.isSafeInteger(x?.productVersion)||
    !['read_only','owner_confirmed_verify_task'].includes(x.mode))fail('INVALID_INPUT');
  const state=r(ctx,x.productId,x.productVersion);
  const receipt=x.mode==='owner_confirmed_verify_task'?task(ctx,x):{taskStatus:'not_requested',taskId:null,notified:false};
  const alternatives=x.requestAlternatives===true&&state.inventoryState!=='in_stock'?await supplierAlternatives(ctx,x):{status:'not_requested',items:[]};
  return {shopId:ctx.shopId,requestId:x.requestId,messageId:x.messageId,productId:x.productId,productVersion:x.productVersion,
   ...state,text:inventorySentence(state),...receipt,alternatives};
 };
}
const scrub=t=>t.replace(/(?:sk-[a-z0-9_-]{10,}|https?:\/\/\S+|\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/giu,'[已隐去]');
export function createReplyDraft({catalog,readConversation,readApprovedKnowledge,readStoreRules,readHandoff,canUse=()=>false,now=Date.now,maxAgeMs=86400000}={}){
 if(typeof catalog?.get!=='function')throw new TypeError('catalog read required');
 return async(ctx,x)=>{
  scope(ctx,canUse,'draft');
  if(!ident(x?.requestId)||!ident(x?.messageId)||!ident(x?.conversationId)||!ident(x?.productId)||!Number.isSafeInteger(x?.productVersion))fail('INVALID_INPUT');
  let customer,customerSource;
  const supplied=x.ownerQuestion;
  if(supplied!==undefined){
   if(!['owner_input_current_turn','owner_input_referenced_message'].includes(supplied?.kind)||
      supplied.shopId!==ctx.shopId||supplied.actorId!==ctx.actorId||supplied.sessionId!==ctx.sessionId||
      !ident(supplied.originMessageId)||!cleanCustomerQuote(supplied.text)||supplied.text.length>220||
      supplied.kind==='owner_input_current_turn'&&supplied.originMessageId!==x.messageId||
      supplied.kind==='owner_input_referenced_message'&&supplied.originMessageId===x.messageId)
     fail('CONVERSATION_NOT_IN_SCOPE',404);
   customer=[{messageId:supplied.originMessageId,text:cleanCustomerQuote(supplied.text),source:supplied.kind}];
   customerSource={kind:supplied.kind,originMessageId:supplied.originMessageId};
  }else{
   const thread=await readConversation?.(ctx,x.conversationId);
   if(!thread||thread.shopId!==ctx.shopId||thread.conversationId!==x.conversationId||!Array.isArray(thread.turns)||
       thread.sessionId!==ctx.sessionId||(thread.productId!==undefined&&thread.productId!==x.productId))fail('CONVERSATION_NOT_IN_SCOPE',404);
   customer=thread.turns.filter(t=>t.role==='customer'&&ident(t.id)&&typeof t.text==='string'&&t.text.trim()).slice(-5)
     .map(t=>({messageId:t.id,text:scrub(t.text.trim().slice(0,220)),source:'authorized_internal_conversation'}));
   customerSource={kind:'authorized_internal_conversation',conversationId:x.conversationId};
  }
  if(!customer.length)fail('DRAFT_SOURCE_REQUIRED',422);
  const card=await catalog.get(ctx,x.productId);
  if(!matchCard(ctx,card,x.productId,x.productVersion))fail('PRODUCT_SCOPE_OR_VERSION_CHANGED',409);
  const recordedPrice=readRecordedPrice(card);
  const price=recordedPrice.state==='known'?{...recordedPrice,amount:Number(recordedPrice.amount).toFixed(2)}:recordedPrice;
  const summary=await catalog.getSummary?.(ctx,x.productId);
  const stock=readStock(card,summary,ctx.shopId,now(),maxAgeMs);
  const concerns=[...new Set(customer.flatMap(s=>[/价|预算|多少钱|多少元|怎么卖/.test(s.text)?'预算和价格':null,
    /尺寸|大小|围|戴|珠径|内径/.test(s.text)?'尺寸或佩戴':null,
    /库存|现货|有货|没货|缺货|售罄/.test(s.text)?'库存':null,/折扣|打折|优惠|便宜/.test(s.text)?'优惠':null].filter(Boolean)))];
  const missing=[];
  if(price.state==='unknown')missing.push('本件售价待核实');
  if(['unknown','stale'].includes(stock.inventoryState))missing.push('本件库存待核实');
  const hasSize=['size','innerDiameter','circumference','beadDiameter','length','width'].some(k=>card.fields?.[k]?.source==='manual'&&
    typeof card.fields[k].unit==='string'&&String(card.fields[k].value??'').trim()!=='');
  if(!hasSize)missing.push('本件尺寸待核实');
  let k=[];try{const got=await readApprovedKnowledge?.(ctx,{productId:x.productId});if(Array.isArray(got))k=got;}catch{}
  const knowledge=k.filter(y=>y?.shopId===ctx.shopId&&y.status==='approved'&&y.revoked!==true&&ident(y.entryId)&&
    Number.isSafeInteger(y.version)&&y.version>0&&ident(y.excerptRef)).map(y=>({entryId:y.entryId,version:y.version,excerptRef:y.excerptRef}));
  let rules=[], rulesState='not_connected';
  if(readStoreRules)try{
   const got=await readStoreRules(ctx,{productId:x.productId,productVersion:x.productVersion,conversationId:x.conversationId});
   if(!Array.isArray(got))throw Error('unavailable');
   rules=got.filter(p=>p?.shopId===ctx.shopId&&p.status==='active'&&p.revoked!==true&&ident(p.ruleId)&&
    Number.isSafeInteger(p.version)&&p.version>0&&typeof p.text==='string'&&p.text.trim()&&
    (p.productId===undefined||p.productId===x.productId)).map(p=>({ruleId:p.ruleId,version:p.version,text:scrub(p.text.slice(0,220))}));
   rulesState=rules.length?'confirmed':'none_verified';
  }catch{rulesState='unavailable';}
  let handoff={status:'not_requested',carriedOut:false};
  if(readHandoff&&!supplied)try{
   const v=await readHandoff(ctx,x.conversationId);
   if(v?.shopId===ctx.shopId&&v?.conversationId===x.conversationId&&
      (v.sessionId===undefined||v.sessionId===ctx.sessionId)&&['requested','active','resolved'].includes(v.status)&&ident(v.receiptId))
     handoff={status:v.status,receiptId:v.receiptId,carriedOut:false,source:'existing_handoff_record'};
  }catch{handoff={status:'unavailable',carriedOut:false};}
  const inventory={state:stock.inventoryState,source:stock.inventoryEvidence?'catalog_inventory':null,
    verifiedAt:stock.inventoryEvidence?.verifiedAt??null};
  const facts={price,dimensions:hasSize?'confirmed_values_in_product_card':'unknown',inventory};
  const suggestions=independentDraftSuggestions(concerns,facts);
  return {status:'owner_draft_only',shopId:ctx.shopId,requestId:x.requestId,messageId:x.messageId,
   productId:x.productId,productVersion:x.productVersion,customerSaid:customer,customerSource,observedConcerns:concerns,
   facts,
   suggestions,unanswered:missing,knowledge,storeRules:{status:rulesState,items:rules},humanHandoff:handoff,deliveryStatus:'not_submitted',sent:false,orderOrPurchaseInferred:false};
 };
}
