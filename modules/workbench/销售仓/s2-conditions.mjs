// A deliberately small deterministic grammar. Residual tokens are never
// treated as optional filters, and card facts do not come from its title.
const budgetRx=/([0-9]+(?:\.[0-9]+)?)\s*元(?:及以下|及以内|以内|之内|以下|内)/gu;
const budgetGood=x=>/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(x);
const compareWords=/挑|选(?!择确认)|找|比较|对比|筛|只要|限定|不许|必须/u;
const categories={手串:'手串',珠串:'手串',佛珠:'手串',bracelet:'手串',手镯:'手镯',bangle:'手镯',
 吊坠:'吊坠',pendant:'吊坠',戒指:'戒指',ring:'戒指',项链:'项链',necklace:'项链',耳饰:'耳饰',
 耳环:'耳饰',earring:'耳饰',手链:'手链',hand_chain:'手链'};
const colors={
 白:'白色',白色:'白色',黑:'黑色',黑色:'黑色',红:'红色',红色:'红色',绿:'绿色',绿色:'绿色',
 蓝:'蓝色',蓝色:'蓝色',紫:'紫色',紫色:'紫色',黄:'黄色',黄色:'黄色',橙:'橙色',橙色:'橙色',
 粉:'粉色',粉色:'粉色',粉红:'粉色',粉红色:'粉色',灰:'灰色',灰色:'灰色',褐:'棕色',褐色:'棕色',棕:'棕色',棕色:'棕色'
};
const orderKeys=o=>Object.keys(o).sort((a,b)=>b.length-a.length).join('|');
const keyword=v=>typeof v==='string'?v.normalize('NFKC').trim().toLowerCase():'';
const own=(o,k)=>Object.hasOwn(o,k)?o[k]:null;
const unitFor=s=>/^(?:mm|毫米)$/u.test(s)?'mm':/^(?:cm|厘米)$/u.test(s)?'cm':null;
const digits='([0-9]{1,6}(?:\\.[0-9]{1,3})?)';
const unit='(毫米|厘米|mm|cm)';
const withDia=new RegExp('(?:珠径|珠子(?:的)?直径|珠粒直径)\\s*(?:为|是|=)?\\s*'+digits+'\\s*'+unit+'(?![a-z0-9.])','gu');
const bareDia=new RegExp(digits+'\\s*'+unit+'(?![a-z0-9.])','gu');
const catRx=new RegExp(orderKeys(categories),'gu');
const colorRx=new RegExp(Object.keys(colors).filter(x=>x.endsWith('色')).sort((a,b)=>b.length-a.length).join('|'),'gu');
// Negative colour is only single-valued and ends its clause. Don't
// interpret “不要黑色和红色” as “只要红色”; ask instead.
const denyColor=new RegExp('(?:不要|不许|不选|别选|排除|不接受)\\s*('+orderKeys(colors)+')\\s*(?=[，,。；;！!？?\\n]|$)','gu');
const purposeRx=/通勤|送礼|日常|婚礼/gu;
const countNum={一:1,两:2,二:2,三:3,'1':1,'2':2,'3':3};
const countRx=/([一两二三123])\s*(?:条|件|款)(?![0-9])/gu;
const neutral=/(?:请|帮我|给我|在本店|本店|从店内|店内|按预算|按|预算上限|预算|筛选|挑选|选货|选|筛|挑|找出来|找|比较一下|对比一下|比较|对比|说说(?:它们的)?差别|看看(?:它们的)?差别|说说(?:它们的)?区别|看看(?:它们的)?区别|适合|只要|限定|必须|且|并且|的|只做比较|只做对比|不查库存|不问库存|别查库存|不制片|不制作|别制片|别制作|不询价|不付费|别付费|不调用模型|不调模型|[\s、，,。；;！!？?：:]+)/gu;
const issue={
 COMPARISON_BUDGET_REQUIRED:['budget','请说明最高预算，例如 200 元以内。'],
 COMPARISON_CONFLICTING_CONDITIONS:['condition','这些条件有冲突或含多种解释，请分开说明必须符合哪一个。'],
 COMPARISON_DIMENSION_REQUIRED:['beadDiameter','请明确量的是珠径还是其他尺寸，并写出确定数值和单位（毫米或厘米）。'],
 COMPARISON_COLOR_REQUIRED:['color','请说明一种必选颜色，或单独说明不选哪种颜色；未核实的颜色不算符合。'],
 COMPARISON_UNSUPPORTED_CONDITION:['condition','有未识别的条件，未推荐商品。请明确品类、用途、颜色或珠径，或拆开询问。']
};
const clarify=code=>({issue:{code,field:issue[code][0],message:issue[code][1]}});
const one=xs=>[...new Set(xs)];
function micron(value,unit){
 const n=keyword(typeof value==='number'&&Number.isFinite(value)?String(value):value);
 if(!/^\d{1,6}(?:\.\d{1,3})?$/u.test(n))return null;
 const u=unitFor(keyword(unit));if(!u)return null;
 const [whole,frac='']=n.split('.');
 const v=(Number(whole)*1000+Number(frac.padEnd(3,'0')))*(u==='cm'?10:1);
 return v>0?v:null;
}
export const valueMm = n => (n/1000).toFixed(3).replace(/\.?0+$/u,'');
const comparableColor=x=>own(colors,keyword(x));
const comparableCategory=x=>own(categories,keyword(x));
export {comparableColor,comparableCategory,micron};

