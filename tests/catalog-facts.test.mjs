import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog } from '../catalog/index.mjs';

const owner = { shopId: 'synthetic-shop', actorId: 'verified-owner' };
const staff = { shopId: 'synthetic-shop', actorId: 'staff' };
const other = { shopId: 'other-shop', actorId: 'verified-owner' };
const code = expected => error => error?.code === expected && Number.isInteger(error.httpStatus);

function fixture(t, file = ':memory:') {
  const db = new DatabaseSync(file);
  const catalog = createCatalog({
    db,
    hasAsset: (ctx, assetId) => ctx.shopId === owner.shopId && ['stone-a', 'stone-b'].includes(assetId),
    // In production this decision comes from the server's owner/verification authority.
    canVerifyInventory: (ctx, inventory) => ctx.shopId === owner.shopId && ctx.actorId === owner.actorId && inventory.evidenceRef.startsWith('checked:')
  });
  let closed = false;
  catalog.closeTestDb = () => { if (!closed) { db.close(); closed = true; } };
  t.after(() => catalog.closeTestDb());
  return catalog;
}
function create(catalog, ctx, requestId, groupId, assetId) {
  return catalog.acceptGroup(ctx, {
    requestId, taskId: 'synthetic-batch', groupId, groupVersion: 1,
    keptAssetIds: [assetId], decisionSource: 'system_checked', evidenceRef: `group-proof:${groupId}`
  });
}
const size = (value, unit = 'mm') => ({ field: 'beadDiameter', value, unit, source: 'manual' });

test('versioned human size changes only A; B and cross-shop view remain untouched', t => {
  const c = fixture(t);
  const a = create(c, owner, 'create-a', 'group-a', 'stone-a');
  const b = create(c, owner, 'create-b', 'group-b', 'stone-b');
  const saved = c.update(owner, { requestId: 'size-a', productId: a.productId, expectedVersion: 1, changes: [size(7)] });
  assert.deepEqual(saved, {
    status: 'committed', requestId: 'size-a', productId: a.productId,
    productVersion: 2, changedFields: ['beadDiameter'], inventoryChanged: false, outcome: 'updated'
  });
  assert.equal(c.get(owner, a.productId).fields.beadDiameter.value, 7);
  assert.equal(c.get(owner, a.productId).fields.beadDiameter.unit, 'mm');
  assert.equal(c.get(owner, a.productId).fields.beadDiameter.source, 'manual');
  assert.equal(c.get(owner, b.productId).productVersion, 1);
  assert.deepEqual(c.get(owner, b.productId).fields, {});
  assert.equal(c.get(other, a.productId), null);
  assert.equal(c.getSummary(other, a.productId), null);
  assert.throws(() => c.update(other, { requestId: 'foreign', productId: a.productId, expectedVersion: 2, changes: [size(8)] }), code('PRODUCT_NOT_FOUND'));
  const summary = c.getSummary(owner, a.productId);
  assert.equal(summary.productVersion, 2);
  assert.equal(summary.fields.beadDiameter.value, 7);
  assert.deepEqual(summary.inventory, { status: 'unknown', quantity: null, verifiedAt: null, verifiedBy: null, evidenceRef: null });
  assert.deepEqual(summary.assetRefs, [{ assetId: 'stone-a', groupId: 'group-a', groupVersion: 1, decisionSource: 'system_checked', evidenceRef: 'group-proof:group-a', sha256: null }]);
  assert.equal(summary.copyId, null);
  assert.equal(summary.copyVersion, null);
});

