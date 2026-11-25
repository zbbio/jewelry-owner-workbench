const id=s=>typeof s==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/u.test(s);
const num=n=>Number.isSafeInteger(n)&&n>0;
const kinds=new Set(['knowledge','store_rule']);
const safeText=(s,n)=>typeof s==='string'&&s.trim()===s&&s.length>0&&s.length<=n&&
 !/(?:https?:\/\/|[A-Z]:[\\/]|[\u0000-\u001f\u007f]|sk-[a-z0-9_-]{10,}|\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu.test(s);
const fault=(code,httpStatus)=>Object.assign(Error(code),{code,httpStatus});
const lexical=s=>s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}]/gu,'');
const utc=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s)&&Number.isFinite(Date.parse(s));
function validScope(c){return id(c?.shopId)&&id(c?.actorId)&&id(c?.sessionId);}
const owner=c=>validScope(c)&&c.role==='owner';
const pin=(c,p)=>id(p?.productId)&&num(p?.productVersion)&&p.productId?{shopId:c.shopId,productId:p.productId,productVersion:p.productVersion}:null;
const publicRef=(r)=>({kind:r.kind,entryId:r.entryId,version:r.version,title:r.title,
 locator:{documentId:r.documentId,anchor:r.anchor,...(r.page?{page:r.page}:{})},
 scope:r.productId?{type:'product',productId:r.productId,productVersion:r.productVersion}:{type:'shop'},
 excerpt:r.excerpt,sourceClass:r.sourceClass});
const applies=(r,p)=>!r.productId||!!p&&r.productId===p.productId&&r.productVersion===p.productVersion;
const unavailable=()=>({status:'unavailable',citations:[]});
const noEvidence=()=>({status:'no_approved_evidence',citations:[]});
const note={
 cited:'以下为本店当前有效的审定资料片段，供店主核对。',
 no_approved_evidence:'本店暂没有这道问题的已审资料，不作专业判断或优惠承诺。',
 unavailable:'资料入口暂不可用，无法据此回答。',
 citation_withdrawn_or_changed:'原引用已撤回、换版或不可查看；请重新查资料，不作为现行依据。'
};
function result(kind,v){
 return {...v,facts:{kind},suggestions:[note[v.status]??note.unavailable],deliveryStatus:'not_submitted',sent:false};
}

