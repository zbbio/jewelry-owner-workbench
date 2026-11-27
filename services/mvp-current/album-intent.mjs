/* Same small, positive grammar on server and browser; no provider or browser dependencies. */
const courtesy='(?:(?:麻烦|请|帮我|给我|把|将|只|仅|先))*';
const scope='(?:(?:本机|手机|本地|店里|今天|今日|刚才|刚拍|新拍|已经选好|已选|选中|上传|导入|本轮|本次|这一批|这批|这组|这几张|这些|所有|全部|的|珠宝))*';
const kind='(?:相册(?:里(?:的)?|内(?:的)?)?|照片|相片|图片)';
const object=scope+kind+'(?:'+scope+'(?:照片|相片|图片))?';
const rule='(?:按(?:实物|同件|同款|品类|大类|类型|种类|类别|件|颜色|材质|形态))?';
const verb='(?:重新整理|整理|分类|分组|归组|归类|分|分成(?:几组|组))';
const follow='(?:成组|分组|分类|归组|归类|一下|下|一遍|一次|起来|好)?';
const explicit=new RegExp('^'+courtesy+'(?:'+object+rule+verb+follow+'|'+rule+verb+'(?:一下|下|一遍|一次)?'+courtesy+object+'(?:'+rule+verb+')?'+follow+')$','u');
const noCard='(?:先|暂时|这次|本次|只整理)?(?:不要|不必|不需要|不|先不|暂不|不用|别|无需)(?:自动|先)?(?:建卡|建档|创建商品卡|新建商品卡|生成商品卡|创建卡片|做商品卡|写商品卡)';
const negativeCard=new RegExp('^'+noCard+'$','u');
const trailingCard=new RegExp(noCard+'$','u');
export function isAlbumIntent(text){
  if(typeof text!=='string'||!text||text.length>500)return false;
  const clean=text.normalize('NFKC').trim();
  if(/[?？]/u.test(clean))return false;
  const clauses=clean.split(/[，,。.!！;；、\r\n]+/u).map(s=>s.replace(/\s+/gu,'')).filter(Boolean)
    .filter(s=>!negativeCard.test(s));
  if(clauses.length!==1)return false;
  return explicit.test(clauses[0].replace(trailingCard,''));
}

// Only positive, single-operation bulk synchronization requests. No keyword fallback.
const catSimple='(?:(?:批量同步|批量更新|批量继承)(?:到)?(?:商品卡|商品卡草稿))';
const catSource='(?:(?:最新(?:已完成)?|刚才|本批)(?:的)?(?:已完成)?(?:相册(?:的)?)?(?:分类(?:结果)?|已完成分类结果)|已完成相册的分类(?:结果)?)';
const catTail='(?:成草稿|先保存草稿|保存为草稿)?';
const catExplicit=new RegExp('^'+courtesy+'(?:'+catSimple+catTail+'|'+
  '(?:根据|用|按|把|将)?'+catSource+catSimple+catTail+')$','u');
const catRecord=/^(?:麻烦|请|帮我|给我)*(?:根据|按|用)(?:刚才|最新(?:已完成)?|本批)(?:的)?(?:相册(?:的)?)?分类结果(?:自动)?(?:为每件|给每件)(?:建立|创建|生成)(?:一个|一张)(?:结构化)?商品卡JSON文件字段(?:包括|包含)颜色品类类型材质形态(?:先)?保存草稿$/iu;
export function isCatalogIntent(text){
  if(typeof text!=='string'||!text||text.length>500)return false;
  const clean=text.normalize('NFKC').trim();
  if(/[?？]/u.test(clean))return false;
  const flat=clean.replace(/\s+/gu,'');
  if(catRecord.test(flat.replace(/[，,。.!！、]/gu,'')))return true;
  return catExplicit.test(flat.replace(/[。.!！]+$/u,''));
}