test('manual values outrank suggestions; dimensions require a human and a unit', t => {
  const c = fixture(t);
  const p = create(c, owner, 'create-a', 'group-a', 'stone-a').productId;
  assert.throws(() => c.update(owner, { requestId: 'bad-size', productId: p, expectedVersion: 1, changes: [{ field: 'beadDiameter', value: 8, unit: 'mm', source: 'ai_suggestion' }] }), code('MANUAL_MEASUREMENT_REQUIRED'));
  assert.throws(() => c.update(owner, { requestId: 'no-unit', productId: p, expectedVersion: 1, changes: [size(8, null)] }), code('INVALID_INPUT'));
  c.update(owner, { requestId: 'suggest-color', productId: p, expectedVersion: 1, changes: [{ field: 'color', value: 'blue', source: 'ai_suggestion' }] });
  c.update(owner, { requestId: 'manual-color', productId: p, expectedVersion: 2, changes: [{ field: 'color', value: 'green', source: 'manual' }] });
  assert.throws(() => c.update(owner, { requestId: 'overwrite-color', productId: p, expectedVersion: 3, changes: [{ field: 'color', value: 'blue', source: 'ai_suggestion' }] }), code('MANUAL_VALUE_PROTECTED'));
  assert.equal(c.get(owner, p).fields.color.value, 'green');
  assert.equal(c.get(owner, p).productVersion, 3);
  const empty = c.update(owner, { requestId: 'same-color', productId: p, expectedVersion: 3, changes: [{ field: 'color', value: 'green', source: 'manual' }] });
  assert.equal(empty.outcome, 'unchanged');
  assert.equal(empty.productVersion, 3);
  c.update(owner, { requestId: 'empty-size', productId: p, expectedVersion: 3, changes: [{ field: 'beadDiameter', value: null, source: 'manual' }] });
  assert.equal(c.get(owner, p).fields.beadDiameter.value, null);
});

test('inventory remains unknown until server-verified owner update; replay and stale writes do not bump', t => {
  const c = fixture(t);
  const p = create(c, owner, 'create-a', 'group-a', 'stone-a').productId;
  const request = { requestId: 'stock-1', productId: p, expectedVersion: 1, changes: [], inventory: { status: 'in_stock', quantity: 2, evidenceRef: 'checked:physical-count' } };
  assert.equal(c.get(owner, p).inventoryStatus, 'unknown');
  assert.throws(() => c.update(staff, { ...request, actorId: owner.actorId }), code('INVENTORY_VERIFICATION_REQUIRED'));
  assert.throws(() => c.update(owner, { ...request, inventory: { ...request.inventory, evidenceRef: 'unverified' } }), code('INVENTORY_VERIFICATION_REQUIRED'));
  const saved = c.update(owner, request);
  assert.equal(saved.productVersion, 2);
  assert.equal(saved.inventoryChanged, true);
  assert.deepEqual(c.update(owner, request), saved);
  assert.equal(c.get(owner, p).productVersion, 2);
  assert.equal(c.get(owner, p).inventoryStatus, 'in_stock');
  const snapshot = c.getSummary(owner, p);
  assert.equal(snapshot.inventory.quantity, 2);
  assert.equal(snapshot.inventory.verifiedBy, owner.actorId);
  assert.equal(snapshot.inventory.evidenceRef, 'checked:physical-count');
  assert.match(snapshot.inventory.verifiedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(c.get(owner, p).inventoryVerifiedAt, snapshot.inventory.verifiedAt);
  assert.throws(() => c.update(owner, { ...request, inventory: { ...request.inventory, quantity: 1 } }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => c.update(owner, { ...request, requestId: 'stock-stale', inventory: { ...request.inventory, quantity: 1 } }), code('VERSION_CONFLICT'));
  assert.equal(c.getSummary(owner, p).inventory.quantity, 2);
});

test('fact and inventory versions survive closing and reopening a SQLite file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-facts-temp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'facts.sqlite');
  const c1 = fixture(t, file);
  const p = create(c1, owner, 'create-a', 'group-a', 'stone-a').productId;
  const req = { requestId: 'facts-1', productId: p, expectedVersion: 1, changes: [size(9)], inventory: { status: 'out_of_stock', quantity: 0, evidenceRef: 'checked:shelf' } };
  const receipt = c1.update(owner, req);
  c1.closeTestDb();
  const c2 = fixture(t, file);
  assert.deepEqual(c2.update(owner, req), receipt);
  assert.equal(c2.getSummary(owner, p).fields.beadDiameter.value, 9);
  assert.equal(c2.getSummary(owner, p).inventory.status, 'out_of_stock');
  assert.equal(c2.getSummary(owner, p).productVersion, 2);
  c2.closeTestDb();
});
