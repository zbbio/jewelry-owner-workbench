import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCatalog} from '../catalog/index.mjs';
const ctx={shopId:'shop-one',actorId:'owner'},scope2={shopId:'other',actorId:'owner'};
const body=(id,group,assets,more={})=>({requestId:id,taskId:'tray-session',groupId:group,groupVersion:1,keptAssetIds:assets,decisionSource:'system_checked',evidenceRef:'judgment:'+group,...more});
const fixture=t=>{const db=new DatabaseSync(':memory:');t.after(()=>db.close());const known=new Set(['v1','v2','v3','v4','v5','v6']);const cat=createCatalog({db,hasAsset:(c,i)=>c.shopId===ctx.shopId&&known.has(i)});const state=()=>Object.fromEntries(['catalog_products','catalog_product_assets','catalog_groups','catalog_receipts'].map(n=>[n,db.prepare('select count(*) as n from '+n).get().n]));return {cat,state}};
test('N2: unresolved co-display does not create cards nor hand off to sale/content; two resolved items get disjoint cards',t=>{
 const {cat,state}=fixture(t);const initial=state();
 for(const src of ['pending','uncertain','same_tray',null])assert.throws(()=>cat.acceptGroup(ctx,body('uncertain','batch',['v1','v2'],{decisionSource:src})));
 assert.deepEqual(state(),initial);assert.deepEqual(cat.list(ctx),[]);
 const ga=body('01','ga',['v1','v3']),gb=body('02','gb',['v2','v4']);
 const a=cat.acceptGroup(ctx,ga),b=cat.acceptGroup(ctx,gb);assert.notEqual(a.productId,b.productId);assert.deepEqual(cat.acceptGroup(ctx,ga),a);
 assert.deepEqual(cat.getSummary(ctx,a.productId).assetRefs.map(x=>x.assetId),['v1','v3']);assert.deepEqual(cat.getSummary(ctx,b.productId).assetRefs.map(x=>x.assetId),['v2','v4']);assert.equal(cat.getSummary(scope2,a.productId),null);
});
test('N2: contaminated supplement rolls back before any new view or receipt persists; clean supplements stay on original IDs',t=>{
 const {cat,state}=fixture(t);const a=cat.acceptGroup(ctx,body('01','ga',['v1','v3'])),b=cat.acceptGroup(ctx,body('02','gb',['v2','v4']));
 const prior=state(),was=cat.getSummary(ctx,a.productId);
 assert.throws(()=>cat.acceptGroup(ctx,body('mixed','newset',['v5','v4'],{targetProductId:a.productId,expectedVersion:1})),e=>e.code==='ASSET_PRODUCT_CONFLICT');
 assert.deepEqual(state(),prior);assert.deepEqual(cat.getSummary(ctx,a.productId),was);
 const plus=(id,g,v,p)=>body(id,g,[v],{targetProductId:p,expectedVersion:1});const r=plus('a5','ga5','v5',a.productId),s=plus('b6','gb6','v6',b.productId);
 const ra=cat.acceptGroup(ctx,r),rb=cat.acceptGroup(ctx,s);assert.deepEqual(cat.acceptGroup(ctx,s),rb);assert.deepEqual(cat.acceptGroup(ctx,r),ra);assert.equal(ra.productId,a.productId);assert.equal(rb.productId,b.productId);
 assert.equal(cat.list(ctx).length,2);assert.deepEqual(cat.getSummary(ctx,a.productId).assetRefs.map(x=>x.assetId),['v1','v3','v5']);assert.deepEqual(cat.getSummary(ctx,b.productId).assetRefs.map(x=>x.assetId),['v2','v4','v6']);
});
