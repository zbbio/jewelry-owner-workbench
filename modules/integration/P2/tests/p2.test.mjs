import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID as uid} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.env.P2_TEST_ROOT), imp=p=>import(pathToFileURL(join(root,p)).href);
const [{createCatalog},{createP34Write},{createP2Confirmations}]=await Promise.all(
  ['app/店主工作台/catalog/index.mjs','backend/p34-write.mjs','backend/p2-confirmations.mjs'].map(imp));
const c={shopId:'test-p2-store',actorId:'owner',sessionId:'test-login',role:'owner',expiresAt:new Date(Date.now()+1200000).toISOString()}, pid=uid();
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const catalog=createCatalog({db,hasAsset:()=>false});
 db.prepare('INSERT INTO catalog_products(shop_id,product_id,product_version,fields_json) VALUES(?,?,?,?)')
  .run(c.shopId,pid,1,'{}');
 let active=true,decisionAllowed=true,now=Date.now();
 const write=createP34Write({db,catalog,storeId:c.shopId,album:{},draftJoin:false,isCurrentOwner:id=>active&&id===c.sessionId,
   readReference:()=>null,readMessage:()=>null});
 let p=createP2Confirmations({db,catalogWrite:write,isLiveOwner:()=>active,clock:()=>now,
  ttlMs:100,canDecide:()=>decisionAllowed});
 async function ownerAsks(text='把卡号 '+pid+' 的售价改为 85.17 元'){
  const scope={conversationId:uid(),messageId:uid(),runId:uid()};
  const d=await write.previewForConfirmation(c,{text,messageId:scope.messageId},()=>null);
  return p.register(c,scope,d);
 }
 async function send(ticket,verb,who=c,requestId=uid()){
  const path='/api/n22/confirmations/'+ticket.confirmationId+'/'+verb;
  let response;
  await p.route(path,'POST',who,()=>({source:ticket.source,reviewDigest:ticket.reviewDigest,requestId}),
   (http,data)=>{response={http,data};},{url:path});
  return response;
 }
 const count=()=>db.prepare("select count(*) as n from catalog_receipts where operation='update'").get().n;
 return {ownerAsks,send,catalog,count,legacy:t=>write.execute(c,{text:"确认 "+t.confirmationId,replyToMessageId:t.source.messageId,messageId:uid()}),view:t=>p.forMessage(c,t.source)[0], setClock:t=>{now=t;}, revoke:()=>{decisionAllowed=false;},exit:()=>{active=false;}};
}
test('owner asks to change this practice card; only explicit click writes once; same message keeps the ticket',async t=>{
 const f=fixture(t),a=await f.ownerAsks();
 assert.equal(a.status,'pending');assert.deepEqual(a,f.view(a));assert.equal(f.count(),0);
 const action=uid();const b=await f.send(a,'confirm',c,action),copy=await f.send(a,'confirm',c,action);
 assert.equal(b.http,200);assert.equal(b.data.receipt.productVersion,2);assert.equal(copy.data.replay,true);
 assert.deepEqual(b.data.receipt,copy.data.receipt);assert.equal(f.count(),1);
 assert.equal(f.catalog.get(c,pid).fields.price.value,'85.17');assert.deepEqual(f.view(a),b.data);
});
test('exact deadline refuses; no catalog writes',async t=>{
 const f=fixture(t),a=await f.ownerAsks();
 f.setClock(Date.parse(a.expiresAt));
 assert.equal(f.view(a).status,'expired');
 assert.deepEqual(await f.send(a,'confirm'),{http:409,data:{error:{code:'CONFIRMATION_EXPIRED'}}});assert.equal(f.count(),0);
});
test('revoked object scope hides preview; logout and foreign identity are denied; zero writes',async t=>{
 const f=fixture(t),a=await f.ownerAsks();
 assert.equal((await f.send(a,'confirm',{...c,shopId:'not-this-shop'})).http,404);
 assert.equal((await f.send(a,'confirm',{...c,actorId:'not-this-person'})).http,404);
 f.revoke(); assert.equal(f.view(a).preview,null);
 assert.deepEqual(await f.send(a,'confirm'),{http:403,data:{error:{code:'CONFIRMATION_REVOKED'}}});
 f.exit();assert.deepEqual(await f.send(a,'confirm'),{http:401,data:{error:{code:'PRACTICE_OWNER_REQUIRED'}}});
 assert.equal(f.count(),0);
});
test('cancel cannot apply; a competing confirmed version does not get overwritten',async t=>{
 const f=fixture(t),a=await f.ownerAsks(),b=await f.ownerAsks(),d=await f.ownerAsks();
 assert.equal((await f.send(a,'cancel')).data.status,'canceled');assert.equal(f.count(),0);
 assert.equal((await f.send(b,'confirm')).data.status,'confirmed');
 assert.deepEqual(await f.send(d,'confirm'),{http:409,data:{error:{code:'CONFIRMATION_VERSION_CHANGED'}}});
 assert.equal(f.count(),1);
});

test('legacy ordinary text cannot consume a unified ticket; explicit size confirmation reuses real field/unit validation',async t=>{
 const f=fixture(t),a=await f.ownerAsks('把卡号 '+pid+' 的尺寸改为 168 mm');
 assert.deepEqual(a.preview,{field:'size',before:null,after:{value:'168',unit:'mm'}});
 assert.throws(()=>f.legacy(a),{code:'P2_EXPLICIT_CONFIRMATION_REQUIRED'});
 assert.equal(f.count(),0);
 assert.equal((await f.send(a,'confirm')).http,200);
 const sz=f.catalog.get(c,pid).fields.size;assert.equal(sz.value,'168');assert.equal(sz.unit,'mm');assert.equal(f.count(),1);
});
