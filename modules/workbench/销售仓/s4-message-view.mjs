import {independentDraftSuggestions} from './s4-draft-text.mjs';

const id=s=>typeof s==='string'&&/^[\w.:-]{1,128}$/u.test(s);
const version=n=>Number.isSafeInteger(n)&&n>0;
const kinds=new Set(['knowledge','store_rule']);
const fault=(code,httpStatus)=>Object.assign(Error(code),{code,httpStatus});
const changed='citation_withdrawn_or_changed';
const notices={
 cited:'以下为本店当前有效的审定资料片段，供店主核对。',
 no_approved_evidence:'本店暂没有这道问题的已审资料，不作专业判断或优惠承诺。',
 unavailable:'资料入口暂不可用，未核实的快照不作为现行依据。',
 [changed]:'资料已撤回、已换版或当前无法核实，不作为现行依据。'
};
const identity=(v,r)=>v?.shopId===r.shopId&&v?.requestId===r.requestId&&v?.messageId===r.messageId;
function readPin(r,c){
 return id(r.productId)&&version(r.productVersion)?{shopId:c.shopId,productId:r.productId,productVersion:r.productVersion}:null;
}
const publicResult=(kind,status,citations)=>({status,citations,facts:{kind},suggestions:[notices[status]],deliveryStatus:'not_submitted',sent:false});

