const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;

// Card copy is not a stock source. Omit promotional availability text rather
// than repeat a promise in one sentence and contradict it in the next.
const availabilityCopy = /现货|有货|无货|没货|库存|售罄|缺货|断货|发货|包发|包到|秒发|in[ -]?stock|sold[ -]?out/i;
function display(field) {
  if (!field || field.source === 'ai_suggestion') return null;
  const value = text(field.value) ?? (Number.isFinite(field.value) ? String(field.value) : null);
  if (!value) return null;
  const unit = text(field.unit);
  const label = unit ? value + ' ' + unit : value;
  return availabilityCopy.test(label) ? null : label;
}

const asksPrice = q => /多少钱|多少元|什么价|什么价格|售价|卖价|价格|标价|报价/u.test(q);
// Do not use prose, cost, suggested numbers, guesses about currency, or conflicting fields.
function manualPrice(fields) {
  const amounts = [fields.salePrice, fields.price].filter(f => f?.source === 'manual' &&
    ['元','人民币元','人民币','CNY','RMB'].includes(f.unit)).map(f => f.value)
    .filter(v => (typeof v === 'string' || typeof v === 'number') &&
      /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(v)) && Number(v) > 0 && Number.isSafeInteger(Math.round(Number(v)*100)))
    .map(Number);
  return amounts.length && amounts.every(x => x === amounts[0]) ? amounts[0] : null;
}
export function introduce(fields = {}, question = '') {
  const priceQuestion = asksPrice(question);
  // For a price query, free title/description are not quoting fields, even if imported as copy.
  const parts = [priceQuestion ? null : display(fields.description)];
  let hasMeasurement = false;
  for (const [key, label] of [
    ['beadDiameter', '珠径'], ['innerDiameter', '内径'], ['size', '尺寸'],
    ['length', '长度'], ['width', '宽度'], ['thickness', '厚度'],
    ['braceletLength', '手链长度'], ['circumference', '周长']
  ]) {
    const field = fields[key];
    if (field?.source !== 'manual' || !text(field.unit)) continue;
    const value = display(field);
    if (value !== null) {
      if (priceQuestion && !/^[\d.\s×xX*~～至、，,/-]+$/.test(String(field.value))) continue;
      if (priceQuestion && !/^(?:mm|cm|m|毫米|厘米|米|英寸|in)$/i.test(field.unit)) continue;
      parts.push(label + ' ' + value); hasMeasurement = true;
    }
  }
  if (!hasMeasurement && /尺寸|大小|多大|珠径|内径|多长|多宽/u.test(question)) parts.push('尺寸待人工核实');
  if (priceQuestion) {
    const amount = manualPrice(fields);
    parts.push(amount === null ? '价格待店主核实' : '店主记录的售价：' + amount + ' 元');
  }
  return ((!priceQuestion && display(fields.title)) || '这件商品') + '：' + (parts.filter(Boolean).join('；') || '详情待补充') + '。';
}

export function readStock(card, summary, shopId, nowMs, maxAgeMs) {
  const unknown = { inventoryState: 'unknown', inventoryEvidence: null };
  const inv = summary?.inventory;
  if (!inv || summary.productId !== card.productId || summary.productVersion !== card.productVersion ||
      (summary.shopId !== undefined && summary.shopId !== shopId) ||
      !['in_stock', 'out_of_stock'].includes(inv.status) || inv.status !== card.inventoryStatus ||
      !text(inv.verifiedBy) || !text(inv.evidenceRef) || !text(inv.verifiedAt) ||
      card.inventoryVerifiedAt !== inv.verifiedAt) return unknown;
  const stamp = Date.parse(inv.verifiedAt);
  if (!Number.isFinite(stamp) || !Number.isFinite(nowMs) || stamp > nowMs) return unknown;
  if (inv.quantity !== null && (!Number.isSafeInteger(inv.quantity) || inv.quantity < 0 ||
      (inv.status === 'out_of_stock' ? inv.quantity !== 0 : inv.quantity === 0))) return unknown;
  const evidence = { status: inv.status, verifiedAt: inv.verifiedAt, verifiedBy: inv.verifiedBy, evidenceRef: inv.evidenceRef };
  if (maxAgeMs !== null && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || nowMs - stamp > maxAgeMs))
    return { inventoryState: 'stale', inventoryEvidence: evidence };
  return { inventoryState: inv.status, inventoryEvidence: evidence };
}

export function inventorySentence({ inventoryState, inventoryEvidence }) {
  if (inventoryState === 'unknown') return '库存待核实，暂不承诺现货。';
  if (inventoryState === 'stale') return '上次库存记录已过核实期限，库存待核实，暂不承诺现货。';
  return '店主于 ' + inventoryEvidence.verifiedAt + ' 核实为' +
    (inventoryState === 'in_stock' ? '有货；这是当时记录，并非留货或发货承诺。' : '无货。');
}
