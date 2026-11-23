import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog } from '../catalog/index.mjs';

const shop = { shopId: 'shop-one', actorId: 'owner-one' };
const other = { shopId: 'shop-two', actorId: 'owner-two' };
const group = (requestId, groupId, keptAssetIds, rest = {}) => ({
  requestId, taskId: 'batch-one', groupId, groupVersion: 1,
  keptAssetIds, decisionSource: 'system_checked', evidenceRef: `proof-${groupId}`,
  ...rest
});
const errorCode = code => error => error?.code === code && Number.isInteger(error.httpStatus);

function fixture(t, file = ':memory:') {
  const db = new DatabaseSync(file);
  const owned = new Map([
    [shop.shopId, new Set(['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1'])],
    [other.shopId, new Set(['elsewhere'])]
  ]);
  const hasAsset = (ctx, id) => owned.get(ctx.shopId)?.has(id) === true;
  const catalog = createCatalog({ db, hasAsset });
  t.after(() => db.close());
  return { db, owned, hasAsset, catalog };
}

test('first groups create two opaque cards with four owned images; no published gate', t => {
  const { catalog } = fixture(t);
  const a = catalog.acceptGroup(shop, group('r1', 'group-alpha', ['a1', 'a2']));
  const b = catalog.acceptGroup(shop, group('r2', 'group-beta', ['b1', 'b2']));
  assert.equal(a.status, 'committed');
  assert.equal(a.outcome, 'created');
  assert.equal(a.productVersion, 1);
  assert.deepEqual(a.linkedAssetIds, ['a1', 'a2']);
  assert.deepEqual(a.addedAssetIds, ['a1', 'a2']);
  assert.notEqual(a.productId, b.productId);
  assert.match(a.productId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(catalog.get(shop, a.productId), {
    productId: a.productId, productVersion: 1, assetIds: ['a1', 'a2'],
    fields: {}, inventoryStatus: 'unknown', inventoryVerifiedAt: null,
    copyId: null, copyVersion: null
  });
  assert.equal(catalog.list(shop).length, 2);
  assert.deepEqual(catalog.list(shop), [...catalog.list(shop)].sort((x, y) => x.productId.localeCompare(y.productId)));
});

test('supplements on the original group and a new evidence group add to one card', t => {
  const { catalog } = fixture(t);
  const first = catalog.acceptGroup(shop, group('r1', 'g1', ['a1', 'a2']));
  const supplement = catalog.acceptGroup(shop, group('r2', 'g1', ['a1', 'a2', 'a3'], {
    groupVersion: 2, targetProductId: first.productId, expectedVersion: 1
  }));
  assert.equal(supplement.productId, first.productId);
  assert.equal(supplement.productVersion, 2);
  assert.equal(supplement.outcome, 'images_added');
  assert.deepEqual(supplement.addedAssetIds, ['a3']);
  const newEvidence = catalog.acceptGroup(shop, group('r3', 'g2', ['a3'], {
    targetProductId: first.productId, expectedVersion: 2
  }));
  assert.equal(newEvidence.outcome, 'unchanged');
  assert.equal(newEvidence.productVersion, 2);
  assert.deepEqual(catalog.get(shop, first.productId).assetIds, ['a1', 'a2', 'a3']);
  assert.equal(catalog.list(shop).length, 1);
});

test('new requestId repeating applied supplement with stale expectedVersion is unchanged', t => {
  const { catalog } = fixture(t);
  const first = catalog.acceptGroup(shop, group('create', 'g1', ['a1', 'a2']));
  const supplement = group('supplement', 'g1', ['a1', 'a2', 'a3'], {
    groupVersion: 2, targetProductId: first.productId, expectedVersion: 1
  });
  const added = catalog.acceptGroup(shop, supplement);
  assert.equal(added.outcome, 'images_added');
  assert.equal(added.productVersion, 2);
  const repeated = catalog.acceptGroup(shop, { ...supplement, requestId: 'repeated-supplement' });
  assert.equal(repeated.outcome, 'unchanged');
  assert.equal(repeated.productId, first.productId);
  assert.equal(repeated.productVersion, 2);
  assert.deepEqual(repeated.addedAssetIds, []);
  assert.deepEqual(catalog.get(shop, first.productId).assetIds, ['a1', 'a2', 'a3']);
  assert.equal(catalog.list(shop).length, 1);
  assert.deepEqual(catalog.acceptGroup(shop, supplement), added, 'same requestId retains original receipt');
  assert.throws(() => catalog.acceptGroup(shop, { ...supplement, requestId: 'different-body', evidenceRef: 'changed' }), errorCode('GROUP_VERSION_CONFLICT'));
  assert.throws(() => catalog.acceptGroup(shop, group('real-change', 'g1', ['a1', 'a2', 'a3', 'c1'], {
    groupVersion: 3, targetProductId: first.productId, expectedVersion: 1
  })), errorCode('VERSION_CONFLICT'));
});

test('same request returns its original receipt after process-style reopen; new request finds mapped card', t => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-temp-'));
  let reopened; t.after(() => { try { reopened?.close(); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } });
  const file = join(dir, 'catalog.sqlite');
  const owned = new Set(['a1', 'a2', 'a3']);
  const hasAsset = (_ctx, id) => owned.has(id);
  const db1 = new DatabaseSync(file);
  const c1 = createCatalog({ db: db1, hasAsset });
  const input = group('r1', 'g1', ['a1', 'a2']);
  const original = c1.acceptGroup(shop, input);
  const supplement = group('r-supplement', 'g1', ['a1', 'a2', 'a3'], {
    groupVersion: 2, targetProductId: original.productId, expectedVersion: 1
  });
  const added = c1.acceptGroup(shop, supplement);
  db1.close();
  const db2 = new DatabaseSync(file);
  reopened = db2;
  const c2 = createCatalog({ db: db2, hasAsset });
  assert.deepEqual(c2.acceptGroup(shop, input), original);
  assert.deepEqual(c2.acceptGroup(shop, supplement), added);
  const found = c2.acceptGroup(shop, { ...supplement, requestId: 'r2' });
  assert.equal(found.productId, original.productId);
  assert.equal(found.outcome, 'unchanged');
  assert.equal(found.productVersion, 2);
  assert.deepEqual(found.addedAssetIds, []);
  assert.deepEqual(c2.get(shop, original.productId).assetIds, ['a1', 'a2', 'a3']);
  assert.equal(c2.list(shop).length, 1);
  owned.delete('a1');
  assert.throws(() => c2.acceptGroup(shop, input), errorCode('ASSET_NOT_OWNED'));
});

