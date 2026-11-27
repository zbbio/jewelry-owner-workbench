export const pendingMaterial = "材质待核实";

// Longest aliases win: 蓝绿色 is one observation, not an invented 蓝色/绿色 pair.
const colorWords = {
  "黄色系": ["黄色系","黄色","浅黄色","浅黄","淡黄","亮黄","橘黄","橙黄","金色","金黄","黄橙色","米黄","米黄色","棕黄色","玫瑰金色","琥珀色"],
  "棕褐": ["棕褐","红褐色","棕色","褐色","深棕","浅棕"],
  "红色": ["红色","深红","暗红","鲜红","酒红","橘红","橙红"],
  "蓝绿色": ["蓝绿色","蓝绿","青绿色"],
  "绿色": ["绿色","浅绿色","浅绿","深绿色","深绿","墨绿色","墨绿","黄绿色","灰绿色"],
  "蓝色": ["蓝色","浅蓝","深蓝"],
  "白色系": ["米白","乳白","白色","象牙白","灰白色","粉白"],
  "黑色": ["黑色","乌黑"],
  "橙色": ["橙色","橘色","红橙色"],
  "粉色": ["粉色","浅粉","粉红色","粉红"],
  "紫色": ["紫色","浅紫","淡紫色"],
  "灰色": ["灰色","浅灰"]
};
const aliases = new Map(Object.entries(colorWords).flatMap(([color,words])=>words.map(word=>[word,color])));
const shortColors=new Map(Object.entries({
  "黄":"黄色系","金":"黄色系","红":"红色","绿":"绿色","蓝":"蓝色","白":"白色系","黑":"黑色",
  "棕":"棕褐","褐":"棕褐","橙":"橙色","橘":"橙色","粉":"粉色","紫":"紫色","灰":"灰色"
}));
// Longest complete alias first; suffixes are only explicit carriers observed in color fields.
const carrier="(?:(?:小配|小圆|小|主|配|隔)?珠|吊坠|圆形坠|圆坠|坠|扣|牌|流苏|纹理|链|编织绳|绳)";
const longColor=new RegExp("^("+[...aliases.keys()].sort((a,b)=>b.length-a.length).join("|")+")(?:"+carrier+")?$","u");
const phraseBreak=/[、，,；;\/\r\n及与和或]+|(?<=\S)(?:搭配|配|带)(?=(?:少量|一颗|几颗)?[黄浅淡亮米深墨金棕褐红绿蓝白黑橙橘粉紫灰青])/u;
function readColors(value){
  if(typeof value!=="string")return [];
  const labels=new Set();
  for(const part of value.normalize("NFKC").split(phraseBreak)){
    const phrase=part.trim().replace(/^(?:(?:搭配|点缀|配|辅以)?(?:少量|一颗|几颗)?)/u,"")
      .replace(/(?:为主|点缀|等色)$/u,"").trim();
    const word=longColor.exec(phrase)?.[1];
    // A single character only counts when it is the entire color token.
    const label=word?aliases.get(word):shortColors.get(phrase);
    if(label)labels.add(label);
  }
  return [...labels];
}
const digest = x=>typeof x==="string" && /^[a-f0-9]{64}$/u.test(x);
const unknown = /^(?:材质待核实|待核实|待确认|未知|未填写|无|不详|不明|[-—]+|N\/A)$/iu;
const materialList = value=>typeof value==="string"
  ? [...new Set(value.split(/[、,，;；\r\n]+/u).map(x=>x.trim()).filter(x=>x && !unknown.test(x)))] : [];

export function buildAlbumFacets(rows, bindings, cardIndex, indexSha, salesIndex) {
  const byPhoto=new Map(), cards=new Map();
  if (digest(indexSha) && bindings?.indexSha256===indexSha && Array.isArray(bindings.items)) {
    for (const b of bindings.items) {
      if (typeof b?.file!=="string" || !digest(b.sha256)) continue;
      const key=JSON.stringify([b.file,b.sha256]);
      byPhoto.set(key,byPhoto.has(key)?null:(typeof b.cardId==="string" && b.cardId.trim()?b.cardId:null));
    }
    for (const card of Array.isArray(cardIndex?.cards)?cardIndex.cards:[]) {
      if (typeof card?.cardId==="string") cards.set(card.cardId,cards.has(card.cardId)?null:card);
    }
  }
  const products=salesIndex?.products;
  return rows.map(item=>{
    const sku=digest(item.sha256)?byPhoto.get(JSON.stringify([item.file,item.sha256])):null;
    const card=cards.get(sku);
    const seen=typeof card?.color==="string"?card.color:"";
    const colors=readColors(seen);
    const product=sku && products && Object.hasOwn(products,sku)?products[sku]:null;
    const source=typeof product?.source==="string"?product.source.trim():"";
    const materials=source && !unknown.test(source)?materialList(product.material):[];
    return {item,colors,materials:materials.length?materials:[pendingMaterial],materialSource:materials.length?source:""};
  });
}
