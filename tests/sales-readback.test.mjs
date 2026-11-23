import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCatalog } from '../catalog/index.mjs';
import { createSales } from '../sales/index.mjs';

test('Edit A, ask A then B in one session, preserve receipts and open task identity', t => {
  const work = mkdtempSync(join(tmpdir(),'sales-readback-'));
  const file = join(work, 'fixture.sqlite');
  const ctx = { shopId: 'n3-fixture-shop', actorId: 'n3-fixture-owner' };
  const question = '这条手串多少钱，有货吗？';
  const sessionId = 'n3-one-session';
  let db, catalog, sales;
  const open = () => {
    db = new DatabaseSync(file);
    // Fixture-only: keep the file/reopen path without per-commit full fsync.
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    catalog = createCatalog({ db, hasAsset: (s, id) => s.shopId === ctx.shopId && ['fixture-A', 'fixture-B'].includes(id) });
    sales = createSales({ db, catalog });
  };
  open();
  t.after(() => { try { db?.close(); } finally { rmSync(work,{recursive:true,force:true,maxRetries:3}); } });
  function seed(label, price, decoy) {
    const { productId, productVersion } = catalog.acceptGroup(ctx, {
      requestId: 'create-' + label, taskId: 'fixture-batch', groupId: 'fixture-group-' + label, groupVersion: 1,
      keptAssetIds: ['fixture-' + label], decisionSource: 'owner_confirmed', evidenceRef: 'fixture-only'
    });
    return catalog.update(ctx, { requestId: 'seed-facts-' + label, productId, expectedVersion: productVersion, changes: [
      { field: 'title', value: '同款测试手串', source: 'manual' },
      { field: 'description', value: '旧宣传称 ' + decoy + ' 元并保证现货', source: 'manual' },
      { field: 'price', value: price, unit: '元', source: 'manual' }
    ] });
  }
  const a = seed('A', 288, 499), b = seed('B', 499, 359);
  assert.notEqual(a.productId, b.productId);
  const inp = (requestId, productId, q = question) => ({ requestId, sessionId, productId, question: q });
  const lookup = p => catalog.get(ctx, p);
  const readTasks = () => sales.listTasks(ctx);
  const rows = () => Object.fromEntries(['sales_tasks','sales_task_origins','sales_receipts'].map(table =>
    [table, db.prepare('SELECT count(*) AS n FROM ' + table).get().n]));
  const check = ({ result: r, productId, version, quote }) => {
    assert.deepEqual(r.productRef, { productId, productVersion: version });
    const expected = quote === null ? [] : [quote];
    assert.deepEqual([...r.answer.matchAll(/(\d+(?:\.\d+)?)\s*元/gu)].map(m => Number(m[1])), expected);
    if (quote === null) assert.match(r.answer, /价格待店主核实/u);
    else assert.match(r.answer, /店主记录的售价/u);
    assert.equal(r.status, 'needs_owner_action');
    assert.match(r.answer, /库存待核实，暂不承诺现货/u);
    assert.doesNotMatch(r.answer, /保证现货|核实为有货|已提醒|已发送/u);
    assert.equal(r.inventoryState, 'unknown'); assert.equal(r.inventoryEvidence, null);
    assert.equal(r.deliveryStatus, 'not_submitted'); assert.equal(r.alternativeSearch.status, 'directory_unavailable');
    assert.equal(r.taskIds.length, 1);
  };

  const beforeA = lookup(a.productId), beforeB = lookup(b.productId);
  const oldInput = inp('ask-A-before', a.productId);
  const old = sales.ask(ctx, oldInput);
  check({ result: old, productId: a.productId, version: 2, quote: 288 });
  const edit = catalog.update(ctx, { requestId: 'change-price-A', productId: a.productId, expectedVersion: 2,
    changes: [{ field: 'price', value: 359, unit: '元', source: 'manual' }] });
  const afterA = lookup(a.productId), afterB = lookup(b.productId);
  assert.equal(edit.productVersion, 3); assert.deepEqual(edit.changedFields, ['price']); assert.deepEqual(afterB, beforeB);
  for (const [card, expected] of [[beforeA, 288], [afterA, 359], [afterB, 499]]) {
    const { value, source, unit, updatedBy } = card.fields.price;
    assert.deepEqual({ value, source, unit, updatedBy }, { value: expected, source: 'manual', unit: '元', updatedBy: ctx.actorId });
  }

  const currentInput = inp('ask-A-current', a.productId);
  const current = sales.ask(ctx, currentInput); // first after edit: A, NOT B
  check({ result: current, productId: a.productId, version: 3, quote: 359 });
  const bInput = inp('switch-and-ask-B', b.productId);
  const switched = sales.ask(ctx, bInput); // same session and text, new selection + requestId
  check({ result: switched, productId: b.productId, version: 2, quote: 499 });
  assert.deepEqual(current.taskIds, old.taskIds);
  assert.notEqual(current.taskIds[0], switched.taskIds[0]);
  const beforeReplay = rows();
  assert.deepEqual(beforeReplay, { sales_tasks: 2, sales_task_origins: 2, sales_receipts: 3 });
  assert.deepEqual(sales.ask(ctx, currentInput), current);
  assert.deepEqual(sales.ask(ctx, oldInput), old);
  db.close(); open();
  assert.deepEqual(sales.ask(ctx, currentInput), current);
  assert.deepEqual(sales.ask(ctx, bInput), switched);
  assert.deepEqual(rows(), beforeReplay);
  const afterReplay = rows(), persistedTasks = readTasks();
  const aTask = persistedTasks.find(x => x.productId === a.productId);
  assert.ok(aTask);
  assert.deepEqual({ ...aTask }, { taskId: current.taskIds[0], productId: a.productId, kind: 'verify_inventory',
    status: 'open', originalQuestion: question, originalProductVersion: 2, originalRequestId: oldInput.requestId });
  const bTask = persistedTasks.find(x => x.productId === b.productId);
  assert.equal(bTask.taskId, switched.taskIds[0]); assert.equal(bTask.status, 'open');
  let conflict;
  assert.throws(() => sales.ask(ctx, inp(currentInput.requestId, b.productId)), e => (conflict = e.code) === 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(rows(), afterReplay);
  const redirectInput = inp('redirect-ambiguous', a.productId, '旁边那条多少钱');
  const redirect = sales.ask(ctx, redirectInput);
  assert.equal(redirect.status, 'clarification_required'); assert.equal(redirect.productRef, undefined);
  assert.deepEqual(redirect.taskIds, []); assert.doesNotMatch(redirect.answer, /\d+\s*元/u);

  const clear = catalog.update(ctx, { requestId: 'clear-price-A', productId: a.productId, expectedVersion: 3,
    changes: [{ field: 'price', value: null, unit: '元', source: 'manual' }] });
  const missingInput = inp('query-price-unset', a.productId);
  const missing = sales.ask(ctx, missingInput);
  check({ result: missing, productId: a.productId, version: 4, quote: null });
  assert.deepEqual(missing.taskIds, current.taskIds);
  assert.deepEqual(lookup(b.productId), beforeB);
  const finalRows = rows();
  assert.deepEqual(finalRows, { sales_tasks: 2, sales_task_origins: 2, sales_receipts: 5 });
});