export function parseComparison(text){
 if(typeof text!=='string'||text.length>500)return null;
 let s=keyword(text);
 const caps=[...s.matchAll(budgetRx)];
 if(!compareWords.test(s)||(!caps.length&&!/(?:预算|[0-9]+\s*元)/u.test(s)))return null;
 if(caps.length!==1||!budgetGood(caps[0][1]))return clarify('COMPARISON_BUDGET_REQUIRED');
 const budgetYuan=caps[0][1];
 s=s.replace(budgetRx,' ');
 const denied=[], colorsFound=[], dimension=[], bareDimension=[], cats=[], uses=[], counts=[];
 // Don't guess whether loose comma-separated colours belong to a preceding negation.
 const continuation=new RegExp('(?:不要|不许|不选|别选|排除|不接受)\\s*(?:'+orderKeys(colors)+')\\s*[,，]\\s*(?:'+orderKeys(colors)+')\\s*(?:[,，。；;！!？?]|$)','u');
 if(continuation.test(s))return clarify('COMPARISON_COLOR_REQUIRED');
 s=s.replace(denyColor,(_,v)=>{denied.push(comparableColor(v));return ' ';});
 s=s.replace(withDia,(_,v,u)=>{dimension.push(micron(v,u));return ' ';});
 s=s.replace(bareDia,(_,v,u)=>{bareDimension.push(micron(v,u));return ' ';});
 s=s.replace(catRx,v=>{cats.push(comparableCategory(v));return ' ';});
 s=s.replace(colorRx,v=>{colorsFound.push(comparableColor(v));return ' ';});
 s=s.replace(purposeRx,v=>{uses.push(v);return ' ';});
 s=s.replace(countRx,(_,v)=>{counts.push(countNum[v]);return ' ';});
 const categoriesFound=one(cats), include=one(colorsFound), exclude=one(denied);
 if([categoriesFound,include,one(uses),one(counts)].some(xs=>xs.length>1)||include.some(c=>exclude.includes(c)))
  return clarify('COMPARISON_CONFLICTING_CONDITIONS');
 const category=categoriesFound[0]??null;
 const measures=one([...dimension,...bareDimension]);
 if(measures.includes(null)||measures.length>1||bareDimension.length&&category!=='手串')
  return clarify('COMPARISON_DIMENSION_REQUIRED');
 // Unexpected words, operators, numerals and mixed-limits all remain here.
 // In particular “约/至少”, “手围/内径”, “不是”、and unsupported material
 // are never dropped. One malformed instruction yields zero candidates.
 const unparsed=s.replace(neutral,'');
 if(unparsed){
  if(measures.length||/尺寸|珠径|直径|手围|内径|毫米|厘米|公分|英寸|[cm]m|克|毫米至/u.test(unparsed))
   return clarify('COMPARISON_DIMENSION_REQUIRED');
  if(include.length||exclude.length||/色/u.test(unparsed))return clarify('COMPARISON_COLOR_REQUIRED');
  return clarify('COMPARISON_UNSUPPORTED_CONDITION');
 }
 return {budgetYuan,count:counts[0]??1,category,purpose:uses[0]??null,
  ...(include.length||exclude.length?{color:{required:include[0]??null,excluded:exclude}}:{}),
  ...(measures.length?{beadDiameter:{operator:'eq',valueMm:valueMm(measures[0]),unit:'mm'}}:{})};
}
