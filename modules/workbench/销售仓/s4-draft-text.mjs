import {inventorySentence} from '../../../../店主工作台/sales/card-evidence.mjs';

// Only independent, card-fact wording. This helper must not consume a
// knowledge/rules excerpt, a conversation quote or a model answer.
export function independentDraftSuggestions(concerns,{price,dimensions,inventory}={}){
 const out=['您好，谢谢您的咨询。'];
 if(!Array.isArray(concerns))return out;
 if(concerns.includes('预算和价格')){
  if(price?.state==='known'&&typeof price.amount==='string'&&/^\d+\.\d{2}$/u.test(price.amount))
   out.push('这件卡上登记售价为 '+price.amount+' 元。');
  else if(price?.state==='unknown')out.push('这件售价待店主核实。');
 }
 if(concerns.includes('库存')&&(['unknown','stale'].includes(inventory?.state)||
   ['in_stock','out_of_stock'].includes(inventory?.state)&&typeof inventory.verifiedAt==='string'&&
   /^\d{4}-\d\d-\d\d(?:[T ][0-9:.+(Z)\-]+)?$/u.test(inventory.verifiedAt)&&Number.isFinite(Date.parse(inventory.verifiedAt))))
  out.push(inventorySentence({inventoryState:inventory.state,inventoryEvidence:inventory}));
 if(concerns.includes('尺寸或佩戴'))out.push(dimensions==='confirmed_values_in_product_card'?
  '尺寸以本件商品卡已核实的测量为准，建议和您的佩戴尺寸再核对。':'尺寸还需核实，确认后再答复。');
 if(concerns.includes('优惠'))out.push('是否有优惠待店主确认，暂不承诺折扣。');
 if(!concerns.length)out.push('具体情况待店主核实后再回复。');
 return out;
}
