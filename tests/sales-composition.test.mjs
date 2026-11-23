import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '../catalog/index.mjs';
import { createContent } from '../content/index.mjs';
import { createSales } from '../sales/index.mjs';

// All business inputs, rights, media probes and adapters below are fixtures.
// catalog, content, sales and their shared SQLite connection are the real modules.
const ctx = { shopId: 'fixture-shop', actorId: 'fixture-owner' };
const other = { shopId: 'fixture-other', actorId: 'fixture-owner' };
const code = expected => error => error.code === expected;
const count = (db, table) => db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
function setup(t, disk = false) {
  const dir = disk && mkdtempSync(join(tmpdir(), 'sales-fixture-'));
  const file = dir ? join(dir, 'sales.sqlite') : ':memory:';
  const state = { mode: 'old', permit: true, visible: true, workUsable: true, calls: [], tiers: [], clockOffset: 0, directoryRows: [] };
  const f = { state };
  function open() {
    const db = new DatabaseSync(file);
    const catalog = createCatalog({ db, hasAsset: c => c.shopId === ctx.shopId,
      canVerifyInventory: c => c.shopId === ctx.shopId && c.actorId === ctx.actorId });
    const get = (scope, id) => state.visible ? catalog.get(scope, id) : null;
    const canRetrieveWork = (scope, { productId, workRef }) => scope.shopId === ctx.shopId &&
      get(scope, productId) !== null && workRef.workId === 'fixture-work' && workRef.workVersion === 3 && state.workUsable;
    const content = createContent({
      db, getProduct: get,
      listOldVideos: (scope, productId) => {
        if (state.mode !== 'old' && state.mode !== 'review') return [];
        return [{ shopId: scope.shopId, productId, workId: 'fixture-work', workVersion: 3,
          rights: state.mode === 'review' || !state.workUsable ? 'withdrawn' : 'usable' }];
      },
      resolveInputs: (_scope, product) => state.mode !== 'queue' ? null : {
        assets: [{ kind: 'product_shot', productId: product.productId, assetId: product.assetIds[0],
          digest: 'fixture-digest', rights: 'usable' }],
        copyId: 'fixture-copy', copyVersion: 1, preferenceSnapshot: { style: 'fixture' }, preferenceVersion: 1
      },
      probeVideo: () => true // fixture probe, not an actual playable file
    });
    const options = {
      db, catalog: { get, getSummary: (...args) => {
        const summary = catalog.getSummary(...args);
        return state.alterSummary ? state.alterSummary(summary) : summary;
      } },
      directory: { search(_scope, { tier }) { state.tiers.push(tier); return state.directoryRows; } },
      canAccessSales: scope => state.permit && scope.actorId === ctx.actorId,
      canRetrieveWork,
      getInventoryMaxAgeMs: () => 60_000, now: () => Date.now() + state.clockOffset,
      content: { requestVideo(scope, demand) {
        state.calls.push(structuredClone(demand));
        const receipt = content.requestVideo(scope, demand);
        if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error('fixture lost content response'); }
        return receipt;
      } }
    };
    Object.assign(f, { db, catalog, content, options, sales: createSales(options) });
  }
  open();
  t.after(() => { f.db.close(); if (dir) { unlinkSync(file); rmdirSync(dir); } });
  f.reopen = () => { f.db.close(); open(); };
  return f;
}

function makeCard(f, tag) {
  const { productId } = f.catalog.acceptGroup(ctx, {
    requestId: 'new-' + tag, taskId: 'batch-' + tag, groupId: 'group-' + tag, groupVersion: 1,
    keptAssetIds: ['asset-' + tag], decisionSource: 'system_checked', evidenceRef: 'fixture-group'
  });
  f.catalog.update(ctx, { requestId: 'facts-' + tag, productId, expectedVersion: 1, changes: [
    { field: 'title', value: '样卡' + tag, source: 'manual' },
    { field: 'description', value: '圆珠', source: 'manual' },
    { field: 'beadDiameter', value: 8, unit: 'mm', source: 'manual' }
  ] });
  return productId;
}
const ask = (requestId, productId, needVideo = false) => ({
  requestId, productId, needVideo, question: needVideo ? '看本件视频' : '这件珠径和库存呢？', sessionId: 'fixture-session'
});

