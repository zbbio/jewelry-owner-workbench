import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createContent } from '../content/index.mjs';

const owner = { shopId: 'S1', actorId: 'A1' }, other = { shopId: 'S2', actorId: 'A2' };
const input = (requestId = 'R1', version = 1) => ({ requestId, productId: 'P1', productVersion: version, demand: '看本件视频' });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const state = { videos: [], sources: [{ assetId: 'X1', digest: 'sha', kind: 'product_shot', productId: 'P1', rights: 'usable' }], version: 1 };
  const adapters = {
    db, getProduct: (ctx, id) => ctx.shopId === 'S1' && id === 'P1' ? { productId: id, productVersion: state.version } : null,
    listOldVideos: () => state.videos,
    resolveInputs: () => ({ assets: state.sources, copyId: 'C1', copyVersion: 1, preferenceSnapshot: {}, preferenceVersion: 1 }),
    probeVideo: v => v.playable === true
  };
  return { db, state, adapters, content: createContent(adapters) };
}
test('old video is playable, licensed and product-bound; no task', t => {
  const { db, state, content } = fixture(t);
  state.videos = [{ productId: 'P2', workId: 'wrong', workVersion: 1, rights: 'usable', playable: true }, { productId: 'P1', workId: 'W1', workVersion: 1, rights: 'usable', playable: true }];
  assert.deepEqual(content.requestVideo(owner, input()), { requestId: 'R1', productId: 'P1', productVersion: 1, outcome: 'existing_available', workRef: { workId: 'W1', workVersion: 1 }, retrievalStatus: 'playable', deliveryStatus: 'not_submitted' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_tasks').get().n, 0);
});
test('queue is durable and same request replays without another task', t => {
  const { db, adapters, content } = fixture(t);
  const a = content.requestVideo(owner, input());
  assert.equal(a.outcome, 'queued'); assert.ok(a.taskId);
  assert.deepEqual(createContent(adapters).requestVideo(owner, input()), a);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_tasks').get().n, 1);
  assert.equal(content.getTask(owner, a.taskId).lockedInputs.assets[0].assetId, 'X1');
  assert.throws(() => content.requestVideo(owner, { ...input(), demand: '重剪' }), e => e.code === 'REQUEST_BODY_CONFLICT');
  assert.throws(() => content.getTask(other, a.taskId), e => e.code === 'TASK_NOT_FOUND');
});
test('missing source, stale version and rights uncertainty do not queue', t => {
  const { state, content } = fixture(t);
  state.sources = [];
  assert.equal(content.requestVideo(owner, input('R2')).outcome, 'needs_source');
  state.sources = [{ assetId: 'X1', digest: 'sha', kind: 'product_shot', productId: 'P1', rights: 'unknown' }];
  assert.equal(content.requestVideo(owner, input('R3')).outcome, 'needs_review');
  assert.equal(content.requestVideo(owner, input('R4', 2)).outcome, 'needs_review');
  assert.throws(() => content.requestVideo(other, input('R5')), e => e.code === 'PRODUCT_NOT_FOUND');
});

// The caller and content deliberately share ONE real SQLite connection.
function beginCaller(db) {
  db.exec(`CREATE TEMP TABLE caller_marks(label TEXT NOT NULL);
    BEGIN IMMEDIATE;
    INSERT INTO caller_marks VALUES ('before');`);
  const marks = db.prepare('SELECT label FROM caller_marks ORDER BY rowid');
  return () => marks.all().map(row => row.label);
}
function contentCounts(db) {
  return { ...db.prepare(`SELECT (SELECT count(*) FROM content_tasks) AS tasks,
    (SELECT count(*) FROM content_requests) AS receipts`).get() };
}

test('nested success: caller can keep writing and commit one task and receipt', t => {
  const { db, content } = fixture(t);
  const marks = beginCaller(db);
  const queued = content.requestVideo(owner, input());
  assert.equal(queued.outcome, 'queued');
  assert.deepEqual(content.requestVideo(owner, input()), queued);
  db.exec("INSERT INTO caller_marks VALUES ('after'); COMMIT");
  assert.deepEqual(marks(), ['before', 'after']);
  assert.deepEqual(contentCounts(db), { tasks: 1, receipts: 1 });
  assert.equal(content.getTask(owner, queued.taskId).status, 'queued');
});

test('nested success: caller rollback undoes content task and receipt too', t => {
  const { db, content } = fixture(t);
  const marks = beginCaller(db);
  const queued = content.requestVideo(owner, input());
  assert.deepEqual(contentCounts(db), { tasks: 1, receipts: 1 });
  db.exec('ROLLBACK');
  assert.deepEqual(marks(), []);
  assert.deepEqual(contentCounts(db), { tasks: 0, receipts: 0 });
  assert.throws(() => content.getTask(owner, queued.taskId), e => e.code === 'TASK_NOT_FOUND');
});

test('nested failure after task insert: no orphan; caller can retry and commit', t => {
  const { db, content } = fixture(t);
  // ABORT rejects only the receipt statement, not the already-inserted task.
  db.exec(`CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON content_requests
    WHEN EXISTS (SELECT 1 FROM content_tasks)
    BEGIN SELECT RAISE(ABORT, 'test receipt rejected'); END;`);
  const marks = beginCaller(db);
  assert.throws(() => content.requestVideo(owner, input()), /test receipt rejected/);
  assert.deepEqual(contentCounts(db), { tasks: 0, receipts: 0 });
  assert.deepEqual(marks(), ['before']);
  db.exec("DROP TRIGGER reject_receipt; INSERT INTO caller_marks VALUES ('after')");
  assert.equal(content.requestVideo(owner, input()).outcome, 'queued');
  db.exec('COMMIT');
  assert.deepEqual(marks(), ['before', 'after']);
  assert.deepEqual(contentCounts(db), { tasks: 1, receipts: 1 });
});

test('standalone failure leaves no open transaction on the shared connection', t => {
  const { db, content } = fixture(t);
  assert.throws(() => content.requestVideo(other, input()), e => e.code === 'PRODUCT_NOT_FOUND');
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
  assert.deepEqual(contentCounts(db), { tasks: 0, receipts: 0 });
});
