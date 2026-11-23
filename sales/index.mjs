import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { introduce, readStock, inventorySentence } from './card-evidence.mjs';

export class SalesError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.httpStatus = status; }
}
const requireText = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
const fail = (code, status) => { throw new SalesError(code, status); };
const positiveVersion = v => Number.isSafeInteger(v) && v > 0;
// A selected card is not evidence about its neighbor. Only clear, affirmative
// redirects or a standalone rejection count; "另一条不用了" and "是不是这件…" do not.
function redirectsFromCard(question) {
  return question.split(/[，。！？；,!?;\n]/u).map(s => s.trim()).some(s => {
    if (/^(?:我(?:说的|问的|想看的|要看的))?不是(?:这|本)一?[件条款个](?:商品|手串|吊坠|手镯)?(?:的(?:视频|实拍短片))?$/u.test(s)) return true;
    // “另一条的视频不用了” declines the neighbor, not the active card.
    if (/(?:不用(?:了|看)|不要了|不想看|先不看|不需要)(?:了)?$/u.test(s)) return false;
    return /^(?:(?:请)?(?:给我|让我)?看(?:看|一下)?|能(?:不能)?看|可以看|请问|我(?:想问|要问|问的是|问|想看|要看|说的是))?(?:托板上(?:的)?)?(?:另(?:外)?(?:一|那一?)|旁边(?:的)?那一?)[件条款个](?:商品|手串|吊坠|手镯)?(?:的)?(?:$|多少钱|有货|售价|价格|库存|尺寸|视频|实拍短片|能看|还有吗|怎么样)/u.test(s);
  });
}
// Only explicit requests for this item's footage; mentions of video alone are not production orders.
function asksForVideo(question) {
  const clauses = question.split(/[，。！？；,!?;\n]/u).map(s => s.trim()).filter(Boolean);
  let wants = false;
  for (const s of clauses) {
    if (/^(不用了|算了|别发了|不需要了|取消)$/u.test(s)) { wants = false; continue; }
    if (!/视频|实拍短片/u.test(s)) continue;
    if (/不要|不用|不必|不看|不想|别看|别发|别做|无需|不需要|另外|别的|另一|其他商品|其它商品|不是这件/u.test(s)) { wants = false; continue; }
    if (/(?:看(?:看)?|发(?:我)?|给我|提供|制作|做|拍)(?:[一下个段本这款件条商品的实拍旧新短]{0,12})(?:视频|实拍短片)(?:吗|么|吧|呢|好吗|可以吗)?$|(?:本件|这件|这款|这条)(?:的)?(?:视频|实拍短片)(?:能看吗|给我|发我)$/u.test(s)) wants = true;
  }
  return wants;
}

