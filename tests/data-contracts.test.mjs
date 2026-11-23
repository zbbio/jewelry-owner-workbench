// Generated fixture IDs and adapter responses; no external services or data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCatalog } from '../catalog/index.mjs';
import { createSales } from '../sales/index.mjs';
import { createContent } from '../content/index.mjs';

const owner = {shopId:'contract-fixture-shop',actorId:'contract-fixture-owner'};
const outsider = {shopId:'other-contract-shop',actorId:'other-owner'};
function setup(t) {
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const fixtureAssetIds=new Set(['fixture-asset-one','fixture-asset-two']);
  const catalog=createCatalog({
    db,hasAsset:(ctx,id)=>ctx.shopId===owner.shopId&&fixtureAssetIds.has(id),
    canVerifyInventory:ctx=>ctx.shopId===owner.shopId&&ctx.actorId===owner.actorId,
  });
  const add=(label,asset)=>catalog.acceptGroup(owner,{
    requestId:'put-'+label,taskId:'synthetic-import',groupId:'fixture-'+label,groupVersion:1,
    keptAssetIds:[asset],decisionSource:'owner_confirmed',evidenceRef:'synthetic-evidence-'+label,
  });
  const item=add('one','fixture-asset-one'), control=add('two','fixture-asset-two');
  const media={mode:'no-inputs', probes:[]};
  const content=createContent({db,
    getProduct:(ctx,pid)=>catalog.getSummary(ctx,pid),
    listOldVideos:(_ctx,id)=>media.mode==='old-original'?[
      {shopId:outsider.shopId,productId:id,rights:'usable',workId:'outside-fixture-work',workVersion:1},
      {shopId:owner.shopId,productId:id,rights:'usable',workId:'fixture-owner-original',workVersion:3},
    ]:[],
    // Nothing here claims a real playable video or real upstream copy/preference.

    probeVideo:v=>{media.probes.push(v.workId);return v.workId==='fixture-owner-original';},
    resolveInputs:(_ctx,card)=>media.mode==='approved-fixtures'?{
      assets:card.assetRefs.map(x=>({kind:'product_shot',productId:card.productId,assetId:x.assetId,rights:'usable',digest:'fixture-digest-'+x.assetId})),
      copyId:'synthetic-copy-only',copyVersion:1,preferenceSnapshot:{theme:'neutral'},preferenceVersion:2,
    }:{assets:[]},
  });
  const sales=createSales({db,catalog,content}); // No alias/facade or fake card facts.
  const msg=(id,overrides={})=>({requestId:id,sessionId:'fixture-session',productId:item.productId,question:'请按本件已知资料回答。',...overrides});
  return {catalog,sales,content,media,item,control,msg,db};
}

test('真实商品→销售：未知库存建待办；店主更新后读新版本和实际字段值，另一张卡与旧问答不变',t=>{
  const {catalog,sales,item,control,msg}=setup(t);
  const old=sales.ask(owner,msg('question-1'));
  assert.deepEqual(old.productRef,{productId:item.productId,productVersion:1});
  assert.equal(old.inventoryState,'unknown');assert.equal(old.status,'needs_owner_action');
  assert.match(old.answer,/待核实|未核实/);assert.match(old.answer,/暂不承诺现货|不承诺现货/);
  assert.equal(old.taskIds.length,1);assert.ok(sales.listTasks(owner).find(x=>x.taskId===old.taskIds[0]));
  assert.equal(old.alternativeSearch.status,'directory_unavailable');
  const refreshed=catalog.update(owner,{requestId:'update-1',productId:item.productId,expectedVersion:1,
    changes:[{field:'title',value:'合成台账物件',source:'manual'},{field:'description',value:'人工记录字段甲',source:'manual'}],
    inventory:{status:'out_of_stock',quantity:0,evidenceRef:'synthetic-owner-stock-check'}});
  assert.equal(refreshed.productVersion,2);assert.equal(catalog.getSummary(owner,item.productId).inventory.quantity,0);
  const now=sales.ask(owner,msg('question-2'));assert.equal(now.productRef.productVersion,2);
  assert.equal(now.inventoryState,'out_of_stock');assert.equal(now.taskIds.length,0);
  assert.match(now.answer,/无货|缺货/);assert.match(now.answer,/合成台账物件/);
  assert.match(now.answer,/人工记录字段甲/);assert.doesNotMatch(now.answer,/\[object Object\]/);
  assert.deepEqual(sales.ask(owner,msg('question-1')),old);
  const second=sales.ask(owner,msg('question-3',{productId:control.productId}));
  assert.deepEqual(second.productRef,{productId:control.productId,productVersion:1});assert.equal(second.inventoryState,'unknown');
});

test('真实商品→内容：无本件素材与旧版请求分开，异店不可读',t=>{
  const {item,catalog,content}=setup(t);
  const input={requestId:'demand-alone',demand:'本件视频',productId:item.productId,productVersion:item.productVersion};
  const no=content.requestVideo(owner,input);
  assert.equal(no.outcome,'needs_source');assert.equal(no.productId,item.productId);assert.equal(no.deliveryStatus,'not_submitted');
  assert.ok(!no.taskId);assert.equal(no.requestId,input.requestId);
  assert.throws(()=>content.requestVideo(outsider,input),e=>e.code==='PRODUCT_NOT_FOUND');
  catalog.update(owner,{requestId:'update-v',productId:item.productId,expectedVersion:1,changes:[{field:'title',value:'版本变更',source:'manual'}]});
  const stale=content.requestVideo(owner,{...input,requestId:'different-op-with-stale-version'});
  assert.equal(stale.outcome,'needs_review');assert.ok(!stale.workRef&&!stale.taskId);
});

test('真实销售→内容同库：缺素材、获准旧片、合成制作输入排队；重放不重复制作也不标发送',t=>{
  const {sales,content,media,item,msg,db}=setup(t);
  const video=(id)=>msg(id,{question:'看本件视频',needVideo:true});
  const result=sales.ask(owner,video('v-no'));assert.equal(result.video.outcome,'needs_source');
  assert.equal(result.video.productId,item.productId);assert.equal(result.video.productVersion,1);assert.ok(result.video.requestId);
  assert.equal(result.video.taskId,undefined);assert.equal(result.video.deliveryStatus,'not_submitted');
  media.mode='old-original';
  const old=sales.ask(owner,video('v-existing')).video;assert.equal(old.outcome,'existing_available');
  assert.equal(old.productId,item.productId);assert.deepEqual(old.workRef,{workId:'fixture-owner-original',workVersion:3});
  assert.equal(old.retrievalStatus,'playable');assert.equal(old.deliveryStatus,'not_submitted');assert.ok(!old.taskId);
  assert.deepEqual(media.probes,['fixture-owner-original']);
  media.mode='approved-fixtures';
  const queued=sales.ask(owner,video('v-queued')).video;assert.equal(queued.outcome,'queued');assert.ok(queued.taskId);
  assert.equal(queued.productId,item.productId);assert.equal(queued.deliveryStatus,'not_submitted');
  const task=content.getTask(owner,queued.taskId);assert.equal(task.productId,item.productId);assert.equal(task.status,'queued');
  assert.equal(task.lockedInputs.assets[0].assetId,'fixture-asset-one');
  assert.deepEqual(sales.ask(owner,video('v-queued')).video,queued);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_tasks').get().n,1);
  assert.throws(()=>content.getTask(outsider,queued.taskId),e=>e.code==='TASK_NOT_FOUND');
});
