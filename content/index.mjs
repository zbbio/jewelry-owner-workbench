import { randomUUID } from 'node:crypto';
import { createLocalVideoStore } from './local-video.mjs';

export class ContentError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status = 400) => { throw new ContentError(code, status); };
const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : fail('INVALID_INPUT');
const validVersion = v => Number.isSafeInteger(v) && v > 0;

// Adapters must return only records visible to ctx; this service rechecks identity and rights.
export function createContent({ db, getProduct, listOldVideos, resolveInputs, readSourceState, probeVideo, mediaRoot }) {
  const media = mediaRoot ? createLocalVideoStore(mediaRoot) : null;
  // The version registry (not the client) binds this specific file snapshot to the work revision.
  const readRevision = v => typeof v.mediaSha256 === 'string' && /^[0-9a-f]{64}$/.test(v.mediaSha256)
    ? media.readPlayable(v.mediaKey, v.mediaSha256) : null;
  if (media) probeVideo = v => readRevision(v) !== null;
  if (!db?.prepare || !db?.exec || ![getProduct, listOldVideos, resolveInputs, probeVideo].every(f => typeof f === 'function')) throw new TypeError('content adapters required');
  if (readSourceState !== undefined && typeof readSourceState !== 'function') throw new TypeError('readSourceState must be synchronous');
  db.exec(`CREATE TABLE IF NOT EXISTS content_requests (
    shop_id TEXT NOT NULL, request_id TEXT NOT NULL, body_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY(shop_id,request_id));
    CREATE TABLE IF NOT EXISTS content_tasks (
    shop_id TEXT NOT NULL, task_id TEXT NOT NULL, product_id TEXT NOT NULL,
    product_version INTEGER NOT NULL, locked_json TEXT NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY(shop_id,task_id));`);
  const receiptQ = db.prepare('SELECT body_json,receipt_json FROM content_requests WHERE shop_id=? AND request_id=?');
  const receiptI = db.prepare('INSERT INTO content_requests VALUES(?,?,?,?)');
  const taskI = db.prepare('INSERT INTO content_tasks VALUES(?,?,?,?,?,?)');
  const taskQ = db.prepare('SELECT product_id,product_version,locked_json,status FROM content_tasks WHERE shop_id=? AND task_id=?');
  function identity(ctx) { if (!ctx?.shopId || !ctx?.actorId) fail('UNAUTHORIZED', 401); return { shopId: str(ctx.shopId), actorId: str(ctx.actorId) }; }
  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT');
    const body = { requestId: str(input.requestId), productId: str(input.productId), productVersion: input.productVersion, demand: str(input.demand) };
    if (!validVersion(body.productVersion)) fail('INVALID_INPUT');
    if (input.sessionId !== undefined) body.sessionId = str(input.sessionId);
    if (input.choiceId !== undefined) body.choiceId = str(input.choiceId);
    return body;
  }
  function tx(fn) {
    // RELEASE commits only if this savepoint started the transaction.
    const name = 'content_video_' + randomUUID().replaceAll('-', '');
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        // ROLLBACK TO undoes our writes but leaves the named savepoint open.
        db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'content savepoint cleanup failed', { cause: error });
      }
      throw error;
    }
  }
  function visibleClips(scope, productId) {
    const items = listOldVideos(scope, productId) ?? [];
    if (!Array.isArray(items)) fail('ADAPTER_ERROR', 503);
    return items.filter(v => v && v.productId === productId && (v.shopId === scope.shopId || (!media && !v.shopId)));
  }
  const licensed = v => v.rights === 'usable' && v.withdrawn !== true && validVersion(v.workVersion) && typeof v.workId === 'string' && !!v.workId.trim();
  const hasSourceList = p => Object.hasOwn(p, 'assetIds') || Object.hasOwn(p, 'assetRefs');
  // Card membership belongs to catalog, not to the adapter that proposes shots.
  // Its two public projections are get().assetIds and getSummary().assetRefs.
  function sourcesMatch(scope, product, assets) {
    const lists = [];
    if (Object.hasOwn(product, 'assetIds')) lists.push(product.assetIds);
    if (Object.hasOwn(product, 'assetRefs')) lists.push(Array.isArray(product.assetRefs) ? product.assetRefs.map(r => r?.assetId) : null);
    if (lists.some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()))) return false;
    // Legacy bare-card fixtures, without a live lookup, have only their scoped adapter's contract.
    if (!lists.length && readSourceState) return false;
    return assets.every(a => {
      if (!a || a.productId !== product.productId || (a.shopId && a.shopId !== scope.shopId) ||
          a.rights !== 'usable' || a.withdrawn === true || !a.assetId || !a.digest) return false;
      // Off-card style/background requires independent evidence of that role. Renaming a shot is not evidence.
      if ((a.kind === 'product_shot' || !readSourceState) && !lists.every(ids => ids.includes(a.assetId))) return false;
      if (!readSourceState) return true;
      // Look up the actual id in the shop's source registry, never look up by the proposed product label.
      const live = readSourceState(scope, a.assetId, a);
      return !!live && live.shopId === scope.shopId && live.assetId === a.assetId && live.kind === a.kind &&
        live.rights === 'usable' && live.withdrawn === false && /^[a-f0-9]{64}$/.test(live.digest) && live.digest === a.digest;
    });
  }
  function requestVideo(ctx, input) {
    const scope = identity(ctx), body = normalize(input), serialized = JSON.stringify(body);
    return tx(() => {
      const product = getProduct(scope, body.productId);
      if (!product || product.productId !== body.productId || (product.shopId && product.shopId !== scope.shopId)) fail('PRODUCT_NOT_FOUND', 404);
      const prior = receiptQ.get(scope.shopId, body.requestId);
      if (prior) {
        if (prior.body_json !== serialized) fail('REQUEST_BODY_CONFLICT', 409);
        const history = JSON.parse(prior.receipt_json);
        if (history.outcome === 'existing_available') {
          const live = product.productVersion === body.productVersion && visibleClips(scope, body.productId)
            .some(v => v.workId === history.workRef.workId && v.workVersion === history.workRef.workVersion && licensed(v) && probeVideo(v) === true);
          if (!live) return {requestId:body.requestId, productId:body.productId, productVersion:body.productVersion, outcome:'needs_review', nextAction:'复核当前事实及指定版旧片许可和文件', deliveryStatus:'not_submitted'};
        }
        return history;
      }
      const base = { requestId: body.requestId, productId: body.productId, productVersion: body.productVersion };
      let result;
      if (product.productVersion !== body.productVersion) result = { ...base, outcome: 'needs_review', nextAction: '重读商品版本', deliveryStatus: 'not_submitted' };
      else {
        const candidates = visibleClips(scope, body.productId);
        const old = candidates.find(v => licensed(v) && probeVideo(v) === true);
        if (old) result = { ...base, outcome: 'existing_available', workRef: { workId: old.workId, workVersion: old.workVersion }, retrievalStatus: 'playable', deliveryStatus: 'not_submitted' };
        else if (candidates.some(v => v.productId === body.productId && (!v.shopId || v.shopId === scope.shopId) && (v.rights !== 'usable' || v.withdrawn === true))) result = { ...base, outcome: 'needs_review', nextAction: '复核旧片许可', deliveryStatus: 'not_submitted' };
        else {
          const locked = resolveInputs(scope, structuredClone(product), body.demand, body);
          if (['needs_source','needs_review'].includes(locked?.blockedOutcome) && typeof locked.nextAction==='string') result = {...base,outcome:locked.blockedOutcome,nextAction:locked.nextAction,deliveryStatus:'not_submitted'};
          else if (!locked || !Array.isArray(locked.assets) || !locked.assets.some(a => a?.kind === 'product_shot' && a.productId === body.productId)) result = { ...base, outcome: 'needs_source', nextAction: '补拍本件实拍', deliveryStatus: 'not_submitted' };
          else if (!sourcesMatch(scope, product, locked.assets) || !locked.copyId || !validVersion(locked.copyVersion) || !locked.preferenceSnapshot || !validVersion(locked.preferenceVersion)) result = { ...base, outcome: 'needs_review', nextAction: '复核本件素材归属、许可、文案或偏好版本', deliveryStatus: 'not_submitted' };
          else {
            // A one-use selection may be reached independently from sales and the original card.
            // Both must converge on the same durable task, even with different request IDs.
            const priorTask = locked.choiceId && db.prepare(`SELECT task_id FROM content_tasks
              WHERE shop_id=? AND product_id=? AND product_version=? AND json_extract(locked_json,'$.choiceId')=?`)
              .get(scope.shopId,body.productId,body.productVersion,locked.choiceId);
            const taskId = priorTask?.task_id ?? randomUUID();
            const guard = { card:hasSourceList(product), live:!!readSourceState };
            if (!priorTask) taskI.run(scope.shopId, taskId, body.productId, body.productVersion, JSON.stringify({ ...locked, demand: body.demand, __contentSourceGuard:guard }), 'queued');
            result = { ...base, outcome: 'queued', taskId, deliveryStatus: 'not_submitted' };
          }
        }
      }
      receiptI.run(scope.shopId, body.requestId, serialized, JSON.stringify(result));
      return result;
    });
  }
  function getTask(ctx, taskId) {
    const scope = identity(ctx), row = taskQ.get(scope.shopId, str(taskId));
    if (!row) fail('TASK_NOT_FOUND', 404);
    const current = getProduct(scope, row.product_id);
    if (!current || current.productId !== row.product_id || (current.shopId && current.shopId !== scope.shopId)) fail('TASK_NOT_FOUND', 404);
    const { __contentSourceGuard:guard, ...lockedInputs } = JSON.parse(row.locked_json);
    if ((guard?.card && !hasSourceList(current)) || (guard?.live && !readSourceState) ||
        !sourcesMatch(scope, current, lockedInputs.assets)) return { taskId, productId: row.product_id, productVersion: row.product_version,
      currentProductVersion: current.productVersion, status:'needs_review', recordedStatus:row.status, needsReview:true, nextAction:'复核本件实拍归属、文件及当前许可' };
    if (current.productVersion !== row.product_version) return { taskId, productId: row.product_id, productVersion: row.product_version,
      currentProductVersion: current.productVersion, lockedInputs, status:'needs_review', recordedStatus:row.status, needsReview:true, nextAction:'商品事实版本变化，重读商品并复核草稿' };
    return { taskId, productId: row.product_id, productVersion: row.product_version, status: row.status, lockedInputs };
  }
  function openOldVideo(ctx, input) {
    const scope = identity(ctx), pid = str(input?.productId), wid = str(input?.workId), ver = input?.workVersion;
    if (!validVersion(ver)) fail('INVALID_INPUT');
    const p = getProduct(scope,pid);
    if (!p || p.productId !== pid || (p.shopId && p.shopId !== scope.shopId)) fail('WORK_NOT_AVAILABLE',404);
    if (!media) fail('MEDIA_STORE_REQUIRED',503);
    const v = visibleClips(scope,pid).find(x => x.workId === wid && x.workVersion === ver && licensed(x));
    const playable = v && readRevision(v);
    if (!playable) fail('WORK_NOT_AVAILABLE',404);
    // An explicitly pinned card version is checked only after confirming this exact licensed work.
    if (input.productVersion !== undefined) {
      if (!validVersion(input.productVersion)) fail('INVALID_INPUT',400);
      if (p.productVersion !== input.productVersion) fail('PRODUCT_VERSION_CONFLICT',409);
    }
    return { productId:pid, productVersion:p.productVersion, workId:wid, workVersion:ver, ...playable };
  }
  return { requestVideo, getTask, openOldVideo };
}