test('typed facts and measurements: new A reads A v3, B and authorized historical replay do not change', t => {
  const f = setup(t), a = makeCard(f, '甲'), b = makeCard(f, '乙');
  const before = f.sales.ask(ctx, ask('r1', a)), second = f.sales.ask(ctx, ask('r2', b));
  assert.match(before.answer, /样卡甲/); assert.match(before.answer, /圆珠/);
  assert.match(before.answer, /8\s*mm/); assert.doesNotMatch(before.answer, /\[object Object\]/);
  f.catalog.update(ctx, { requestId: 'resize', expectedVersion: 2, productId: a,
    changes: [{ field: 'beadDiameter', value: 7, unit: 'mm', source: 'manual' }] });
  const after = f.sales.ask(ctx, ask('r3', a));
  assert.deepEqual(after.productRef, { productId: a, productVersion: 3 }); assert.match(after.answer, /7\s*mm/);
  assert.deepEqual(after.taskIds, before.taskIds);
  assert.deepEqual(f.sales.ask(ctx, ask('r1', a)), before);
  const bAgain = f.sales.ask(ctx, ask('r4', b));
  assert.deepEqual(bAgain.productRef, second.productRef); assert.equal(bAgain.answer, second.answer);
  assert.deepEqual(bAgain.taskIds, second.taskIds); assert.equal(f.sales.listTasks(ctx).length, 2);
});

test('inventory follows catalog verification, not display copy; expired or incomplete evidence is not current stock', t => {
  const f = setup(t), id = makeCard(f, '库存');
  const update = (rid, delta) => f.catalog.update(ctx, { requestId: rid, productId: id,
    expectedVersion: f.catalog.get(ctx, id).productVersion, ...delta });
  update('marketing', { changes: [{ field: 'description', value: '保证现货，马上发货', source: 'manual' }] });
  const unknown = f.sales.ask(ctx, ask('unknown', id));
  assert.equal(unknown.inventoryState, 'unknown'); assert.doesNotMatch(unknown.answer, /保证现货|马上发货/);
  assert.equal(unknown.taskIds.length, 1);
  update('verified', { inventory: { status: 'in_stock', quantity: 1, evidenceRef: 'fixture-count-1' } });
  const verified = f.sales.ask(ctx, ask('verified', id));
  assert.equal(verified.inventoryState, 'in_stock'); assert.deepEqual(verified.taskIds, []);
  assert.equal(verified.inventoryEvidence.evidenceRef, 'fixture-count-1');
  assert.equal(verified.inventoryEvidence.verifiedBy, ctx.actorId);
  assert.match(verified.answer, /核实为有货/); assert.doesNotMatch(verified.answer, /保证现货|马上发货/);
  assert.equal(f.sales.listTasks(ctx).find(x => x.taskId === unknown.taskIds[0]).status, 'resolved');
  f.state.clockOffset = 120_000;
  const stale = f.sales.ask(ctx, ask('stale', id));
  assert.equal(stale.inventoryState, 'stale'); assert.equal(stale.taskIds.length, 1);
  assert.doesNotMatch(stale.answer, /核实为有货|保证现货/);
  f.state.clockOffset = 0;
  for (const [i, change] of [
    x => { x.inventory.evidenceRef = ''; }, x => { x.inventory.verifiedBy = null; },
    x => { x.productVersion++; }, x => { x.inventory.status = 'out_of_stock'; },
    x => { x.inventory.verifiedAt = null; }
  ].entries()) {
    f.state.alterSummary = summary => { change(summary); return summary; };
    const res = f.sales.ask(ctx, ask('partial-' + i, id));
    assert.equal(res.inventoryState, 'unknown'); assert.deepEqual(res.taskIds, stale.taskIds);
    assert.match(res.answer, /待核实/);
  }
  f.state.alterSummary = null;
  update('sold-out', { inventory: { status: 'out_of_stock', quantity: 0, evidenceRef: 'fixture-count-2' } });
  f.state.tiers = [];
  const out = f.sales.ask(ctx, ask('out', id));
  assert.equal(out.inventoryState, 'out_of_stock'); assert.deepEqual(out.taskIds, []);
  assert.match(out.answer, /核实为无货/); assert.deepEqual(f.state.tiers, ['frequent', 'other']);
});

