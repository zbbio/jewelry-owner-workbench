import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createCatalog } from '../catalog/index.mjs';

const mod = new URL('../catalog/index.mjs', import.meta.url).href;
const A = {shopId:'SYN-A',actorId:'SYN-owner-A'}, B = {shopId:'SYN-B',actorId:'SYN-owner-B'};
const owned = (ctx, asset) => ['SYN-A','SYN-B'].includes(ctx.shopId) && ['ring1','ring2','angle','loose','winner1','winner2'].includes(asset);
const grp = (requestId, groupId, keptAssetIds, extra={})=>({requestId,taskId:'synthetic-night',groupId,groupVersion:1,keptAssetIds,decisionSource:'owner_confirmed',evidenceRef:'synthetic:'+groupId,...extra});
const code = n=>e=>e.code===n;
function f(t) {
  const dir=mkdtempSync(join(tmpdir(),'night-catalog-fixture-')), file=join(dir,'test.sqlite'); const live=new Set();
  const close=db=>{if(live.delete(db)) db.close()};
  const open=()=>{const db=new DatabaseSync(file);live.add(db);db.exec('PRAGMA busy_timeout=2000');return {db, c:createCatalog({db,hasAsset:owned})}};
  t.after(()=>{for(const db of live) close(db); for(const n of readdirSync(dir)) {assert.match(n,/^test\.sqlite(?:-journal|-wal|-shm)?$/);unlinkSync(join(dir,n))} rmdirSync(dir)});
  return {close,open,file};
}
function integrity(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  for(const sql of [
    'SELECT count(*) n FROM catalog_groups g LEFT JOIN catalog_products p USING(shop_id,product_id) WHERE p.product_id IS NULL',
    'SELECT count(*) n FROM catalog_product_assets a LEFT JOIN catalog_products p USING(shop_id,product_id) WHERE p.product_id IS NULL',
    "SELECT count(*) n FROM catalog_receipts r LEFT JOIN catalog_products p ON p.shop_id=r.shop_id AND p.product_id=json_extract(r.receipt_json,'$.productId') WHERE p.product_id IS NULL",
    'SELECT count(*) n FROM (SELECT shop_id,asset_id FROM catalog_product_assets GROUP BY shop_id,asset_id HAVING count(distinct product_id)>1)'
  ]) assert.equal(db.prepare(sql).get().n,0,sql);
}
test('file DB: two similar items, same-snapshot replay, partial rollback, two shops and reconnect',t=>{
  const ff=f(t); const {db,c}=ff.open();
  const create=grp('same-id','gz',['ring1']); const x=c.acceptGroup(A,create);
  const y=c.acceptGroup(A,grp('sibling','gy',['ring2'])); assert.notEqual(x.productId,y.productId);
  const secondShop=c.acceptGroup(B,create); assert.notEqual(secondShop.productId,x.productId);
  assert.equal(c.get(A,secondShop.productId),null);
  const q=db.prepare('SELECT count(*) n FROM catalog_products'); assert.equal(q.get().n,3);
  const supplement=grp('append','gz',['ring1','angle'],{groupVersion:2,targetProductId:x.productId,expectedVersion:1});
  const rec=c.acceptGroup(A,supplement); assert.deepEqual([rec.outcome,rec.productVersion,rec.addedAssetIds],['images_added',2,['angle']]);
  assert.deepEqual(c.acceptGroup(A,supplement),rec);
  const repeat=c.acceptGroup(A,{...supplement,requestId:'new-id-same-data'});assert.deepEqual([repeat.outcome,repeat.productVersion,repeat.addedAssetIds],['unchanged',2,[]]);
  assert.throws(()=>c.acceptGroup(A,{...supplement,evidenceRef:'changed'}),code('IDEMPOTENCY_CONFLICT'));
  // 'loose' would be added before the colliding second asset, and a third card would have been allocated.
  assert.throws(()=>c.acceptGroup(A,grp('invalid-partial','new-group',['loose','ring2'])),code('ASSET_PRODUCT_CONFLICT'));
  assert.throws(()=>c.acceptGroup(A,grp('bad-existing','new-extra',['loose','ring2'],{targetProductId:x.productId,expectedVersion:2})),code('ASSET_PRODUCT_CONFLICT'));
  assert.equal(q.get().n,3); assert.equal(db.prepare("SELECT count(*) n FROM catalog_product_assets WHERE asset_id='loose'").get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM catalog_groups WHERE group_id IN('new-group','new-extra')").get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM catalog_receipts WHERE request_id IN('invalid-partial','bad-existing')").get().n,0);
  integrity(db); ff.close(db);
  const fresh=ff.open(); assert.deepEqual(fresh.c.acceptGroup(A,create),x); assert.deepEqual(fresh.c.acceptGroup(B,create),secondShop);assert.deepEqual(fresh.c.acceptGroup(A,supplement),rec);
  assert.deepEqual(fresh.c.get(A,y.productId).assetIds,['ring2']); assert.equal(fresh.c.get(A,y.productId).productVersion,1);
  assert.deepEqual(fresh.c.get(A,x.productId).assetIds,['ring1','angle']);assert.equal(fresh.c.get(A,x.productId).productVersion,2);
  assert.equal(fresh.db.prepare('SELECT count(*) n FROM catalog_receipts').get().n,5);integrity(fresh.db);
});
test('no-op repeat cannot claim a version the card never had',t=>{
  const {db,c}=f(t).open();const x=c.acceptGroup(A,grp('a','g',['ring1']));
  assert.throws(()=>c.acceptGroup(A,grp('future','g',['ring1'],{targetProductId:x.productId,expectedVersion:2})),code('VERSION_CONFLICT'));
  assert.equal(db.prepare("SELECT count(*) n FROM catalog_receipts WHERE request_id='future'").get().n,0);integrity(db);
});
test('source on a linked asset does not drift on supplement or on a duplicate under an earlier group name',t=>{
  const ff=f(t);const {db,c}=ff.open();const x=c.acceptGroup(A,grp('a','zz-first',['ring1']));
  const initial=c.getSummary(A,x.productId).assetRefs[0];
  c.acceptGroup(A,grp('ap','zz-first',['ring1','angle'],{groupVersion:2,evidenceRef:'proof-angle-only',targetProductId:x.productId,expectedVersion:1}));
  const after=c.getSummary(A,x.productId); assert.deepEqual(after.assetRefs[0],initial);
  assert.equal(after.assetRefs[1].groupVersion,2);assert.equal(after.assetRefs[1].evidenceRef,'proof-angle-only');
  const dup=c.acceptGroup(A,grp('dupe','aa-duplicate',['ring1'],{targetProductId:x.productId,expectedVersion:2}));
  assert.deepEqual([dup.outcome,dup.productVersion],['unchanged',2]);
  assert.deepEqual(c.getSummary(A,x.productId),after);
  ff.close(db);const fresh=ff.open();assert.deepEqual(fresh.c.getSummary(A,x.productId),after);integrity(fresh.db);
});
test('two independent SQLite writers start at same version; one commits and other receives version conflict',async t=>{
  const ff=f(t); const {db,c}=ff.open();const x=c.acceptGroup(A,grp('a','ga',['ring1']));
  const y=c.acceptGroup(A,grp('b','gb',['ring2']));
  const source=`
   const {parentPort:p,workerData:w}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite');
   (async()=>{const {createCatalog}=await import(w.mod);const db=new DatabaseSync(w.file);db.exec('PRAGMA busy_timeout=4000');
    const cat=createCatalog({db,hasAsset:()=>true});p.once('message',()=>{try{const receipt=cat.acceptGroup(w.ctx,w.req);p.postMessage({result:'ok',receipt})}catch(e){p.postMessage({result:e.code||e.message})}finally{db.close()}});p.postMessage({ready:true});})().catch(e=>{throw e});`;
  const make=(i)=>{const req=grp('concurrent-'+i,'gc-'+i,['winner'+i],{targetProductId:x.productId,expectedVersion:1});
    const worker=new Worker(source,{eval:true,workerData:{file:ff.file,ctx:A,req,mod}});t.after(()=>worker.terminate());
    return worker;
  };
  const once=(w)=>new Promise((yes,no)=>{w.once('message',yes);w.once('error',no);});
  const workers=[make(1),make(2)];assert.deepEqual(await Promise.all(workers.map(once)),[{ready:true},{ready:true}]);
  const out=workers.map(once);workers.forEach(w=>w.postMessage('go'));const results=await Promise.all(out);
  assert.deepEqual(results.map(r=>r.result).sort(),['VERSION_CONFLICT','ok']);
  const winner=results.find(r=>r.result==='ok').receipt;
  assert.deepEqual(c.get(A,x.productId).assetIds,['ring1',...winner.addedAssetIds]);assert.equal(c.get(A,x.productId).productVersion,2);
  assert.deepEqual(c.get(A,y.productId).assetIds,['ring2']);
  assert.equal(db.prepare("SELECT count(*) n FROM catalog_receipts WHERE request_id LIKE 'concurrent-%'").get().n,1);integrity(db);
});
