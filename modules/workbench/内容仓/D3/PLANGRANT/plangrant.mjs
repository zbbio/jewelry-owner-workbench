import {createHash,randomUUID} from 'node:crypto';

const purpose='local_content_only';
const hash=b=>createHash('sha256').update(b).digest('hex');
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const same=(a,b,keys)=>!!a&&!!b&&keys.every(k=>a[k]===b[k]);
const card=['shopId','productId','productVersion'];
const reject=(code,httpStatus)=>Object.assign(new Error(code),{code,httpStatus});
const need=(ok,code,st=409)=>{if(!ok)throw reject(code,st);};
const iso=t=>new Date(t).toISOString();

// Only constructed by the product wire in its loopback, isolated D3 write profile.
export function createProductPlanningGrant({db,catalog,album,messages,p34,storeId,policy,isCurrentOwner,
  previewTtlMs=120000,grantTtlMs=1800000,clock=Date.now}){
 const okTtl=(n,max)=>Number.isSafeInteger(n)&&n>=1000&&n<=max;
 need(/^n22-write-[a-f0-9]{14}$/.test(storeId)&&policy?.storeId===storeId&&
  policy.source==='local_self_drawn_d3_fixture_v1'&&policy.hashes.length===2&&
  typeof isCurrentOwner==='function'&&okTtl(previewTtlMs,120000)&&okTtl(grantTtlMs,1800000),'PLANGRANT_ISOLATION_REQUIRED',500);
 const approved=new Set(policy.hashes);
 // catalog.saveCopy starts and commits its own transaction. The TEMP stage is
 // populated only by this synchronous product port. A scoped TEMP trigger
 // writes the companion grant inside the existing catalog transaction; either
 // both persist or neither does. It does not modify the catalog module/schema.
 db.exec(`
 CREATE TABLE IF NOT EXISTS n22_plangrant_previews(
  shop TEXT,actor TEXT,sid TEXT,mid TEXT,product TEXT,state TEXT,expires INTEGER,spec TEXT,
  PRIMARY KEY(shop,actor,sid,mid));
 CREATE TABLE IF NOT EXISTS n22_plangrant_grants(
  shop TEXT,actor TEXT,sid TEXT,product TEXT,pver INTEGER,version INTEGER,
  confirmation TEXT,request TEXT,preview TEXT,state TEXT,expires INTEGER,snapshot TEXT,revoked_at INTEGER,
  PRIMARY KEY(shop,product,version),UNIQUE(shop,actor,sid,confirmation));
 CREATE TEMP TABLE n22_plangrant_commit_stage(
  k INTEGER PRIMARY KEY CHECK(k=1), shop TEXT, actor TEXT, sid TEXT, product TEXT, preview TEXT,
  confirmation TEXT, request TEXT, copy_key TEXT, version INTEGER, expires INTEGER, snapshot TEXT);
 CREATE TEMP TRIGGER n22_plangrant_copy_commit AFTER INSERT ON main.catalog_receipts
 WHEN NEW.operation='saveCopy' AND EXISTS(
   SELECT 1 FROM n22_plangrant_commit_stage WHERE shop=NEW.shop_id AND copy_key=NEW.request_id)
 BEGIN
  SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM n22_plangrant_commit_stage s JOIN n22_plangrant_previews p
     ON p.shop=s.shop AND p.actor=s.actor AND p.sid=s.sid AND p.mid=s.preview
   WHERE p.state='preview' AND p.product=s.product
     AND s.product=json_extract(NEW.receipt_json,'$.productId')
     AND json_extract(s.snapshot,'$.confirmedCopy')=json_extract(NEW.receipt_json,'$.text')
     AND json_extract(NEW.receipt_json,'$.status')='committed'
  ) THEN RAISE(ABORT,'PLANGRANT_ATOMIC_SCOPE') END;
  UPDATE n22_plangrant_grants SET state='superseded'
  WHERE state='active' AND (shop,product) IN (SELECT shop,product FROM n22_plangrant_commit_stage);
  INSERT INTO n22_plangrant_grants
   SELECT s.shop,s.actor,s.sid,s.product,json_extract(NEW.receipt_json,'$.productVersion'),
     s.version,s.confirmation,s.request,s.preview,'active',s.expires,
     json_set(s.snapshot,'$.productVersion',json_extract(NEW.receipt_json,'$.productVersion'),
       '$.copyId',json_extract(NEW.receipt_json,'$.copyId'),'$.copyVersion',json_extract(NEW.receipt_json,'$.copyVersion')),NULL
   FROM n22_plangrant_commit_stage s;
  UPDATE n22_plangrant_previews SET state='committed' WHERE (shop,actor,sid,mid) IN
   (SELECT shop,actor,sid,preview FROM n22_plangrant_commit_stage);
 END;`);
 const group=db.prepare('SELECT batch,assets FROM n22_write_groups WHERE id=? AND actor=? AND session=?');
 const getP=db.prepare('SELECT * FROM n22_plangrant_previews WHERE shop=? AND actor=? AND sid=? AND mid=?');
 const addP=db.prepare("INSERT INTO n22_plangrant_previews VALUES (?,?,?,?,?,'preview',?,?)");
 const cancelP=db.prepare("UPDATE n22_plangrant_previews SET state='canceled' WHERE shop=? AND actor=? AND sid=? AND mid=? AND state='preview'");
 const getG=db.prepare('SELECT * FROM n22_plangrant_grants WHERE shop=? AND actor=? AND sid=? AND confirmation=?');
 const byVersion=db.prepare('SELECT * FROM n22_plangrant_grants WHERE shop=? AND actor=? AND sid=? AND product=? AND pver=? ORDER BY version DESC LIMIT 1');
 const byPreview=db.prepare('SELECT * FROM n22_plangrant_grants WHERE shop=? AND actor=? AND sid=? AND preview=? ORDER BY version DESC LIMIT 1');
 const next=db.prepare('SELECT 1+coalesce(max(version),0) AS v FROM n22_plangrant_grants WHERE shop=? AND product=?');
 const stage=db.prepare('INSERT INTO n22_plangrant_commit_stage VALUES (1,?,?,?,?,?,?,?,?,?,?,?)');
 const unstage=db.prepare('DELETE FROM n22_plangrant_commit_stage WHERE k=1');
 const revoke=db.prepare("UPDATE n22_plangrant_grants SET state='revoked',revoked_at=? WHERE shop=? AND actor=? AND sid=? AND confirmation=? AND state='active'");
 const who=c=>[c.shopId,c.actorId,c.sessionId];
 const owner=c=>c?.shopId===storeId&&c.role==='owner'&&id(c.actorId)&&id(c.sessionId)&&isCurrentOwner(c.sessionId)===true;
 function originals(c,mid){
  const m=messages.restore(c,mid),ref=messages.reference(c,mid);
  const a=m?.status==='catalog_write_committed'&&m.actions?.length===1&&m.actions[0].action==='catalog_write'?m.actions[0].result:null;
  const r=a?.receipt;
  need(m?.messageId===mid&&same(m,ref,card)&&a?.operation==='create'&&r?.outcome==='created'&&
    same(ref,r,card.slice(1))&&r.groupVersion===1&&r.linkedAssetIds?.length===2,'PLANGRANT_P3_REFERENCE_REQUIRED',404);
  const cur=catalog.get(c,r.productId), g=group.get(r.groupId,c.actorId,c.sessionId);
  need(cur&&g&&p34.ownsBatch(c,g.batch)&&cur.assetIds?.length===2,'PLANGRANT_SOURCE_UNVERIFIED',403);
  const aa=JSON.parse(g.assets);
  need(aa.length===2&&new Set(aa.map(a=>a.sha256)).size===2&&aa.every(a=>
    approved.has(a.sha256)&&cur.assetIds.includes(a.assetId)&&r.linkedAssetIds.includes(a.assetId)),
    'PLANGRANT_SOURCE_UNVERIFIED',403);
  const summary=catalog.getSummary(c,r.productId);
  need(summary?.assetRefs?.length===2,'PLANGRANT_SOURCE_UNVERIFIED',403);
  for(const a of aa){
    need(summary.assetRefs.some(q=>q.assetId===a.assetId&&q.groupId===r.groupId&&q.groupVersion===r.groupVersion&&q.decisionSource==='owner_confirmed'),
      'PLANGRANT_SOURCE_UNVERIFIED',403);
    const b=album.readAuthorizedAsset(c,g.batch,a.assetId);
    need(Buffer.isBuffer(b?.bytes)&&b.mime==='image/png'&&hash(b.bytes)===a.sha256,'PLANGRANT_ORIGINAL_CHANGED',409);
  }
  return {cur,assets:aa.map(a=>({...a,batchId:g.batch,groupId:r.groupId,groupVersion:r.groupVersion})),p3Version:r.productVersion};
 }
 const wire=(c,x,status,action,result,p)=>({shopId:c.shopId,requestId:x.requestId,messageId:x.messageId,status,
  ...(p?{productId:p.productId,productVersion:p.productVersion}:{}),actions:[{action,status,result}]});
 const target=(g)=>{const s=JSON.parse(g.snapshot);return {productId:s.productId,productVersion:s.productVersion};};
 function readContentPlanningGrant(c,q){
  if(!owner(c))return null;
  const g=byVersion.get(...who(c),q.productId,q.productVersion);
  if(!g)return null;
  const s=JSON.parse(g.snapshot);
  const message=messages.restore(c,g.confirmation),ref=messages.reference(c,g.confirmation);
  // Catalog+grant are atomic. The separate message database may not yet have
  // finalized after a crash; that grant remains unusable, never inferred.
  if(message?.status!=='planning_grant_committed'||message.requestId!==g.request||message.messageId!==g.confirmation||
     !same(ref,s,card)||!same(message,s,card))return null;
  if(g.state!=='active'||g.expires<=clock())return {...s,status:g.state==='revoked'?'revoked':'expired',
    ...(g.revoked_at?{revokedAt:iso(g.revoked_at)}:{})};
  try{const o=originals(c,s.p3MessageId);if(!same(o.cur,s,['productId','productVersion','copyId','copyVersion'])||
    o.cur.copyText!==s.confirmedCopy||JSON.stringify(o.assets)!==JSON.stringify(s.originals))return null;}
  catch(e){if(e.httpStatus)return null;throw e;}
  const {originals:_,...publicForContent}=s;
  return {...publicForContent,status:'active'};
 }
 function turn(c,x){
  const m=/^预览这两张图的本店内容用途；说明「([^「」\r\n]+)」[。]?$/u.exec(x.text.trim());
  const command=x.text.trim().replace(/[。！？]$/u,'');
  if(!m&&!['确认本地内容用途','撤回本地内容用途','取消本地内容预览'].includes(command))return null;
  need(owner(c),'PLANGRANT_OWNER_REQUIRED',403);
  need(id(x.replyToMessageId)&&x.replyToMessageId!==x.messageId&&x.batchId===undefined,'PLANGRANT_EXACT_REPLY_REQUIRED',400);
  const mid=x.replyToMessageId,k=who(c);
  if(m){
   const text=m[1];
   need(text.trim()===text&&[...text].length<=180&&!/[\u0000-\u001f\u007f]/u.test(text),'PLANGRANT_COPY_INVALID',400);
   const o=originals(c,mid);
   const p={p3MessageId:mid,p3ProductVersion:o.p3Version,productId:o.cur.productId,
    productVersion:o.cur.productVersion,text,assets:o.assets};
   const expires=clock()+previewTtlMs;
   addP.run(...k,x.messageId,p.productId,expires,JSON.stringify(p));
   messages.setProduct(c,x.messageId,p,false);
   return wire(c,x,'planning_grant_preview','planning_grant_preview',{
    effective:false,purpose,previewMessageId:x.messageId,expiresAt:iso(expires),confirmedCopy:text,p3MessageId:mid,
    assets:p.assets.map(({assetId,batchId,sha256})=>({assetId,batchId,sha256})),deliveryStatus:'not_submitted'},p);
  }
  if(command==='撤回本地内容用途'){
   const g=getG.get(...k,mid);
   need(g&&messages.restore(c,mid)?.status==='planning_grant_committed','PLANGRANT_CONFIRMATION_NOT_AVAILABLE',404);
   const p=target(g);
   if(g.state==='active')need(revoke.run(clock(),...k,mid).changes===1,'PLANGRANT_STATE_CHANGED');
   else need(g.state==='revoked','PLANGRANT_STATE_CHANGED');
   messages.setProduct(c,x.messageId,p,false);
   return wire(c,x,'planning_grant_revoked','planning_grant_revoked',{grantVersion:g.version,effective:false,deliveryStatus:'not_submitted'},p);
  }
  const v=getP.get(...k,mid);
  const m0=messages.restore(c,mid);
  need(v&&m0?.status==='planning_grant_preview'&&m0.messageId===mid,'PLANGRANT_PREVIEW_NOT_AVAILABLE',404);
  const p=JSON.parse(v.spec);
  need(same(m0,p,card.slice(1))&&same(messages.reference(c,mid),p,card.slice(1)),'PLANGRANT_PREVIEW_NOT_AVAILABLE',404);
  if(command==='取消本地内容预览'){
   need(cancelP.run(...k,mid).changes===1,'PLANGRANT_PREVIEW_NOT_ACTIVE');
   return wire(c,x,'planning_grant_preview_canceled','planning_grant_preview_canceled',{effective:false,deliveryStatus:'not_submitted'},p);
  }
  if(v.state==='committed'){
   const g=byPreview.get(...k,mid);need(g,'PLANGRANT_STATE_CHANGED');
   return wire(c,x,'planning_grant_already_confirmed','planning_grant_already_confirmed',
    {confirmationMessageId:g.confirmation,grantVersion:g.version,deliveryStatus:'not_submitted'},target(g));
  }
  need(v.state==='preview','PLANGRANT_PREVIEW_NOT_ACTIVE');
  need(v.expires>clock(),'PLANGRANT_PREVIEW_EXPIRED');
  const o=originals(c,p.p3MessageId);
  need(o.cur.productVersion===p.productVersion&&o.cur.productId===p.productId&&
    JSON.stringify(o.assets)===JSON.stringify(p.assets),'PLANGRANT_CARD_OR_ASSETS_CHANGED');
  const grantVersion=next.get(c.shopId,p.productId).v;
  const expires=clock()+grantTtlMs, grantId=randomUUID(), copyKey='pg-'+randomUUID();
  const snap={shopId:c.shopId,actorId:c.actorId,sessionId:c.sessionId,productId:p.productId,purpose,
   p3MessageId:p.p3MessageId,p3ProductVersion:p.p3ProductVersion,consentMessageId:x.messageId,
   confirmedCopy:p.text,preferenceId:'self-drawn-portrait-v1',preferenceVersion:1,expiresAt:iso(expires),
   originals:p.assets,assets:p.assets.map(({assetId,batchId,sha256})=>({assetId,batchId,sha256,grantId,grantVersion}))};
  stage.run(...k,p.productId,mid,x.messageId,x.requestId,copyKey,grantVersion,expires,JSON.stringify(snap));
  let copy;
  try{copy=catalog.saveCopy(c,{requestId:copyKey,productId:p.productId,expectedVersion:p.productVersion,text:p.text});}
  finally{unstage.run();}
  const g=getG.get(...k,x.messageId);
  need(g?.pver===copy.productVersion&&g?.version===grantVersion,'PLANGRANT_COMMIT_INCOMPLETE',503);
  const pin=target(g);
  messages.setProduct(c,x.messageId,pin,false);
  return wire(c,x,'planning_grant_committed','planning_grant_committed',
   {purpose,copyId:copy.copyId,copyVersion:copy.copyVersion,grantVersion,expiresAt:iso(expires),
    confirmationMessageId:x.messageId,p3MessageId:p.p3MessageId,
    currentStatusRequiresLiveRead:true,deliveryStatus:'not_submitted'},pin);
 }
 return Object.freeze({turn,readContentPlanningGrant});
}