// Local store-owned authority. Import and revoke are server-side operations;
// neither is exposed to customers or the ordinary turn body.
export function createLocalS4EvidenceIndex({db,canUse=owner,authorizeCurator=()=>false,now=Date.now,allowTestData=false}={}){
 if(!db?.prepare)throw fault('EVIDENCE_DB_REQUIRED',503);
 db.exec(`CREATE TABLE IF NOT EXISTS n22_evidence_revision(
 shop TEXT NOT NULL,kind TEXT NOT NULL,entry TEXT NOT NULL,ver INTEGER NOT NULL,doc TEXT NOT NULL,
 withdrawn_at TEXT,withdrawn_by TEXT,PRIMARY KEY(shop,kind,entry,ver));`);
 const latest=db.prepare('SELECT * FROM n22_evidence_revision WHERE shop=? AND kind=? AND entry=? ORDER BY ver DESC LIMIT 1');
 const rows=db.prepare(`SELECT d.* FROM n22_evidence_revision d WHERE d.shop=? AND d.kind=?
 AND d.ver=(SELECT max(n.ver) FROM n22_evidence_revision n WHERE n.shop=d.shop AND n.kind=d.kind AND n.entry=d.entry)
 AND d.withdrawn_at IS NULL LIMIT 501`);
 const record=db.prepare('INSERT INTO n22_evidence_revision(shop,kind,entry,ver,doc) VALUES(?,?,?,?,?)');
 const remove=db.prepare('UPDATE n22_evidence_revision SET withdrawn_at=?,withdrawn_by=? WHERE shop=? AND kind=? AND entry=? AND ver=? AND withdrawn_at IS NULL');
 const may=(c)=>owner(c)&&canUse(c)===true;
 const classAllowed=x=>x.sourceClass==='approved_store_internal'||allowTestData&&x.sourceClass==='isolated_test';
 const current=x=>classAllowed(x)&&(x.expiresAt===undefined||utc(x.expiresAt)&&Date.parse(x.expiresAt)>now());
 const allowAdmin=(c,p)=>{if(!may(c)||authorizeCurator(c,p)!==true)throw fault('EVIDENCE_ADMIN_DENIED',403);};
 const txn=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 function register(c,x){
  allowAdmin(c,'register_reviewed_entry');
  if(!x||x.shopId!==c.shopId||!kinds.has(x.kind)||!id(x.entryId)||!num(x.version)||!id(x.documentId)||
    !id(x.anchor)||!safeText(x.title,90)||!safeText(x.excerpt,420)||!id(x.rightsRef)||
    !['store_owned','licensed_internal'].includes(x.rights)||!id(x.reviewedBy)||!utc(x.reviewedAt)||
    Date.parse(x.reviewedAt)>now()||x.reviewStatus!=='approved'||
    (x.expiresAt!==undefined&&(!utc(x.expiresAt)||Date.parse(x.expiresAt)<=now()))||
    !classAllowed(x)||
    !Array.isArray(x.aliases)||!x.aliases.length||x.aliases.length>16||x.aliases.some(s=>!safeText(s,40)||lexical(s).length<2)||
    (x.page!==undefined&&!num(x.page))||(x.productId!=null?!id(x.productId)||!num(x.productVersion):x.productVersion!=null))
   throw fault('EVIDENCE_REVIEW_OR_RIGHTS_REQUIRED',400);
  const payload=Object.fromEntries(['kind','entryId','version','documentId','anchor','title','excerpt','page','rightsRef','rights','reviewedBy',
    'reviewedAt','reviewStatus','expiresAt','sourceClass','aliases','productId','productVersion'].filter(k=>x[k]!==undefined).map(k=>[k,x[k]]));
  return txn(()=>{
   const old=latest.get(c.shopId,x.kind,x.entryId);
   if(old?.ver===x.version&&old.doc===JSON.stringify(payload)&&!old.withdrawn_at)return publicRef(payload);
   if(old&&old.ver>=x.version)throw fault('EVIDENCE_VERSION_CONFLICT',409);
   record.run(c.shopId,x.kind,x.entryId,x.version,JSON.stringify(payload));
   return publicRef(payload);
  });
 }
 function withdraw(c,x){
  allowAdmin(c,'withdraw_entry');
  if(!kinds.has(x?.kind)||!id(x.entryId)||!num(x.version))throw fault('EVIDENCE_VERSION_REQUIRED',400);
  return txn(()=>{
   const r=latest.get(c.shopId,x.kind,x.entryId);
   if(!r||r.ver!==x.version)throw fault('EVIDENCE_VERSION_NOT_CURRENT',409);
   if(!r.withdrawn_at)remove.run(new Date(now()).toISOString(),c.actorId,c.shopId,x.kind,x.entryId,x.version);
   return {kind:x.kind,entryId:x.entryId,version:x.version,state:'withdrawn'};
  });
 }
 function lookup(c,{kind,text,subject}={}){
  if(!may(c))throw fault('EVIDENCE_SCOPE_DENIED',403);
  if(!kinds.has(kind)||typeof text!=='string'||text.length>1200)return noEvidence();
  const q=lexical(text);
  const candidates=rows.all(c.shopId,kind);
  if(candidates.length>500)return unavailable();
  const hits=candidates.map(y=>JSON.parse(y.doc)).filter(x=>current(x)&&applies(x,subject)).flatMap(x=>{
   const score=Math.max(0,...x.aliases.map(lexical).filter(a=>q.includes(a)).map(a=>a.length));
   return score?[{x,score}]:[];
  }).sort((a,b)=>b.score-a.score||a.x.entryId.localeCompare(b.x.entryId));
  if(!hits.length)return noEvidence();
  // A single strongest entry is actionable. Equal-strength entries are
  // ambiguous without more context, so don't present a guess as guidance.
  if(hits[1]?.score===hits[0].score)return noEvidence();
  return {status:'cited',citations:[publicRef(hits[0].x)]};
 }
 function verify(c,q,subject){
  if(!may(c)||!kinds.has(q?.kind)||!id(q.entryId)||!num(q.version))return null;
  const r=latest.get(c.shopId,q.kind,q.entryId);
  if(!r||r.withdrawn_at||r.ver!==q.version)return null;
  const x=JSON.parse(r.doc);
  return current(x)&&applies(x,subject)?publicRef(x):null;
 }
 return Object.freeze({register,withdraw,lookup,verify});
}
const care=/保养|养护|护理|清洁|清洗|鉴定|专业知识|(?:查|问)(?:本店)?(?:已审)?知识/u;
const rule=/店规|折扣|打折|优惠|退换|退货|换货/u;
const price=/多少钱|售价|什么价|怎么卖|查价|报价|商品价格/u;
const noPrice=/不(?:要|用|必|需要)?(?:再)?(?:问|查|报).{0,5}(?:价|多少钱)|(?:价格|售价).{0,4}(?:不|别|无需)(?:再)?(?:问|查|报)/u;
const never=/发给顾客|发送给|直接外发|新建|新增|确认制作|准备.{0,10}(?:分镜|新片)|修改|改价|更新价格/u;
export function parseS4EvidenceIntent(text){
 if(typeof text!=='string'||text.length>500||never.test(text))return null;
 const parts=text.split(/[，,。；;！？!?、\n]/u).map(x=>x.trim()).filter(Boolean);
 const group=Object.fromEntries([['knowledge',care],['store_rule',rule]].map(([k,r])=>
  [k,parts.filter(q=>r.test(q)&&!/^(?:先)?(?:不(?:要|想|用)?|别|无需)/u.test(q)).join('，')]));
 if(!group.knowledge&&!group.store_rule)return null;
 const wantsPrice=!noPrice.test(text)&&parts.some(q=>price.test(q)&&!care.test(q)&&!rule.test(q));
 return {group,wantsPrice};
}
const identity=(c,x)=>({shopId:c.shopId,requestId:x.requestId,messageId:x.messageId});
function responseFields(prev,claim){
 return prev.shopId===claim.shopId&&prev.requestId===claim.requestId&&prev.messageId===claim.messageId;
}
export function createS4EvidenceTurn({index,product,catalog,canUse=owner}={}){
 const check=async c=>{if(!owner(c)||await canUse(c)!==true)throw fault('FORBIDDEN',403);};
 const lookup=async(c,opts)=>{
  if(!index)return unavailable();
  try{return await index.lookup(c,opts);}catch{return unavailable();}
 };
 const single=async(c,kind,text,base,p)=>{
  const v=await lookup(c,{kind,text,subject:p});
  return {...base,...p,action:kind,status:v.status,result:result(kind,v)};
 };
 async function turn(c,x,runQuote){
  const intent=parseS4EvidenceIntent(x?.text);
  if(!intent)return null;
  await check(c);
  if(!id(x.requestId)||!id(x.messageId)||(x.replyToMessageId!=null&&!id(x.replyToMessageId))||
    Object.keys(x).some(k=>!['text','requestId','messageId','replyToMessageId'].includes(k)))throw fault('INVALID_REQUEST',400);
  const base=identity(c,x);
  let card=null,prior=null;
  if(intent.wantsPrice){
   prior=await runQuote(c,x);
   if(prior&&responseFields(prior,base))card=pin(c,prior);
  }else if(x.replyToMessageId||/(?:这|本)(?:件|条|款)|(?:^|[\s按查])[A-Za-z0-9_.:-]{1,120}(?=[^\w-]|$)|货号|商品号|\bSKU\b/iu.test(x.text)){
   try{
    const f=await product?.resolve(c,{...Object.fromEntries(['requestId','messageId','text'].map(k=>[k,x[k]])),reference:x.replyToMessageId??null,intent:'detail'});
    if(f?.requestId===x.requestId&&f?.messageId===x.messageId&&(f?.shopId??f?.storeId)===c.shopId&&f?.status==='matched'&&
       f.total===1&&f.cards?.length===1)card=pin(c,f.cards[0]);
   }catch{}
  }
  let subjects={};
  if(card)try{
   const live=await catalog?.get(c,card.productId);
   if(live?.productId===card.productId&&live.productVersion===card.productVersion&&
       (live.shopId==null||live.shopId===c.shopId))subjects=card;
  }catch{}
  if(!subjects.productId&&prior?.actions?.some(a=>a.productId))
    prior=null;
  const additions=await Promise.all(Object.entries(intent.group).filter(([,q])=>q).map(([k,q])=>single(c,k,q,base,subjects)));
  const old=prior&&responseFields(prior,base)?prior.actions??[]:[];
  const hasPrice=old.some(a=>a.action==='quote');
  const cited=additions.some(x=>x.status==='cited');
  const missed=additions.some(x=>x.status!=='cited')||intent.wantsPrice&&(!hasPrice||old.some(a=>a.action==='quote'&&a.status==='failed'));
  return {...base,...subjects,status:missed?(cited||hasPrice?'partial':'failed'):'completed',actions:[...old,...additions],
    ...(intent.wantsPrice&&!hasPrice?{message:'报价需要先明确本件商品；资料项与报价分开。'}:{})};
 }
 async function draft(c,receipt){
  if(!index||receipt?.status!=='completed'||receipt.shopId!==c.shopId)return receipt;
  const a=receipt.actions?.find(a=>a.action==='reply_draft'), x=a?.result;
  if(x?.status!=='owner_draft_only')return receipt;
  const query=x.customerSaid?.map(o=>o.text).join('。');
  const intent=parseS4EvidenceIntent(query);
  if(!intent)return receipt;
  const subject=pin(c,receipt);
  const data=Object.fromEntries(await Promise.all(Object.entries(intent.group).filter(([,q])=>q).map(async([k,q])=>
   [k,result(k,await lookup(c,{kind:k,text:q,subject}))])));
  return {...receipt,actions:receipt.actions.map(row=>row===a?{...a,result:{...x,evidenceCitations:data}}:row)};
 }
 return Object.freeze({turn,draft});
}
