const money=f=>f&&['manual','imported'].includes(f.source)&&['元','人民币','人民币元','CNY','RMB'].includes(f.unit)&&
  ['number','string'].includes(typeof f.value)&&/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(String(f.value));
export function readRecordedPrice(card) {
  const list=['retailPrice','salePrice','price'].map(field=>({field,f:card?.fields?.[field]})).filter(x=>money(x.f));
  if(!list.length||!list.every(x=>Number(x.f.value)===Number(list[0].f.value)))return {state:'unknown'};
  const {field,f}=list[0];
  return {state:'known',currency:'CNY',amount:f.value,field,source:f.source};
}