// Only the scoped *server* ledger is a source for a historical receipt.
// The selector contains no receipt body or tenant. Always run AFTER the
// persistent execute/restore completes; never persist this view.
export function createS4MessagePresenter({index,catalog,canUse,restore}={}){
 return async function presentMessage(c,sel,{restoreScoped=restore}={}){
  if(c?.role!=='owner'||![c.shopId,c.actorId,c.sessionId].every(id)||await canUse?.(c)!==true)
   throw fault('FORBIDDEN',403);
  if(!id(sel?.messageId)||(sel.requestId!=null&&!id(sel.requestId)))
   throw fault('INVALID_MESSAGE_SELECTOR',400);
  if(typeof restoreScoped!=='function')throw fault('SCOPED_MESSAGE_RESTORE_REQUIRED',503);
  const r=await restoreScoped(c,sel.messageId);
  if(!r)return null;
  if(r.shopId!==c.shopId||r.messageId!==sel.messageId||!id(r.requestId)||
     sel.requestId!=null&&sel.requestId!==r.requestId||
     r.sessionId!=null&&r.sessionId!==c.sessionId||r.actorId!=null&&r.actorId!==c.actorId)
   throw fault('MESSAGE_VIEW_SCOPE_CONFLICT',409);
  const addReplay=out=>sel.replay===true?{...out,replay:true}:out;
  if(!Array.isArray(r.actions)||!r.actions.some(a=>kinds.has(a.action)||a.action==='reply_draft'))
   return addReplay(r);
  const pin=readPin(r,c);
  let cardPromise;
  const currentCard=()=>{
   cardPromise??=Promise.resolve().then(()=>pin?catalog?.get(c,pin.productId):null);
   return cardPromise;
  };
  async function current(kind,q){
   if(!index||!id(q?.entryId)||!version(q.version))return null;
   try{
    const v=await index.verify(c,{kind,entryId:q.entryId,version:q.version},pin);
    if(v?.kind!==kind||v.entryId!==q.entryId||v.version!==q.version||!v.scope)return null;
    // Verify the authority's actual scope, not a hint stored in the draft.
    if(q.scope&&(q.scope.type!==v.scope.type||q.scope.productId!==v.scope.productId||
        q.scope.productVersion!==v.scope.productVersion))return null;
    if(v.scope.type==='product'){
     const live=await currentCard();
     if(!pin||v.scope.productId!==pin.productId||v.scope.productVersion!==pin.productVersion||
        live?.productId!==pin.productId||live.productVersion!==pin.productVersion||
        live.shopId!=null&&live.shopId!==c.shopId)return null;
    }else if(v.scope.type!=='shop')return null;
    return v;
   }catch{return null;}
  }
  async function citations(kind,old){
   const expected=Array.isArray(old?.citations)?old.citations:[];
   if(old?.status!=='cited'&&expected.length)return publicResult(kind,changed,[]);
   if(old?.status==='cited'){
    const found=[];
    for(const q of expected.slice(0,1)){
     const v=q?.kind===kind?await current(kind,q):null;
     if(v)found.push(v);
    }
    return publicResult(kind,found.length?'cited':changed,found);
   }
   return publicResult(kind,old?.status===changed?changed:
    !index||old?.status==='unavailable'?'unavailable':'no_approved_evidence',[]);
  }
  const actions=await Promise.all(r.actions.map(async a=>{
   if(kinds.has(a.action)){
    if(!identity(a,r)||(a.productId!=null||a.productVersion!=null)&&(!pin||a.productId!==pin.productId||a.productVersion!==pin.productVersion))
     throw fault('MESSAGE_VIEW_SCOPE_CONFLICT',409);
    const out=await citations(a.action,a.result);
    return {...a,status:out.status,result:out};
   }
   if(a.action!=='reply_draft'||!a.result)return a;
   const old=a.result;
   if(!identity(a,r)||!identity(old,r)||!pin||[a,old].some(v=>v.productId!==pin.productId||v.productVersion!==pin.productVersion))
    throw fault('MESSAGE_VIEW_SCOPE_CONFLICT',409);
   const oldRules=Array.isArray(old.storeRules?.items)?old.storeRules.items:[];
   const oldKnowledge=Array.isArray(old.knowledge)?old.knowledge:[];
   const rules=(await Promise.all((old.storeRules?.status==='confirmed'?oldRules:[]).map(async q=>{
    const v=await current('store_rule',{entryId:q?.ruleId,version:q?.version});
    return v?{ruleId:v.entryId,version:v.version,text:v.excerpt.slice(0,220)}:null;
   }))).filter(Boolean);
   const knowledge=(await Promise.all(oldKnowledge.map(async q=>{
    const v=await current('knowledge',q);
    return v?{entryId:v.entryId,version:v.version,excerptRef:v.locator.anchor}:null;
   }))).filter(Boolean);
   const docs=old.evidenceCitations&&typeof old.evidenceCitations==='object'?Object.fromEntries(await Promise.all(
    Object.entries(old.evidenceCitations).filter(([k])=>kinds.has(k)).map(async([k,v])=>[k,await citations(k,v)]))):null;
   const rulesRemoved=oldRules.length>rules.length||old.storeRules?.status==='confirmed'&&!rules.length;
   const removed=rulesRemoved||oldKnowledge.length>knowledge.length||
    Object.values(docs??{}).some(v=>v.status===changed);
   const ruleState=rules.length?'confirmed':rulesRemoved?changed:
    ['unavailable','none_verified','not_connected',changed].includes(old.storeRules?.status)?old.storeRules.status:'none_verified';
   // Legacy drafts have no suggestion provenance. Keep only exact known
   // independent sentences already in that receipt, never regenerate a draft.
   const allowed=new Set(independentDraftSuggestions(old.observedConcerns,old.facts));
   const suggestions=Array.isArray(old.suggestions)?old.suggestions.filter(text=>allowed.has(text)):[];
   const fields=['status','shopId','requestId','messageId','productId','productVersion','customerSaid','customerSource',
     'observedConcerns','facts','unanswered','humanHandoff','deliveryStatus','sent','orderOrPurchaseInferred'];
   const kept=Object.fromEntries(fields.filter(k=>Object.hasOwn(old,k)).map(k=>[k,old[k]]));
   return {...a,result:{...kept,suggestions,knowledge,storeRules:{status:ruleState,items:rules},
    ...(docs?{evidenceCitations:docs}:{}),
    ...(removed?{evidenceReview:{status:changed,message:notices[changed]}}:{})}};
  }));
  const evidenceChanged=actions.some(a=>a.status===changed||a.status==='unavailable');
  const hasUnaffectedOperation=actions.some(a=>a.status==='cited'||!kinds.has(a.action)&&a.status!=='failed');
  return addReplay({...r,actions,...(evidenceChanged?{status:hasUnaffectedOperation?'partial':'failed'}:{})});
 };
}