for (const [mode, outcome] of [['old', 'existing_available'], ['queue', 'queued'], ['missing', 'needs_source'], ['review', 'needs_review']]) {
  test('real content.requestVideo on shared SQLite: ' + outcome, t => {
    const f = setup(t), id = makeCard(f, '视频'); f.state.mode = mode;
    const input = ask('rv', id, true);
    const result = f.sales.ask(ctx, input), video = result.video;
    const expectedInput = { requestId: 'rv:video', productId: id, productVersion: 2, demand: '看本件视频', sessionId: input.sessionId };
    assert.deepEqual(f.state.calls, [expectedInput]);
    assert.equal(video.requestId, expectedInput.requestId); assert.equal(video.productId, id);
    assert.equal(video.productVersion, 2); assert.equal(video.deliveryStatus, 'not_submitted'); assert.equal(video.outcome, outcome);
    if (mode === 'old') {
      assert.equal(video.retrievalStatus, 'playable'); assert.deepEqual(video.workRef, { workId: 'fixture-work', workVersion: 3 });
    } else if (mode === 'queue') {
      const task = f.content.getTask(ctx, video.taskId);
      assert.equal(task.productId, id); assert.equal(task.productVersion, 2); assert.equal(task.status, 'queued');
      assert.ok(result.taskIds.includes(video.taskId)); assert.throws(() => f.content.getTask(other, video.taskId), code('TASK_NOT_FOUND'));
    } else { assert.ok(video.nextAction); assert.equal(video.taskId, undefined); }
    assert.deepEqual(f.sales.ask(ctx, input), result);
    assert.deepEqual(f.sales.listTasks(ctx).map(x => x.taskId), result.taskIds.filter(x => x !== video.taskId));
    assert.equal(count(f.db, 'content_tasks'), mode === 'queue' ? 1 : 0);
  });
}

test('authorization precedes old receipt, content replay and lookup of private tasks', t => {
  const f = setup(t), id = makeCard(f, '权限'), input = ask('auth', id, true);
  const first = f.sales.ask(ctx, input); assert.equal(first.video.outcome, 'existing_available');
  f.state.permit = false;
  assert.throws(() => f.sales.ask(ctx, input), code('FORBIDDEN'));
  assert.throws(() => f.sales.ask(ctx, { ...input, question: '不同正文' }), code('FORBIDDEN'));
  assert.throws(() => f.sales.listTasks(ctx), code('FORBIDDEN'));
  f.state.permit = true; f.state.visible = false;
  assert.throws(() => f.sales.ask(ctx, input), code('PRODUCT_NOT_FOUND')); assert.deepEqual(f.sales.listTasks(ctx), []);
  assert.throws(() => f.sales.ask(ctx, { ...input, productId: null }), code('PRODUCT_NOT_FOUND'));
  assert.throws(() => f.sales.ask(other, { ...input, shopId: ctx.shopId, actorId: ctx.actorId }), code('PRODUCT_NOT_FOUND'));
  assert.equal(f.state.calls.length, 1);
  f.state.visible = true; f.state.workUsable = false;
  assert.throws(() => f.sales.ask(ctx, input), code('VIDEO_ACCESS_DENIED'));
  assert.equal(f.sales.listTasks(ctx).length, 1);
});

test('direct real content service; no live work check on replay does not expose historical playable work', t => {
  const f = setup(t), id = makeCard(f, '旧片');
  const sales = createSales({ ...f.options, content: f.content, canRetrieveWork: undefined });
  const input = ask('direct', id, true), first = sales.ask(ctx, input);
  assert.deepEqual(first.video, { requestId: 'direct:video', productId: id, productVersion: 2,
    outcome: 'existing_available', workRef: { workId: 'fixture-work', workVersion: 3 },
    retrievalStatus: 'playable', deliveryStatus: 'not_submitted' });
  assert.throws(() => sales.ask(ctx, input), code('VIDEO_ACCESS_RECHECK_REQUIRED'));
  assert.equal(count(f.db, 'content_tasks'), 0); assert.equal(count(f.db, 'sales_tasks'), 1);
});