// Synchronous adapters. ctx is supplied by the authenticated server, never by the request body.
export function createSales({ db, catalog, knowledge = { list: () => [] }, policy = { list: () => [] },
  directory = null, content = null, canAccessSales = () => true, canRetrieveWork,
  getInventoryMaxAgeMs = () => null, now = Date.now }) {
  if (!db?.prepare || !db?.exec || typeof catalog?.get !== 'function') throw new TypeError('SQLite and catalog.get required');
  if (content != null && typeof content.requestVideo !== 'function') throw new TypeError('content.requestVideo(ctx, input) required');
  db.exec(`CREATE TABLE IF NOT EXISTS sales_receipts(shop_id TEXT, operation TEXT, request_id TEXT, body TEXT, receipt TEXT, PRIMARY KEY(shop_id,operation,request_id));
    CREATE TABLE IF NOT EXISTS sales_tasks(shop_id TEXT, task_id TEXT, product_id TEXT, kind TEXT, status TEXT, PRIMARY KEY(shop_id,task_id));
    CREATE INDEX IF NOT EXISTS sales_task_subject ON sales_tasks(shop_id,product_id,kind,status);
    CREATE TABLE IF NOT EXISTS sales_task_origins(shop_id TEXT NOT NULL, task_id TEXT NOT NULL, question TEXT NOT NULL,
      request_id TEXT NOT NULL, product_version INTEGER NOT NULL, PRIMARY KEY(shop_id,task_id));`);
  const receipt = db.prepare('SELECT body,receipt FROM sales_receipts WHERE shop_id=? AND operation=? AND request_id=?');
  const save = db.prepare('INSERT INTO sales_receipts VALUES(?,?,?,?,?)');
  const addTask = db.prepare('INSERT INTO sales_tasks VALUES(?,?,?,?,?)');
  const active = db.prepare("SELECT task_id FROM sales_tasks WHERE shop_id=? AND product_id=? AND kind='verify_inventory' AND status='open' ORDER BY rowid LIMIT 1");
  const resolve = db.prepare("UPDATE sales_tasks SET status='resolved' WHERE shop_id=? AND product_id=? AND kind='verify_inventory' AND status='open'");
  const addOrigin = db.prepare('INSERT INTO sales_task_origins VALUES(?,?,?,?,?)');
  const tasks = db.prepare(`SELECT t.task_id AS taskId,t.product_id AS productId,t.kind,t.status,
    o.question AS originalQuestion,o.product_version AS originalProductVersion,o.request_id AS originalRequestId
    FROM sales_tasks t LEFT JOIN sales_task_origins o ON t.shop_id=o.shop_id AND t.task_id=o.task_id
    WHERE t.shop_id=? ORDER BY t.rowid DESC`);
  function scopeFor(ctx) {
    const scope = { shopId: requireText(ctx?.shopId), actorId: requireText(ctx?.actorId) };
    if (!scope.shopId || !scope.actorId) fail('UNAUTHORIZED', 401);
    if (canAccessSales(scope) !== true) fail('FORBIDDEN', 403);
    return scope;
  }
  function visibleCard(ctx, id) {
    const card = catalog.get(ctx, id);
    if (!card || card.productId !== id || (card.shopId !== undefined && card.shopId !== ctx.shopId)) return null;
    if (!positiveVersion(card.productVersion)) fail('INVALID_CATALOG_CARD', 502);
    return card;
  }
  // Called only inside the sales write transaction. Two different questions about
  // the same still-unverified stock link to the same open owner task.
  function inventoryTask(shopId, productId, question, requestId, productVersion) {
    const existing = active.get(shopId, productId);
    if (existing) return existing.task_id;
    const id = randomUUID();
    addTask.run(shopId, id, productId, 'verify_inventory', 'open');
    addOrigin.run(shopId, id, question, requestId, productVersion);
    return id;
  }
  function readTier(ctx, productId, tier) {
    try {
      const found = directory?.search(ctx, { productId, tier });
      if (Array.isArray(found)) return { items: JSON.parse(JSON.stringify(found)) };
    } catch (error) {
      if ([401, 403].includes(error?.httpStatus) || error?.code === 'FORBIDDEN') return { status: 'not_permitted' };
      // Failure of this read-only dependency is not failure to create the stock task.
    }
    return { status: 'directory_unavailable' };
  }
  function findAlternatives(ctx, card) {
    const searchedTiers = [];
    for (const tier of ['frequent', 'other']) {
      const { items, status } = readTier(ctx, card.productId, tier);
      if (status) return { status, searchedTiers };
      searchedTiers.push(tier);
      if (items.length) return { status: 'matched', searchedTiers, ownerCandidates: items };
    }
    return { status: 'no_match', searchedTiers };
  }
  function checkPrivateCandidates(ctx, result) {
    const past = result.alternativeSearch;
    if (past?.status !== 'matched') return;
    // A once-authorized phone number is not a permanent entitlement.
    const { items, status } = readTier(ctx, result.productRef.productId, past.searchedTiers.at(-1));
    if (status === 'directory_unavailable') fail('DIRECTORY_ACCESS_UNAVAILABLE', 503);
    if (status || !past.ownerCandidates.every(c => items.some(v => isDeepStrictEqual(c, v)))) fail('FORBIDDEN', 403);
  }
  function inSalesTx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function ask(serverCtx, input) {
    const ctx = scopeFor(serverCtx), { shopId } = ctx;
    const requestId = requireText(input?.requestId), question = requireText(input?.question), sessionId = requireText(input?.sessionId);
    if (!requestId || !question || !sessionId) fail('INVALID_INPUT');
    const productId = input.productId == null ? null : requireText(input.productId);
    if (input.productId != null && !productId) fail('INVALID_INPUT');
    const inferredVideo = input.needVideo === undefined && asksForVideo(question);
    const needVideo = input.needVideo === true || inferredVideo;
    const redirected = productId !== null && redirectsFromCard(question);
    const clarify = () => ({ requestId, sessionId, status: 'clarification_required', answer: '请说明是哪一件商品。', taskIds: [], deliveryStatus: 'not_submitted' });
    const body = JSON.stringify({ sessionId, question, productId, needVideo });
    const { result, demand, replay, pastWork } = inSalesTx(() => {
      // Re-read the current scoped product even when the request has already succeeded.
      const card = productId === null ? null : visibleCard(ctx, productId);
      if (productId !== null && !card) fail('PRODUCT_NOT_FOUND', 404);
      const old = receipt.get(shopId, 'ask', requestId);
      if (old) {
        const originalId = JSON.parse(old.body).productId;
        if (originalId && originalId !== productId && !visibleCard(ctx, originalId)) fail('PRODUCT_NOT_FOUND', 404);
        const stored = JSON.parse(old.receipt);
        // Before implicit intent existed, unflagged text was persisted with needVideo:false.
        // An existing completed turn must remain historical; never queue retroactively on replay.
        const originalImplicit = inferredVideo && (stored.intentFormat??1)<3 &&
          old.body === JSON.stringify({ sessionId, question, productId, needVideo: false });
        if (old.body !== body && !originalImplicit) fail('IDEMPOTENCY_CONFLICT', 409);
        // Preserve the historical row for audit, but don't re-serve wrong-card
        // facts, or forward an old video demand, when replaying a redirected question.
        if (redirected) return { result: clarify() };
        const result = stored.result ?? stored; // v1 rows stored the result directly.
        checkPrivateCandidates(ctx, result);
        if (result.video && result.video.status !== 'not_connected') fail('LEGACY_VIDEO_REVIEW_REQUIRED', 409);
        return { result, demand: stored.demand, replay: true, pastWork: stored.pastWork };
      }
      let result, demand;
      if (!card || redirected) result = clarify();
      else {
        const refs = (knowledge.list(ctx, card.productId) ?? []).filter(x => x.status === 'active' && x.reviewed === true).map(x => ({ id: x.id, version: x.version }));
        const rules = (policy.list(ctx) ?? []).filter(x => x.status === 'active').map(x => ({ id: x.id, version: x.version }));
        const stock = readStock(card, catalog.getSummary?.(ctx, card.productId), shopId, Number(now()), getInventoryMaxAgeMs(ctx));
        const uncertain = stock.inventoryState === 'unknown' || stock.inventoryState === 'stale';
        const taskIds = uncertain ? [inventoryTask(shopId, card.productId, question, requestId, card.productVersion)] : [];
        if (!uncertain) resolve.run(shopId, card.productId);
        const alternativeSearch = uncertain || stock.inventoryState === 'out_of_stock' ? findAlternatives(ctx, card) : null;
        result = { requestId, sessionId, status: uncertain ? 'needs_owner_action' : 'answered',
          productRef: { productId: card.productId, productVersion: card.productVersion },
          knowledgeRefs: refs, policyRefs: rules, ...stock, taskIds,
          answer: introduce(card.fields, question) + inventorySentence(stock),
          ...(alternativeSearch ? { alternativeSearch } : {}), deliveryStatus: 'not_submitted' };
        if (needVideo) {
          const payload = { requestId: requestId + ':video', productId, productVersion: card.productVersion, demand: question, sessionId };
          if (content) demand = payload;
          else result.video = { status: 'not_connected', input: payload }; // not a content receipt
        }
      }
      save.run(shopId, 'ask', requestId, body, JSON.stringify({ result, demand, intentFormat: 3 }));
      return { result, demand, replay: false };
    });
    if (!demand) return result;
    // content owns its transaction. Never call it inside BEGIN IMMEDIATE. If a
    // response is lost after either commit, retry the persisted key AND version.
    if (!content) fail('CONTENT_UNAVAILABLE', 503);
    if (replay && pastWork) {
      if (!canRetrieveWork) fail('VIDEO_ACCESS_RECHECK_REQUIRED', 403);
      if (canRetrieveWork(ctx, { productId, workRef: pastWork }) !== true) fail('VIDEO_ACCESS_DENIED', 403);
    }
    const video = videoReceipt(content.requestVideo(ctx, demand), demand);
    if (video.outcome === 'existing_available') {
      // A cached playable flag is historical. If replay has no current rights
      // check, fail closed rather than disclose a withdrawn work reference.
      if (replay && !canRetrieveWork) fail('VIDEO_ACCESS_RECHECK_REQUIRED', 403);
      if ((!pastWork || !isDeepStrictEqual(pastWork,video.workRef)) && canRetrieveWork &&
          canRetrieveWork(ctx, { productId, workRef: video.workRef }) !== true) fail('VIDEO_ACCESS_DENIED', 403);
      if (!pastWork) {
        // Remember only the exact version actually offered. Content may later downgrade its
        // receipt to needs_review, which is not a replacement for the sales-side access check.
        inSalesTx(() => {
          const latest = JSON.parse(receipt.get(shopId, 'ask', requestId).receipt);
          if (latest.pastWork && !isDeepStrictEqual(latest.pastWork,video.workRef)) fail('VIDEO_VERSION_REVIEW_REQUIRED',409);
          db.prepare("UPDATE sales_receipts SET receipt=? WHERE shop_id=? AND operation='ask' AND request_id=?")
            .run(JSON.stringify({...latest,pastWork:video.workRef}),shopId,requestId);
        });
      }
    }
    return { ...result, video, taskIds: video.outcome === 'queued' ? [...result.taskIds, video.taskId] : result.taskIds };
  }
  function listTasks(serverCtx) {
    const ctx = scopeFor(serverCtx);
    return tasks.all(ctx.shopId).filter(task => visibleCard(ctx, task.productId));
  }
  return { ask, listTasks };
}