test('idempotency, group version, target version, removal and cross-product conflicts roll back', t => {
  const { catalog } = fixture(t);
  const first = catalog.acceptGroup(shop, group('r1', 'g1', ['a1']));
  const second = catalog.acceptGroup(shop, group('r2', 'g2', ['b1']));
  assert.throws(() => catalog.acceptGroup(shop, group('r1', 'g1', ['a2'])), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => catalog.acceptGroup(shop, group('r3', 'g1', ['a2'])), errorCode('GROUP_VERSION_CONFLICT'));
  assert.throws(() => catalog.acceptGroup(shop, group('r4', 'g1', ['a1', 'a2'], {
    groupVersion: 2, targetProductId: first.productId, expectedVersion: 99
  })), errorCode('VERSION_CONFLICT'));
  assert.throws(() => catalog.acceptGroup(shop, group('r5', 'g1', ['a2'], {
    groupVersion: 2, targetProductId: first.productId, expectedVersion: 1
  })), errorCode('GROUP_REMOVAL_REVIEW_REQUIRED'));
  assert.throws(() => catalog.acceptGroup(shop, group('r6', 'g3', ['b1'], {
    targetProductId: first.productId, expectedVersion: 1
  })), errorCode('ASSET_PRODUCT_CONFLICT'));
  assert.throws(() => catalog.acceptGroup(shop, group('r7', 'g1', ['a1', 'a2'], {
    groupVersion: 2, targetProductId: second.productId, expectedVersion: 1
  })), errorCode('GROUP_PRODUCT_CONFLICT'));
  assert.equal(catalog.get(shop, first.productId).productVersion, 1);
  assert.deepEqual(catalog.get(shop, first.productId).assetIds, ['a1']);
  const good = catalog.acceptGroup(shop, group('r8', 'g1', ['a1', 'a2'], {
    groupVersion: 2, targetProductId: first.productId, expectedVersion: 1
  }));
  assert.equal(good.productVersion, 2);
  assert.throws(() => catalog.acceptGroup(shop, group('r9', 'g1', ['a1'], {
    groupVersion: 1, targetProductId: first.productId, expectedVersion: 2
  })), errorCode('GROUP_VERSION_CONFLICT'));
});

test('cross-shop reads and writes do not disclose or attach another shop card or assets', t => {
  const { catalog } = fixture(t);
  const first = catalog.acceptGroup(shop, group('r1', 'g1', ['a1']));
  assert.equal(catalog.get(other, first.productId), null);
  assert.deepEqual(catalog.list(other), []);
  assert.throws(() => catalog.acceptGroup(other, group('r2', 'g2', ['a1'])), errorCode('ASSET_NOT_OWNED'));
  assert.throws(() => catalog.acceptGroup(other, group('r3', 'g2', ['elsewhere'], {
    targetProductId: first.productId, expectedVersion: 1
  })), errorCode('PRODUCT_NOT_FOUND'));
  assert.equal(catalog.list(shop).length, 1);
});

test('unknown, unconfirmed or incomplete groups never create a card', t => {
  const { catalog } = fixture(t);
  assert.throws(() => catalog.acceptGroup(shop, group('r1', 'g1', ['absent'])), errorCode('ASSET_NOT_OWNED'));
  assert.throws(() => catalog.acceptGroup(shop, group('r2', 'g2', ['a1'], { decisionSource: 'pending' })), errorCode('INCOMPLETE_GROUP'));
  assert.throws(() => catalog.acceptGroup(shop, group('r3', 'g3', [])), errorCode('INCOMPLETE_GROUP'));
  assert.deepEqual(catalog.list(shop), []);
});