test('display in_stock without catalog summary is unknown; directory outage does not roll back the stock task', t => {
  const f = setup(t), id = makeCard(f, '摘要');
  f.catalog.update(ctx, { requestId: 'verify', productId: id, expectedVersion: 2,
    inventory: { status: 'in_stock', quantity: null, evidenceRef: 'fixture-count' } });
  const sales = createSales({ ...f.options, catalog: { get: f.catalog.get },
    directory: { search() { throw new Error('fixture offline'); } } });
  const r = sales.ask(ctx, ask('no-summary', id));
  assert.equal(f.catalog.get(ctx, id).inventoryStatus, 'in_stock');
  assert.equal(r.inventoryState, 'unknown'); assert.equal(r.inventoryEvidence, null);
  assert.match(r.answer, /库存待核实/); assert.equal(r.alternativeSearch.status, 'directory_unavailable');
  assert.deepEqual(sales.listTasks(ctx).map(x => x.taskId), r.taskIds);
});

test('matched directory details are owner-only and are reauthorized before replay', t => {
  const f = setup(t), id = makeCard(f, '目录'), input = ask('directory', id);
  f.state.directoryRows = [{ id: 'supplier-fixture', contactRef: 'owner-only-fixture' }];
  const r = f.sales.ask(ctx, input); assert.deepEqual(f.state.tiers, ['frequent']);
  assert.equal(r.alternativeSearch.status, 'matched'); assert.doesNotMatch(r.answer, /owner-only-fixture/);
  assert.deepEqual(f.sales.ask(ctx, input), r);
  f.state.directoryRows = [];
  assert.throws(() => f.sales.ask(ctx, input), code('FORBIDDEN'));
  assert.equal(f.sales.listTasks(ctx).length, 1);
});

test('mismatched content receipt is not represented as a sale, new job or delivery', t => {
  const f = setup(t), id = makeCard(f, '错版'), input = ask('wrong', id, true);
  const sales = createSales({ ...f.options, content: { requestVideo(scope, demand) {
    const actual = f.content.requestVideo(scope, demand);
    return { ...actual, productVersion: demand.productVersion + 1 }; // deliberately faulty boundary fixture
  } } });
  assert.throws(() => sales.ask(ctx, input), code('INVALID_CONTENT_RECEIPT'));
  assert.throws(() => sales.ask(ctx, input), code('INVALID_CONTENT_RECEIPT'));
  assert.equal(sales.listTasks(ctx).length, 1); assert.equal(count(f.db, 'content_tasks'), 0);
});

test('after lost content response and SQLite reopen, retry original demand/version and never enqueue twice', t => {
  const f = setup(t, true), id = makeCard(f, '重启'), input = ask('durable', id, true);
  f.state.mode = 'queue'; f.state.failAfterCommit = true;
  assert.throws(() => f.sales.ask(ctx, input), /fixture lost content response/);
  const [task] = f.sales.listTasks(ctx);
  f.catalog.update(ctx, { requestId: 'edit', productId: id, expectedVersion: 2,
    changes: [{ field: 'description', value: '合成修订', source: 'manual' }] });
  f.reopen();
  assert.throws(() => f.sales.ask(ctx, { ...input, question: '换需求' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.state.calls.length, 1);
  const replay = f.sales.ask(ctx, input);
  assert.equal(replay.video.outcome, 'queued'); assert.equal(replay.video.productVersion, 2);
  assert.deepEqual(f.state.calls[0], f.state.calls[1]); assert.equal(f.content.getTask(ctx, replay.video.taskId).productVersion, 2);
  assert.deepEqual(replay.taskIds, [task.taskId, replay.video.taskId]);
  assert.equal(count(f.db, 'sales_tasks'), 1); assert.equal(count(f.db, 'content_tasks'), 1);
  assert.equal(f.sales.ask(ctx, ask('new-read', id)).productRef.productVersion, 3);
});
