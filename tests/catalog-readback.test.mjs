import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const { createCatalog } = await import('../catalog/index.mjs');
const owner = { shopId: 'fixture-n3', actorId: 'fixture-owner' };
const otherEditor = { ...owner, actorId: 'fixture-editor' };
const otherShop = { ...owner, shopId: 'fixture-other-shop' };
const snapshotFields = ({ fields }) => ({
  price: fields.price ?? null,
  size: fields.size ?? null
});
const facts = (price, size) => [
  { field: 'price', value: price, unit: '元', source: 'manual' },
  // The deployed editor sends size as text and price as a number.
  { field: 'size', value: String(size), unit: 'mm', source: 'manual' }
];
const shape = ({ value, unit, source }) => ({ value, unit, source });

test('Price and size share the latest version; a stale editor cannot overwrite A or touch B after reopen', t => {
  const dir=mkdtempSync(join(tmpdir(),'catalog-readback-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:3}));
  const file=join(dir,'fixture.sqlite');
  const owned = new Set(['fixture-view-a', 'fixture-view-b']);
  const hasAsset = (ctx, assetId) => ctx.shopId === owner.shopId && owned.has(assetId);
  const open = () => {
    const db = new DatabaseSync(file);
    try { return { db, catalog: createCatalog({ db, hasAsset }) }; }
    catch (error) { db.close(); throw error; }
  };
  const seed = (c, name) => c.acceptGroup(owner, {
    requestId: 'fixture-new-' + name, taskId: 'fixture-batch', groupId: 'fixture-group-' + name,
    groupVersion: 1, keptAssetIds: ['fixture-view-' + name],
    decisionSource: 'system_checked', evidenceRef: 'fixture-evidence-' + name
  }).productId;

  const first = open();
  let second;
  let result;
  try {
    const a = seed(first.catalog, 'a');
    const b = seed(first.catalog, 'b');
    assert.notEqual(a, b);
    assert.deepEqual(snapshotFields(first.catalog.getSummary(owner, a)), { price: null, size: null });
    first.catalog.update(owner, { requestId: 'initial-a', productId: a, expectedVersion: 1, changes: facts(1280, 10.5) });
    first.catalog.update(owner, { requestId: 'initial-b', productId: b, expectedVersion: 1, changes: facts(760, 8) });

    second = open();
    const beforeA = first.catalog.getSummary(owner, a);
    const beforeB = second.catalog.getSummary(otherEditor, b);
    const staleView = second.catalog.getSummary(otherEditor, a);
    assert.deepEqual(staleView, beforeA);
    assert.equal(beforeA.productVersion, 2);
    const update = {
      requestId: 'winner-quote-size', productId: a, expectedVersion: beforeA.productVersion, changes: facts(1360, 11.25)
    };
    const receipt = first.catalog.update(owner, update);
    assert.deepEqual(
      [receipt.status, receipt.outcome, receipt.productId, receipt.productVersion, receipt.changedFields],
      ['committed', 'updated', a, 3, ['price', 'size']]
    );

    let rejected;
    assert.throws(() => second.catalog.update(otherEditor, {
      requestId: 'stale-quote-size', productId: a, expectedVersion: staleView.productVersion, changes: facts(1, 1)
    }), error => {
      rejected = { code: error.code, httpStatus: error.httpStatus };
      return error.code === 'VERSION_CONFLICT' && error.httpStatus === 409;
    });
    assert.equal(second.db.prepare('SELECT count(*) AS n FROM catalog_receipts WHERE operation=? AND request_id=?')
      .get('update', 'stale-quote-size').n, 0);
    const afterA = second.catalog.getSummary(otherEditor, a);
    assert.deepEqual(shape(afterA.fields.price), { value: 1360, unit: '元', source: 'manual' });
    assert.deepEqual(shape(afterA.fields.size), { value: '11.25', unit: 'mm', source: 'manual' });
    assert.equal(afterA.fields.size.updatedBy, owner.actorId);
    assert.equal(afterA.productVersion, 3);
    assert.deepEqual(second.catalog.getSummary(otherEditor, b), beforeB);
    assert.deepEqual(afterA.assetRefs, beforeA.assetRefs);
    assert.equal(second.catalog.getSummary(otherShop, a), null);
    assert.equal(second.catalog.list(owner).length, 2);
    result = { a, b, beforeA, beforeB, afterA, rejected, receipt, update };
  } finally {
    second?.db.close();
    first.db.close();
  }

  const fresh = open();
  try {
    const a = fresh.catalog.getSummary(owner, result.a);
    const b = fresh.catalog.getSummary(owner, result.b);
    assert.deepEqual(a, result.afterA);
    assert.deepEqual(b, result.beforeB);
    assert.deepEqual(fresh.catalog.update(owner, result.update), result.receipt);
    assert.deepEqual(fresh.catalog.getSummary(owner, result.a), a);
    assert.equal(fresh.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    fresh.db.close();
  }
});
