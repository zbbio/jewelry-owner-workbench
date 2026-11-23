import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSales } from '../sales/index.mjs';

const a = { shopId: 'A', actorId: 'owner' }, b = { shopId: 'B', actorId: 'owner' };
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let version = 1; const tiers = [];
  const catalog = { get(ctx, id) { return ctx.shopId === 'A' && id === 'P1' ? {
    productId: id, productVersion: version, fields: {
      title: { value: '手串', unit: null, source: 'manual' },
      description: { value: `${version}毫米`, unit: null, source: 'manual' }
    }, inventoryStatus: 'unknown', inventoryVerifiedAt: null
  } : null; } };
  const sales = createSales({ db, catalog,
    knowledge: { list: () => [{ id: 'K1', version: 1, status: 'disabled', reviewed: true }] },
    directory: { search(_ctx, { tier }) { tiers.push(tier); return []; } } });
  return { sales, tiers, setVersion(v) { version = v; } };
}
test('unknown stock persists one task, replays, and checks body', t => {
  const { sales, tiers } = fixture(t);
  const input = { requestId: 'R1', sessionId: 'S1', productId: 'P1', question: '有货吗' };
  const first = sales.ask(a, input);
  assert.equal(first.inventoryState, 'unknown'); assert.equal(first.taskIds.length, 1);
  assert.match(first.answer, /暂不承诺现货/); assert.equal(first.deliveryStatus, 'not_submitted');
  assert.deepEqual(first.knowledgeRefs, []); assert.deepEqual(tiers, ['frequent', 'other']);
  assert.equal(first.alternativeSearch.status, 'no_match');
  assert.deepEqual(sales.ask(a, input), first); assert.equal(sales.listTasks(a).length, 1);
  assert.throws(() => sales.ask(a, { ...input, question: '改问' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
});
test('shop isolation, clarification, version refresh and video demand', t => {
  const { sales, setVersion } = fixture(t);
  assert.equal(sales.ask(b, { requestId: 'X', sessionId: 'S', question: '问' }).status, 'clarification_required');
  assert.throws(() => sales.ask(b, { requestId: 'C', sessionId: 'S', productId: 'P1', question: '问' }), e => e.code === 'PRODUCT_NOT_FOUND');
  assert.equal(sales.listTasks(b).length, 0);
  setVersion(2);
  const result = sales.ask(a, { requestId: 'R2', sessionId: 'S', productId: 'P1', question: '看视频', needVideo: true });
  assert.equal(result.productRef.productVersion, 2); assert.match(result.answer, /2毫米/);
  assert.deepEqual(result.video.input, { requestId: 'R2:video', productId: 'P1', productVersion: 2, demand: '看视频', sessionId: 'S' });
  assert.throws(() => sales.ask({}, { requestId: 'R2', sessionId: 'S', question: '问' }), e => e.code === 'UNAUTHORIZED');
});
