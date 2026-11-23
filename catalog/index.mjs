import { randomUUID } from 'node:crypto';

export class CatalogError extends Error {
  constructor(code, httpStatus, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const fail = (code, status, message) => { throw new CatalogError(code, status, message); };
const has = (obj, key) => Object.hasOwn(obj, key);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', 400, `${name} is required`);
  return value.trim();
};

export function createCatalog({ db, hasAsset, canVerifyInventory } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw new TypeError('db must be DatabaseSync');
  if (typeof hasAsset !== 'function') throw new TypeError('hasAsset must be synchronous');
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_products (
      shop_id TEXT NOT NULL, product_id TEXT NOT NULL, product_version INTEGER NOT NULL,
      fields_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (shop_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS catalog_groups (
      shop_id TEXT NOT NULL, group_id TEXT NOT NULL, group_version INTEGER NOT NULL,
      product_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      PRIMARY KEY (shop_id, group_id)
    );
    CREATE TABLE IF NOT EXISTS catalog_product_assets (
      shop_id TEXT NOT NULL, asset_id TEXT NOT NULL, product_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY (shop_id, asset_id), UNIQUE (shop_id, product_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS catalog_receipts (
      shop_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
      body_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
      PRIMARY KEY (shop_id, operation, request_id)
    );
    -- Reads resolve an asset's first link from immutable committed receipts.
    -- Skip updates and no-ops to avoid scanning every replay when reading a card.
    CREATE INDEX IF NOT EXISTS catalog_asset_origin_receipts
      ON catalog_receipts(shop_id, json_extract(receipt_json, '$.productId'))
      WHERE operation='acceptGroup' AND json_array_length(receipt_json, '$.addedAssetIds')>0;
    CREATE TABLE IF NOT EXISTS catalog_inventory (
      shop_id TEXT NOT NULL, product_id TEXT NOT NULL, status TEXT NOT NULL,
      quantity INTEGER, verified_at TEXT NOT NULL, verified_by TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      PRIMARY KEY (shop_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS catalog_copy_versions (
      shop_id TEXT NOT NULL, product_id TEXT NOT NULL, copy_id TEXT NOT NULL,
      version INTEGER NOT NULL, product_version INTEGER NOT NULL, body TEXT NOT NULL,
      confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL,
      PRIMARY KEY (shop_id,product_id,version)
    );
  `);

  const qProduct = db.prepare('SELECT product_version,fields_json FROM catalog_products WHERE shop_id=? AND product_id=?');
  const qCopy = db.prepare('SELECT * FROM catalog_copy_versions WHERE shop_id=? AND product_id=? ORDER BY version DESC LIMIT 1');
  function copyProjection(shopId, productId) {
    const c = qCopy.get(shopId, productId);
    return c ? {copyId:c.copy_id,copyVersion:c.version,copyText:c.body,copyProductVersion:c.product_version,
      copyConfirmedBy:c.confirmed_by,copyConfirmedAt:c.confirmed_at} : {copyId:null,copyVersion:null};
  }
  const qGroup = db.prepare('SELECT group_version,product_id,snapshot_json FROM catalog_groups WHERE shop_id=? AND group_id=?');
  const qReceipt = db.prepare('SELECT body_json,receipt_json FROM catalog_receipts WHERE shop_id=? AND operation=? AND request_id=?');
  const qAssets = db.prepare('SELECT asset_id FROM catalog_product_assets WHERE shop_id=? AND product_id=? ORDER BY ordinal,asset_id');
  const qOwner = db.prepare('SELECT product_id FROM catalog_product_assets WHERE shop_id=? AND asset_id=?');
  const qOrdinal = db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS n FROM catalog_product_assets WHERE shop_id=? AND product_id=?');
  const addProduct = db.prepare("INSERT INTO catalog_products(shop_id,product_id,product_version,fields_json) VALUES(?,?,1,'{}')");
  const addGroup = db.prepare('INSERT INTO catalog_groups(shop_id,group_id,group_version,product_id,snapshot_json) VALUES(?,?,?,?,?)');
  const setGroup = db.prepare('UPDATE catalog_groups SET group_version=?,snapshot_json=? WHERE shop_id=? AND group_id=? AND group_version=?');
  const addAsset = db.prepare('INSERT INTO catalog_product_assets(shop_id,asset_id,product_id,ordinal) VALUES(?,?,?,?)');
  const bumpProduct = db.prepare('UPDATE catalog_products SET product_version=product_version+1 WHERE shop_id=? AND product_id=? AND product_version=?');
  const addReceipt = db.prepare('INSERT INTO catalog_receipts(shop_id,operation,request_id,body_json,receipt_json) VALUES(?,?,?,?,?)');
  const qInventory = db.prepare('SELECT status,quantity,verified_at,verified_by,evidence_ref FROM catalog_inventory WHERE shop_id=? AND product_id=?');
  const putInventory = db.prepare(`INSERT INTO catalog_inventory(shop_id,product_id,status,quantity,verified_at,verified_by,evidence_ref)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(shop_id,product_id) DO UPDATE SET
    status=excluded.status,quantity=excluded.quantity,verified_at=excluded.verified_at,
    verified_by=excluded.verified_by,evidence_ref=excluded.evidence_ref`);
  const putFacts = db.prepare('UPDATE catalog_products SET fields_json=?,product_version=product_version+1 WHERE shop_id=? AND product_id=? AND product_version=?');
  const qAssetOrigins = db.prepare(`SELECT a.value AS asset_id,
      json_extract(r.body_json, '$.groupId') AS group_id,
      json_extract(r.body_json, '$.groupVersion') AS group_version,
      json_extract(r.body_json, '$.decisionSource') AS source,
      json_extract(r.body_json, '$.evidenceRef') AS evidence
    FROM catalog_receipts r, json_each(r.receipt_json, '$.addedAssetIds') a
    WHERE r.shop_id=? AND json_extract(r.receipt_json, '$.productId')=?
      AND r.operation='acceptGroup' AND json_array_length(r.receipt_json, '$.addedAssetIds')>0
    ORDER BY r.rowid`);

  function identity(ctx) {
    if (!ctx || typeof ctx !== 'object') fail('UNAUTHORIZED', 401, 'server context required');
    return { shopId: text(ctx.shopId, 'shopId'), actorId: text(ctx.actorId, 'actorId') };
  }
  function tx(fn) {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      if (begun) { try { db.exec('ROLLBACK'); } catch { /* commit may have completed */ } }
      if (error instanceof CatalogError) throw error;
      if (/SQLITE_BUSY|database is locked/i.test(String(error?.message))) fail('TEMPORARILY_UNAVAILABLE', 503, 'database busy');
      if (/constraint/i.test(String(error?.message))) fail('CONFLICT', 409, 'conflicting write');
      throw error;
    }
  }

  function normalize(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_INPUT', 400, 'request object required');
    const value = {
      requestId: text(request.requestId, 'requestId'),
      taskId: text(request.taskId, 'taskId'),
      groupId: text(request.groupId, 'groupId'),
      groupVersion: request.groupVersion,
      keptAssetIds: request.keptAssetIds,
      decisionSource: text(request.decisionSource, 'decisionSource'),
      evidenceRef: text(request.evidenceRef, 'evidenceRef')
    };
    if (!Number.isSafeInteger(value.groupVersion) || value.groupVersion < 1) fail('INVALID_INPUT', 400, 'groupVersion must be positive integer');
    if (!Array.isArray(value.keptAssetIds) || !value.keptAssetIds.length || value.keptAssetIds.some(a => typeof a !== 'string' || !a.trim())) fail('INCOMPLETE_GROUP', 400, 'keptAssetIds required');
    value.keptAssetIds = value.keptAssetIds.map(a => a.trim());
    if (new Set(value.keptAssetIds).size !== value.keptAssetIds.length) fail('INVALID_INPUT', 400, 'duplicate asset in snapshot');
    if (!['system_checked', 'owner_confirmed', 'human_confirmed', 'manual_confirmed'].includes(value.decisionSource)) fail('INCOMPLETE_GROUP', 400, 'group is not confirmed');
    if (has(request, 'targetProductId')) value.targetProductId = text(request.targetProductId, 'targetProductId');
    if (has(request, 'expectedVersion')) {
      if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) fail('INVALID_INPUT', 400, 'expectedVersion must be positive integer');
      value.expectedVersion = request.expectedVersion;
    }
    if (has(value, 'targetProductId') !== has(value, 'expectedVersion')) fail('INVALID_INPUT', 400, 'targetProductId and expectedVersion must be paired');
    return value;
  }

  function card(shopId, productId, row) {
    const inventory = qInventory.get(shopId, productId);
    return {
      productId, productVersion: row.product_version,
      assetIds: qAssets.all(shopId, productId).map(r => r.asset_id),
      fields: JSON.parse(row.fields_json),
      inventoryStatus: inventory?.status ?? 'unknown', inventoryVerifiedAt: inventory?.verified_at ?? null,
      ...copyProjection(shopId, productId)
    };
  }
  function get(ctx, productId) {
    const { shopId } = identity(ctx);
    const id = text(productId, 'productId');
    const row = qProduct.get(shopId, id);
    return row ? card(shopId, id, row) : null;
  }
  function list(ctx) {
    const { shopId } = identity(ctx);
    const rows = db.prepare('SELECT product_id,product_version,fields_json FROM catalog_products WHERE shop_id=? ORDER BY product_id').all(shopId);
    return rows.map(row => card(shopId, row.product_id, row));
  }

  function getSummary(ctx, productId) {
    const { shopId } = identity(ctx);
    const id = text(productId, 'productId');
    const row = qProduct.get(shopId, id);
    if (!row) return null;
    const result = card(shopId, id, row);
    const inventory = qInventory.get(shopId, id);
    const provenance = new Map();
    for (const origin of qAssetOrigins.all(shopId, id)) {
      if (!provenance.has(origin.asset_id)) provenance.set(origin.asset_id, {
        groupId: origin.group_id, groupVersion: origin.group_version,
        decisionSource: origin.source, evidenceRef: origin.evidence
      });
    }
    return {
      productId: id, productVersion: result.productVersion,
      fields: result.fields,
      inventory: inventory ? {
        status: inventory.status, quantity: inventory.quantity,
        verifiedAt: inventory.verified_at, verifiedBy: inventory.verified_by,
        evidenceRef: inventory.evidence_ref
      } : { status: 'unknown', quantity: null, verifiedAt: null, verifiedBy: null, evidenceRef: null },
      assetRefs: result.assetIds.map(assetId => ({ assetId, ...(provenance.get(assetId) ?? {}), sha256: null })),
      ...copyProjection(shopId, id)
    };
  }

  function normalizeUpdate(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_INPUT', 400, 'request object required');
    const input = {
      requestId: text(request.requestId, 'requestId'),
      productId: text(request.productId, 'productId'),
      expectedVersion: request.expectedVersion,
      changes: request.changes ?? []
    };
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT', 400, 'expectedVersion must be positive integer');
    if (!Array.isArray(input.changes)) fail('INVALID_INPUT', 400, 'changes must be an array');
    const seen = new Set();
    input.changes = input.changes.map(change => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) fail('INVALID_INPUT', 400, 'change must be an object');
      const field = text(change.field, 'field');
      if (!/^[a-z][A-Za-z0-9_]{0,63}$/.test(field) || ['inventory', 'inventoryStatus', 'inventoryVerifiedAt', 'copyId', 'copyVersion', 'copyText', 'copyProductVersion', 'copyConfirmedBy', 'copyConfirmedAt', 'productId', 'productVersion', 'assetIds'].includes(field)) fail('INVALID_INPUT', 400, 'reserved or invalid field');
      if (seen.has(field)) fail('INVALID_INPUT', 400, 'duplicate field change');
      seen.add(field);
      if (!has(change, 'value') || !(change.value === null || typeof change.value === 'string' || (typeof change.value === 'number' && Number.isFinite(change.value)))) fail('INVALID_INPUT', 400, 'value must be string, finite number or null');
      const source = text(change.source, 'source');
      if (!['manual', 'ai_suggestion', 'imported'].includes(source)) fail('INVALID_INPUT', 400, 'invalid source');
      const dimensional = /^(size|length|width|thickness|beadDiameter|innerDiameter|braceletLength|circumference)$/i.test(field);
      if (dimensional && change.value !== null && source !== 'manual') fail('MANUAL_MEASUREMENT_REQUIRED', 400, 'dimensions require human entry');
      const unit = change.unit === undefined || change.unit === null ? null : text(change.unit, 'unit');
      if (dimensional && change.value !== null && !unit) fail('INVALID_INPUT', 400, 'dimension unit required');
      return { field, value: change.value, unit, source };
    });
    if (has(request, 'inventory')) {
      const inv = request.inventory;
      if (!inv || typeof inv !== 'object' || Array.isArray(inv)) fail('INVALID_INPUT', 400, 'inventory object required');
      if (!['in_stock', 'out_of_stock'].includes(inv.status)) fail('INVALID_INPUT', 400, 'verified inventory status required');
      const quantity = inv.quantity === undefined || inv.quantity === null ? null : inv.quantity;
      if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 0)) fail('INVALID_INPUT', 400, 'quantity must be a nonnegative integer');
      if ((inv.status === 'out_of_stock' && quantity !== null && quantity !== 0) || (inv.status === 'in_stock' && quantity === 0)) fail('INVALID_INPUT', 400, 'quantity conflicts with status');
      input.inventory = { status: inv.status, quantity, evidenceRef: text(inv.evidenceRef, 'inventory.evidenceRef') };
    }
    if (!input.changes.length && !input.inventory) fail('INVALID_INPUT', 400, 'no changes');
    return input;
  }

  function update(ctx, request) {
    const { shopId, actorId } = identity(ctx);
    const input = normalizeUpdate(request);
    const body = JSON.stringify(input);
    return tx(() => {
      const prior = qReceipt.get(shopId, 'update', input.requestId);
      if (prior) {
        if (prior.body_json !== body) fail('IDEMPOTENCY_CONFLICT', 409, 'requestId used with different body');
        if (!qProduct.get(shopId, input.productId)) fail('PRODUCT_NOT_FOUND', 404, 'product not found in current shop');
        if (input.inventory && canVerifyInventory?.(ctx, input.inventory) !== true) fail('INVENTORY_VERIFICATION_REQUIRED', 403, 'owner verification required');
        return JSON.parse(prior.receipt_json);
      }
      const current = qProduct.get(shopId, input.productId);
      if (!current) fail('PRODUCT_NOT_FOUND', 404, 'product not found in current shop');
      if (current.product_version !== input.expectedVersion) fail('VERSION_CONFLICT', 409, `currentVersion=${current.product_version}`);
      if (input.inventory && canVerifyInventory?.(ctx, input.inventory) !== true) fail('INVENTORY_VERIFICATION_REQUIRED', 403, 'owner verification required');
      const fields = JSON.parse(current.fields_json);
      const now = new Date().toISOString();
      const changedFields = [];
      for (const change of input.changes) {
        const previous = fields[change.field];
        if (previous?.source === 'manual' && change.source !== 'manual') fail('MANUAL_VALUE_PROTECTED', 409, 'human value cannot be replaced by a suggestion');
        if (previous?.value === change.value && previous?.unit === change.unit && previous?.source === change.source) continue;
        fields[change.field] = { value: change.value, unit: change.unit, source: change.source, updatedBy: actorId, updatedAt: now };
        changedFields.push(change.field);
      }
      const previousInventory = qInventory.get(shopId, input.productId);
      const inventoryChanged = Boolean(input.inventory) && (
        previousInventory?.status !== input.inventory.status ||
        previousInventory?.quantity !== input.inventory.quantity ||
        previousInventory?.evidence_ref !== input.inventory.evidenceRef
      );
      if (changedFields.length || inventoryChanged) {
        if (putFacts.run(JSON.stringify(fields), shopId, input.productId, input.expectedVersion).changes !== 1) fail('VERSION_CONFLICT', 409, 'product changed concurrently');
        if (inventoryChanged) putInventory.run(shopId, input.productId, input.inventory.status, input.inventory.quantity, now, actorId, input.inventory.evidenceRef);
      }
      const receipt = {
        status: 'committed', requestId: input.requestId, productId: input.productId,
        productVersion: qProduct.get(shopId, input.productId).product_version,
        changedFields, inventoryChanged, outcome: changedFields.length || inventoryChanged ? 'updated' : 'unchanged'
      };
      addReceipt.run(shopId, 'update', input.requestId, body, JSON.stringify(receipt));
      return receipt;
    });
  }

  function acceptGroup(ctx, request) {
    const { shopId } = identity(ctx);
    const input = normalize(request);
    const body = JSON.stringify(input);
    return tx(() => {
      const prior = qReceipt.get(shopId, 'acceptGroup', input.requestId);
      if (prior) {
        if (prior.body_json !== body) fail('IDEMPOTENCY_CONFLICT', 409, 'requestId used with different body');
        // Authorization precedes even replay disclosure.
        for (const assetId of input.keptAssetIds) if (hasAsset(ctx, assetId) !== true) fail('ASSET_NOT_OWNED', 404, 'asset not in current shop');
        return JSON.parse(prior.receipt_json);
      }
      for (const assetId of input.keptAssetIds) if (hasAsset(ctx, assetId) !== true) fail('ASSET_NOT_OWNED', 404, 'asset not in current shop');
      const old = qGroup.get(shopId, input.groupId);
      const snapshot = JSON.stringify({ taskId: input.taskId, keptAssetIds: input.keptAssetIds, decisionSource: input.decisionSource, evidenceRef: input.evidenceRef });
      let productId;
      let outcome;
      const addedAssetIds = [];
      if (old) {
        if (input.groupVersion < old.group_version) fail('GROUP_VERSION_CONFLICT', 409, 'stale group version');
        if (input.groupVersion === old.group_version && snapshot !== old.snapshot_json) fail('GROUP_VERSION_CONFLICT', 409, 'same group version has different body');
        productId = old.product_id;
        if (input.targetProductId && input.targetProductId !== productId) fail('GROUP_PRODUCT_CONFLICT', 409, 'group belongs to another product');
        if (input.groupVersion > old.group_version) {
          if (!input.targetProductId) fail('INVALID_INPUT', 400, 'group update requires targetProductId and expectedVersion');
          const former = JSON.parse(old.snapshot_json).keptAssetIds;
          if (former.some(a => !input.keptAssetIds.includes(a))) fail('GROUP_REMOVAL_REVIEW_REQUIRED', 409, 'group update removes an asset');
        }
      } else if (input.targetProductId) {
        productId = input.targetProductId;
      } else {
        if (input.groupVersion !== 1) fail('GROUP_VERSION_CONFLICT', 409, 'new group must start at version 1');
        productId = randomUUID();
        addProduct.run(shopId, productId);
        outcome = 'created';
      }
      const current = qProduct.get(shopId, productId);
      if (!current) fail('PRODUCT_NOT_FOUND', 404, 'target product not found in current shop');
      // A fresh requestId may repeat an already-applied group snapshot with its old
      // expectedVersion. This is a pure no-op only if every asset is still on the
      // mapped product; actual changes continue to require the current version.
      const exactNoop = old && input.groupVersion === old.group_version &&
        input.keptAssetIds.every(assetId => qOwner.get(shopId, assetId)?.product_id === productId);
      if (input.targetProductId && current.product_version !== input.expectedVersion && !(exactNoop && input.expectedVersion < current.product_version)) fail('VERSION_CONFLICT', 409, `currentVersion=${current.product_version}`);
      let ordinal = qOrdinal.get(shopId, productId).n;
      for (const assetId of input.keptAssetIds) {
        const owner = qOwner.get(shopId, assetId);
        if (owner && owner.product_id !== productId) fail('ASSET_PRODUCT_CONFLICT', 409, 'asset belongs to another product');
        if (!owner) { addAsset.run(shopId, assetId, productId, ordinal++); addedAssetIds.push(assetId); }
      }
      if (old) {
        if (input.groupVersion > old.group_version && setGroup.run(input.groupVersion, snapshot, shopId, input.groupId, old.group_version).changes !== 1) fail('GROUP_VERSION_CONFLICT', 409, 'group changed concurrently');
      } else addGroup.run(shopId, input.groupId, input.groupVersion, productId, snapshot);
      if (!outcome) {
        if (addedAssetIds.length) {
          if (bumpProduct.run(shopId, productId, current.product_version).changes !== 1) fail('VERSION_CONFLICT', 409, 'product changed concurrently');
          outcome = 'images_added';
        } else outcome = 'unchanged';
      }
      const receipt = {
        status: 'committed', requestId: input.requestId, taskId: input.taskId,
        groupId: input.groupId, groupVersion: input.groupVersion,
        productId, productVersion: qProduct.get(shopId, productId).product_version,
        linkedAssetIds: qAssets.all(shopId, productId).map(r => r.asset_id),
        addedAssetIds, outcome
      };
      addReceipt.run(shopId, 'acceptGroup', input.requestId, body, JSON.stringify(receipt));
      return receipt;
    });
  }

  // Copy is an owner-confirmed document, not a new source of measured facts.
  function saveCopy(ctx, req) {
    const {shopId,actorId} = identity(ctx);
    if (ctx.role !== 'owner') fail('OWNER_REQUIRED',403,'请由店主确认商品介绍。');
    const input={requestId:text(req?.requestId,'requestId'),productId:text(req?.productId,'productId'),
      expectedVersion:req?.expectedVersion,text:text(req?.text,'text').replace(/\r\n?/g,'\n')};
    if (!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||[...input.text].length>180||
      /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(input.text)) fail('INVALID_INPUT',400,'介绍限 1–180 个字符。');
    const body=JSON.stringify(input);
    return tx(()=>{
      const id=input.productId,row=qProduct.get(shopId,id);
      if(!row) fail('PRODUCT_NOT_FOUND',404,'没有本店这张商品卡。');
      const prior=qReceipt.get(shopId,'saveCopy',input.requestId);
      if(prior) {
        if(prior.body_json!==body) fail('IDEMPOTENCY_CONFLICT',409,'同一请求号的文案不同。');
        return JSON.parse(prior.receipt_json);
      }
      if(row.product_version!==input.expectedVersion) fail('VERSION_CONFLICT',409,'商品已更新；请重读后确认。');
      const prev=qCopy.get(shopId,id);
      const changed=prev?.body!==input.text||prev?.product_version!==row.product_version;
      const copyId=prev?.copy_id??randomUUID(),copyVersion=(prev?.version??0)+(changed?1:0);
      const productVersion=row.product_version+(changed?1:0);
      if(changed) {
        if(bumpProduct.run(shopId,id,row.product_version).changes!==1) fail('VERSION_CONFLICT',409,'商品版本已变。');
        db.prepare('INSERT INTO catalog_copy_versions VALUES(?,?,?,?,?,?,?,?)').run(shopId,id,copyId,copyVersion,productVersion,input.text,actorId,new Date().toISOString());
      }
      const out={status:'committed',outcome:changed?'updated':'unchanged',requestId:input.requestId,productId:id,productVersion,copyId,copyVersion,text:input.text};
      addReceipt.run(shopId,'saveCopy',input.requestId,body,JSON.stringify(out));return out;
    });
  }
  return { acceptGroup, list, get, getSummary, update, saveCopy };
}
