import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCatalog } from '../catalog/index.mjs';
import { createSales } from '../sales/index.mjs';
import { createContent } from '../content/index.mjs';

// Independent invented twins, NOT images, a real inventory, or an album accuracy test.
const owner = { shopId: 'n2-fixture-shop', actorId: 'n2-fixture-owner' };
const question = '这件多少钱？有货吗？能看本件视频吗？';
function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const photos = new Set(['tray-left-photo', 'tray-right-photo']);
  const catalog = createCatalog({ db, hasAsset: (_ctx, id) => photos.has(id), canVerifyInventory: () => true });
  const create = (side, price, quantity) => {
    const groupId = 'tray-' + side + '-group', assetId = 'tray-' + side + '-photo';
    const { productId } = catalog.acceptGroup(owner, { requestId: groupId, groupId, taskId: 'shared-tray',
      groupVersion: 1, keptAssetIds: [assetId], decisionSource: 'owner_confirmed', evidenceRef: 'fixture-' + side });
    catalog.update(owner, { requestId: side + '-facts', productId, expectedVersion: 1, changes: [
      { field: 'title', source: 'manual', value: '同托板白色圆珠手串' },
      { field: 'price', source: 'manual', value: price, unit: '元' }],
      inventory: { status: quantity ? 'in_stock' : 'out_of_stock', quantity, evidenceRef: 'stock-' + side } });
    return { productId, groupId, assetId };
  };
  const a = create('left', 183, 1), b = create('right', 947, 0), history = [];
  const oldClips = [{ shopId: owner.shopId, productId: a.productId, workId: 'clip-left', workVersion: 4, rights: 'usable' }];
  const content = createContent({ db, getProduct: catalog.getSummary,
    listOldVideos: () => [...oldClips], // Deliberately returns a neighbor's clip for the second card too.
    probeVideo: x => x.workId === 'clip-left', resolveInputs: () => ({ assets: [] }) });
  const sales = createSales({ db, catalog,
    content: { requestVideo: (ctx, input) => { history.push(input); return content.requestVideo(ctx, input); } },
    canRetrieveWork: (_ctx, { productId, workRef }) =>
      oldClips.some(w => w.productId === productId && w.workId === workRef.workId && w.workVersion === workRef.workVersion) });
  const ask = (requestId, extras = {}) => sales.ask(owner, { requestId, sessionId: 'same-session', question, ...extras });
  return { db, a, b, catalog, sales, ask, history };
}
function clarifies(r) {
  assert.equal(r.status, 'clarification_required');
  assert.match(r.answer, /哪一件|具体商品|商品卡/); assert.doesNotMatch(r.answer, /183|947|有货|无货|clip-/);
  for (const key of ['productRef', 'video', 'inventoryEvidence', 'inventoryState', 'alternativeSearch']) assert.equal(r[key], undefined);
  assert.deepEqual(r.taskIds, []); assert.equal(r.deliveryStatus, 'not_submitted');
}
test('未选卡：同托板描述、相册号和同会话上一张卡都不构成商品身份', t => {
  const f = setup(t);
  f.ask('first', { productId: f.a.productId });
  for (const [i, extras] of [
    { question: '托板上那条白色圆珠手串，多少钱、有货吗？' },
    { groupId: f.a.groupId, assetId: f.b.assetId },
    { question: '托板相册编号 ' + f.b.groupId + ' 能看本件视频吗？', needVideo: true },
    { productId: null, question: '旁边看着很像的那条呢？' }
  ].entries()) {
    const r = f.ask('unselected-' + i, extras); clarifies(r); assert.deepEqual(f.ask('unselected-' + i, extras), r);
  }
  assert.equal(f.history.length, 1); assert.deepEqual(f.sales.listTasks(owner), []);
});
test('已存在的组号/素材号误传给商品号：查无此卡，不退回同款或上一件', t => {
  const f = setup(t);
  for (const id of [f.a.assetId, f.b.groupId, 'shared-tray']) {
    assert.throws(() => f.ask('bad-' + id, { productId: id }), e => e.code === 'PRODUCT_NOT_FOUND' && e.httpStatus === 404);
  }
  assert.equal(f.history.length, 0); assert.deepEqual(f.sales.listTasks(owner), []);
});
test('当前打开左卡但提问明说不是它：不报左卡事实或交视频，直到给出右卡号', t => {
  const f = setup(t);
  for (const [i, question] of [
    '不是这件，我问托板上另一件多少钱？有货吗？能看视频吗？',
    '旁边那条多少钱？',
    '我想问另外一条的库存，请给我看本件视频。',
    '不是这条，我说的是旁边那条。'
  ].entries()) {
    const mismatch = { productId: f.a.productId, question, needVideo: true };
    const r = f.ask('mismatch' + i, mismatch); clarifies(r); assert.deepEqual(f.ask('mismatch' + i, mismatch), r);
    assert.throws(() => f.ask('mismatch' + i, { ...mismatch, productId: f.b.productId }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(f.history.length, 0); assert.deepEqual(f.sales.listTasks(owner), []);
  const correct = f.ask('chose-right', { productId: f.b.productId });
  assert.match(correct.answer, /947 元/); assert.equal(correct.inventoryState, 'out_of_stock');
});
test('没有换件的问句：否定的是旁件或在问本件，照常引原卡', t => {
  const f = setup(t);
  for (const [i, question] of ['不用看另外一条，只问这件多少钱？','这件是不是另外一种颜色？多少钱？',
    '不是这件没有现货吗？这件多少钱？','另一条不用了，我就问这件多少钱。'].entries()) {
    const r = f.ask('affirm-' + i, { productId: f.a.productId, question });
    assert.match(r.answer, /183 元/); assert.equal(r.productRef.productId, f.a.productId);
  }
});
test('修正前已存的错件回复：原流水保留，但重试不再带出错误报价或推进旧视频请求', t => {
  const f = setup(t), q = '不是这件，我问另一件多少钱？', id = 'legacy-wrong-card';
  const body = JSON.stringify({ sessionId:'same-session', question:q, productId:f.a.productId, needVideo:true });
  const original = JSON.stringify({ intentFormat:2, result:{ requestId:id, status:'answered', answer:'183 元',
    productRef:{productId:f.a.productId,productVersion:2} },
    demand:{requestId:id+':video',productId:f.a.productId,productVersion:2,demand:q} });
  f.db.prepare('INSERT INTO sales_receipts VALUES (?,?,?,?,?)').run(owner.shopId, 'ask', id, body, original);
  clarifies(f.ask(id, {productId:f.a.productId, question:q, needVideo:true}));
  assert.equal(f.history.length, 0);
  assert.equal(f.db.prepare('SELECT receipt FROM sales_receipts WHERE request_id=?').get(id).receipt, original);
});
test('明确左右原卡：同款、同会话仍按各自售价/库存/作品；只改左卡后新旧版本隔离', t => {
  const f = setup(t);
  const inputA = { productId: f.a.productId };
  const a = f.ask('a', inputA), b = f.ask('b', { productId: f.b.productId });
  assert.deepEqual(a.productRef, { productId: f.a.productId, productVersion: 2 });
  assert.deepEqual(b.productRef, { productId: f.b.productId, productVersion: 2 });
  assert.match(a.answer, /183 元/); assert.doesNotMatch(a.answer, /947/); assert.equal(a.inventoryState, 'in_stock');
  assert.match(b.answer, /947 元/); assert.doesNotMatch(b.answer, /183/); assert.equal(b.inventoryState, 'out_of_stock');
  assert.equal(a.inventoryEvidence.evidenceRef, 'stock-left'); assert.equal(b.inventoryEvidence.evidenceRef, 'stock-right');
  assert.deepEqual(a.video.workRef, { workId: 'clip-left', workVersion: 4 }); assert.equal(a.video.productId, f.a.productId);
  assert.equal(b.video.productId, f.b.productId); assert.equal(b.video.outcome, 'needs_source'); assert.equal(b.video.workRef, undefined);
  assert.equal(a.video.productVersion, 2); assert.equal(b.video.productVersion, 2);
  f.catalog.update(owner, { requestId: 'edit-left', productId: f.a.productId, expectedVersion: 2,
    changes: [{ field: 'price', source: 'manual', unit: '元', value: 358 }] });
  const current = f.ask('a-now', inputA), unchanged = f.ask('b-now', { productId: f.b.productId });
  assert.equal(current.productRef.productVersion, 3); assert.equal(current.video.productVersion, 3);
  assert.match(current.answer, /358 元/); assert.doesNotMatch(current.answer, /183|947/);
  assert.equal(unchanged.answer, b.answer); assert.deepEqual(unchanged.productRef, b.productRef);
  // A published historical fact stays historical. No new interpretation of the selected card.
  const readOld = f.ask('a', inputA); assert.deepEqual(readOld.productRef, a.productRef); assert.equal(readOld.answer, a.answer);
  assert.equal(current.deliveryStatus, 'not_submitted'); assert.equal(unchanged.deliveryStatus, 'not_submitted');
});