// Project exactly the v1 customer-usable content reference; no locked inputs,
// invented work IDs or external delivery claims cross this boundary.
function videoReceipt(receipt, demand) {
  const bad = () => fail('INVALID_CONTENT_RECEIPT', 502);
  if (!receipt || receipt.requestId !== demand.requestId || receipt.productId !== demand.productId ||
      receipt.productVersion !== demand.productVersion || receipt.deliveryStatus !== 'not_submitted') bad();
  const { requestId, productId, productVersion, outcome, deliveryStatus } = receipt;
  const base = { requestId, productId, productVersion, outcome };
  if (outcome === 'existing_available') {
    const ref = receipt.workRef;
    if (receipt.retrievalStatus !== 'playable' || !requireText(ref?.workId) || !positiveVersion(ref.workVersion) || receipt.taskId != null) bad();
    return { ...base, workRef: { workId: ref.workId, workVersion: ref.workVersion }, retrievalStatus: 'playable', deliveryStatus };
  }
  if (outcome === 'queued' && requireText(receipt.taskId)) return { ...base, taskId: receipt.taskId, deliveryStatus };
  if (['needs_source', 'needs_review'].includes(outcome) && requireText(receipt.nextAction))
    return { ...base, nextAction: receipt.nextAction, deliveryStatus };
  bad();
}
