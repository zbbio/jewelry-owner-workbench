import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPracticePlanAdapter} from './practice-plan-adapter.mjs';
import {material} from '../C2/fixture.mjs';
import {parseD3Command} from './执行基线-r2/app/a/b/c/销售仓/d3-turn.mjs';
import {createMessageLedger} from './执行基线-r2/backend/message-ledger.mjs';

const mk=(id,text,replyToMessageId)=>({requestId:'req-'+id,messageId:id,text,replyToMessageId});
const lines=['给刚明确引用的新练习C准备两个风格，先别做','把第二套第一镜的字幕改成“先看自绘纹路”','取消这套分镜'];
const denied=(fn,code)=>assert.throws(fn,e=>e.code===code);
const results=[];
const find=x=>x.actions[0].result;
const tables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x=>x.name);
function env(t){
 const db=new DatabaseSync(':memory:'); const ledger=createMessageLedger(':memory:');
 t.after(()=>{ledger.close();db.close();});
 const c={shopId:'unit-practice',actorId:'unit-owner',sessionId:'unit-practice-scope',role:'owner'};
 const q={shopId:c.shopId,productId:'unit-new-C',productVersion:2}, p3={...q,productVersion:1};
 const time=Date.parse('2026-11-25T01:00:00Z');
 const grant={...c,...q,purpose:'local_content_only',status:'active',expiresAt:new Date(time+60_000).toISOString(),consentMessageId:'consent-C',
   p3MessageId:'p3-C',p3ProductVersion:1,copyId:'confirmed-copy-C',copyVersion:1,confirmedCopy:'自绘几何测试件',
   preferenceId:'fixture-style',preferenceVersion:1,
   assets:material.slice(0,2).map(({assetId,sha256})=>({assetId,batchId:'batch-unit-C',grantId:'grant-unit-C',grantVersion:1,sha256}))};
 const product={...q,assetIds:grant.assets.map(x=>x.assetId),copyId:grant.copyId,copyVersion:grant.copyVersion,
   copyText:grant.confirmedCopy,copyProductVersion:q.productVersion,copyConfirmedBy:c.actorId,copyConfirmedAt:new Date(time).toISOString()};
 const settings={live:true,time,grant,product,mediaReads:0,invalidBytes:false,noCopy:false,p3Wrong:false};
 const port={
  db,practiceShopId:c.shopId,parseD3:parseD3Command,clock:()=>settings.time,
  isPracticeOwner:ctx=>settings.live&&['shopId','actorId','sessionId'].every(k=>ctx[k]===c[k]),
  readMessage:ledger.reference,
  catalog:{get(ctx,pid){return pid===q.productId&&ctx.shopId===c.shopId?
    {...settings.product,...(settings.noCopy?{copyConfirmedAt:null}:{})}:null;}},
  readPlanningGrant(ctx,p){return p.productId===q.productId&&p.productVersion===q.productVersion?settings.grant:null;},
  readP3Commit(ctx,mid){
    const r=ledger.restore(ctx,mid);
    return r&&settings.p3Wrong?{...r,sessionId:'wrong'}:r;
  },
  readAlbumAsset(ctx,batch,asset){
    settings.mediaReads++;
    const a=batch==='batch-unit-C'&&material.slice(0,2).find(i=>i.assetId===asset);
    return a&&{bytes:settings.invalidBytes?material[2].bytes:a.bytes,mime:a.mime};
  }
 };
 let adapter=createPracticePlanAdapter(port);
 const ref=(id,p,obj)=>ledger.execute(c,mk(id,'unit authoritative record'),()=>{
   ledger.setProduct(c,id,p,false);return obj;
 });
 const init=async()=>{await ref('p3-C',p3,{...c,...p3,messageId:'p3-C',status:'catalog_write_committed',operation:'create'});
   await ref('consent-C',q,{...q,status:'planning_grant_committed'});};
 const dispatch=(x,p=q)=>ledger.execute(c,x,()=>{
   ledger.setProduct(c,x.messageId,p,false);
   return adapter.turn(c,x,p);
 }).then(r=>adapter.present(c,r));
 const count=()=>['n22_resumec2_turns','n22_c2_plan_versions'].map(n=>db.prepare('SELECT count(*) n FROM '+n).get().n);
 return {db,ledger,c,q,p3,port,settings,init,ref,dispatch,count,
   bootAgain(){adapter=createPracticePlanAdapter(port);return adapter;}, get adapter(){return adapter;}};
}
test('real C2, frozen sales parser and original message ledger: 2x2, idempotent, one exact subtitle, cancel',async t=>{
 const e=env(t);await e.init();
 assert.deepEqual(e.adapter.capability(e.c),{mode:'isolated_prepare_edit_only',prepare:true,production:false});
 const prep=mk('turn-prep',lines[0],'consent-C');
 const out=await e.dispatch(prep), a=find(out);
 assert.equal(out.actions[0].action,'content_prepare');
 assert.equal(out.actions[0].status,'drafts_ready');
 assert.deepEqual(a.plans.map(p=>p.shots.length),[2,2]);
 assert.deepEqual(a.plans.map(p=>new Set(p.shots.map(s=>s.assetId))),[new Set(e.settings.product.assetIds),new Set(e.settings.product.assetIds)]);
 assert.deepEqual(e.count(),[1,1]);
 assert.deepEqual(await e.dispatch(prep),{...out,replay:true});
 assert.deepEqual(e.adapter.turn(e.c,prep,e.q),{...out,replay:true});
 denied(()=>e.adapter.turn(e.c,{...prep,text:'给C准备两种风格，先别制作'},e.q),'MESSAGE_REUSE_CONFLICT');
 assert.deepEqual(e.count(),[1,1]);
 const change=mk('turn-edit',lines[1],'turn-prep'), right=await e.dispatch(change), b=find(right);
 assert.equal(a.draftSetId,b.draftSetId);assert.equal(b.draftSetVersion,a.draftSetVersion+1);
 const expected=structuredClone(a.plans);expected[1].planVersion++;expected[1].shots[0].caption='先看自绘纹路';
 assert.deepEqual(b.plans,expected);
 assert.deepEqual(e.count(),[2,2]);
 denied(()=>e.adapter.restore(e.c,{messageId:'turn-prep'}),'C2_VERSION_CONFLICT');
 assert.deepEqual(e.bootAgain().restore(e.c,{messageId:'turn-edit'}),right);
 const end=await e.dispatch(mk('turn-cancel',lines[2],'turn-edit')), m=find(end);
 assert.equal(end.actions[0].status,'cancelled');
 assert.equal(m.cancelledVersion,b.draftSetVersion+1);assert.ok(!m.plans);
 assert.deepEqual(e.count(),[3,3]);
 await assert.rejects(e.dispatch(change),e=>e.code==='C2_SET_CANCELED');
 denied(()=>e.adapter.turn(e.c,mk('one-more',lines[0],'consent-C'),e.q),'C2_SET_CANCELED');
 e.settings.grant={...e.settings.grant,assets:e.settings.grant.assets.map(x=>({...x,grantVersion:2}))};
 denied(()=>e.adapter.turn(e.c,mk('old-consent-new-grant',lines[0],'consent-C'),e.q),'C2_SET_CANCELED');
 assert.deepEqual(tables(e.db),['n22_c2_plan_versions','n22_resumec2_turns']);
 assert.equal(e.ledger.authorize(e.c,{messageId:'turn-edit'}),null);
 assert.ok(!/workRef|taskId|previewUrl|https?:|sha256|grantId|batchId/u.test(JSON.stringify([out,right,end])));
 results.push({case:'authorized_synthetic_ports_with_real_C2_and_ledger',out,right,end,c2Rows:e.count(),tables:tables(e.db)});
});
test('no capability: disabled, wrong shop and session, no album read; confirm/adopt/publish never forward',async t=>{
 const e=env(t);await e.init();const x=mk('turn-prep',lines[0],'consent-C'), responses=[];
 for(const c of [{...e.c,shopId:'foreign'},{...e.c,sessionId:'old-session'}]){
  assert.deepEqual(e.adapter.capability(c),{mode:'not_enabled',prepare:false,production:false});
  const y=e.adapter.turn(c,x,e.q);assert.equal(y.code,'D3_STORE_NOT_ENABLED');assert.deepEqual(y.actions,[]);
  responses.push(y);
 }
 for(const [i,text] of ['确认按第二版做','采用这版作品','直接发布本件'].entries()){
  const y=e.adapter.turn(e.c,mk('blocked-'+i,text,'consent-C'),e.q);
  assert.equal(y.code,'D3_CARDPAGE_PREPARATION_ONLY');assert.deepEqual(y.actions,[]);
  responses.push(y);
 }
 e.settings.live=false;
 denied(()=>e.adapter.restore(e.c,{messageId:'turn-prep'}),'D3_STORE_NOT_ENABLED');
 assert.equal(e.settings.mediaReads,0);assert.deepEqual(e.count(),[0,0]);results.push({case:'scope_no_production',responses,mediaReads:0});
});
test('live approval required with current materials, copy, P3, card and version',async t=>{
 const e=env(t);await e.init(); const x=mk('turn-prep',lines[0],'consent-C'), baseline=e.settings.grant;
 denied(()=>e.adapter.turn(e.c,x,{...e.q,productId:'other-card'}),'D3_REFERENCE_CARD_CONFLICT');
 e.settings.product={...e.settings.product,productVersion:3};
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_PRODUCT_VERSION_CHANGED');
 e.settings.product.productVersion=2;
 e.settings.grant=null;
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_CARD2PLAN_PERMISSION_REQUIRED');
 e.settings.grant={...baseline,purpose:'browse_only'};
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_CARD2PLAN_PERMISSION_REQUIRED');
 e.settings.grant={...baseline,...{productId:'other-card'}};
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_CARD2PLAN_PERMISSION_REQUIRED');
 e.settings.grant=baseline;e.settings.noCopy=true;
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_CARD2PLAN_CONFIRMED_COPY_REQUIRED');
 e.settings.noCopy=false;e.settings.p3Wrong=true;
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_CARD2PLAN_REFERENCE_REQUIRED');
 e.settings.p3Wrong=false;e.settings.product.assetIds=[baseline.assets[0].assetId,'fixture-shot-3'];
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_CARD2PLAN_PERMISSION_REQUIRED');
 e.settings.product.assetIds=baseline.assets.map(i=>i.assetId);e.settings.invalidBytes=true;
 denied(()=>e.adapter.turn(e.c,x,e.q),'D3_CARD2PLAN_MEDIA_CHANGED');
 assert.deepEqual(e.count(),[0,0]);
 results.push({case:'wrong_card_version_grant_purpose_copy_p3_current_assets_or_changed_bytes',c2Rows:e.count()});
});
test('live recheck of stored reply: revoke, expire, source change and exit deny GET and ordinary ledger replay',async t=>{
 const e=env(t);await e.init();const x=mk('turn-prep',lines[0],'consent-C'), out=await e.dispatch(x);
 const baseline=e.settings.grant, now=e.settings.time;
 const cases=[
  ['D3_CARD2PLAN_PERMISSION_REVOKED',()=>{e.settings.grant={...baseline,status:'revoked'};}],
  ['D3_CARD2PLAN_PERMISSION_EXPIRED',()=>{e.settings.time=now+60001;}],
  ['D3_CARD2PLAN_MEDIA_CHANGED',()=>{e.settings.invalidBytes=true;}],
  ['D3_CARD2PLAN_REPREPARE_REQUIRED',()=>{e.settings.grant={...baseline,assets:baseline.assets.map(x=>({...x,grantVersion:2}))};}],
  ['D3_STORE_NOT_ENABLED',()=>{e.settings.live=false;}]
 ];
 for(const [code,update] of cases){
  Object.assign(e.settings,{grant:baseline,time:now,live:true,invalidBytes:false});update();
  denied(()=>e.adapter.restore(e.c,{messageId:x.messageId}),code);
  denied(()=>e.adapter.present(e.c,out),code);
  await assert.rejects(e.dispatch(x),e=>e.code===code);
 }
 assert.deepEqual(e.count(),[1,1]);
 results.push({case:'no_stale_restore_or_cached_reply',denied:cases.map(x=>x[0]),c2Rows:e.count()});
});
test('caption rejects 57 and accepts 56 with same source; nested savepoint failures preserve caller transaction',async t=>{
 const e=env(t);await e.init(); const x=mk('turn-prep',lines[0],'consent-C');
 const db=e.db;
 db.exec("CREATE TABLE parent(v); BEGIN; INSERT INTO parent VALUES(1); CREATE TEMP TRIGGER rejectTurn BEFORE INSERT ON n22_resumec2_turns BEGIN SELECT RAISE(ABORT,'unit fault'); END;");
 assert.throws(()=>e.adapter.turn(e.c,x,e.q),/unit fault/);
 assert.deepEqual(e.count(),[0,0]);
 assert.equal(db.prepare('SELECT count(*) n FROM parent').get().n,1);
 db.exec('DROP TRIGGER rejectTurn;');
 const out=e.adapter.turn(e.c,x,e.q);
 assert.deepEqual(find(out).plans.map(p=>p.shots.length),[2,2]);
 db.exec('COMMIT;');
 await e.ref('turn-prep',e.q,{status:'recorded-by-test-host'});
 db.exec('BEGIN; INSERT INTO parent VALUES(2);');
 const edit=(id,n)=>mk(id,'把第二套第一镜的字幕改成“'+'珠'.repeat(n)+'”','turn-prep');
 const bad=edit('one-edit',57);
 assert.throws(()=>e.adapter.turn(e.c,bad,e.q),e=>e.code==='CAPTION_TOO_LONG'&&e.captionCheck.used===57&&e.captionCheck.limit===56);
 assert.deepEqual(e.count(),[1,1]);
 const good=e.adapter.turn(e.c,edit('one-edit',56),e.q);
 assert.equal(find(good).plans[1].shots[0].caption.length,56);assert.deepEqual(e.count(),[2,2]);
 db.exec('ROLLBACK;');assert.deepEqual(e.count(),[1,1]);assert.equal(db.prepare('SELECT count(*) n FROM parent').get().n,1);
 results.push({case:'56_57_and_parent_transaction_preserved',c2RowsAfterParentRollback:e.count()});
});
test.after(()=>console.log('RESUMEC2_EVIDENCE '+JSON.stringify({results,videoCreated:0,workCreated:0,published:0,modelCalls:0,networkListenerCreated:0,
 level:'real isolated C2, C2TEXT and frozen ordinary ledger; trusted ports are synthetic in-process; not APPLOCAL integration'})));
