import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

import { sourceRoot, sourceImagePath } from "./paths.mjs";
const mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
const esc=value=>String(value??'待核实').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const price=card=>typeof card.price==='number' && Number.isFinite(card.price)?`¥${card.price.toFixed(2)}`:esc(card.price||'待核实');
const imageUrl=card=>`/catalog/image?id=${encodeURIComponent(card.cardId)}`;

export function renderCatalog(cards,selectedId){
  const selected=selectedId?cards.find(c=>c.cardId===selectedId):null;
  const fields=selected?[
    ['商品编号',selected.cardId],['品类',selected.category],['类型',selected.type],
    ['颜色',selected.color],['材质',selected.material],['形态',selected.shape],
    ['尺寸',selected.size],['证书',selected.certificate]
  ].map(([label,value])=>`<div class="field"><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join(''):'';
  const content=selected?`<a class="back" href="/catalog">← 返回全部商品卡</a><h1>${esc(selected.name)}</h1><section class="detail"><a href="${imageUrl(selected)}" aria-label="查看商品大图"><img class="hero" src="${imageUrl(selected)}" alt="${esc(selected.name)}"></a><div class="info"><span class="badge">商品卡草稿 · 待核对</span><p class="price">${price(selected)} <small>${esc(selected.priceType||'价格待核实')}</small></p><dl>${fields}</dl><h2>图片描述</h2><p>${esc(selected.description)}</p></div></section>`:
    `<a class="back" href="/">← 返回珠宝助手</a><p class="eyebrow">本店商品资料</p><h1>我的商品卡</h1><p class="intro">共 ${cards.length} 张商品卡草稿 · 点商品看详细资料</p><div class="products">${cards.map(card=>`<article class="product-card" data-card-id="${esc(card.cardId)}"><a class="cover" href="/catalog?id=${encodeURIComponent(card.cardId)}"><img loading="lazy" src="${imageUrl(card)}" alt="${esc(card.name)}"></a><div class="body"><span class="sku">${esc(card.cardId)} · 草稿</span><h2><a href="/catalog?id=${encodeURIComponent(card.cardId)}">${esc(card.name)}</a></h2><p class="price">${price(card)} <small>${esc(card.priceType||'待核实')}</small></p><p class="spec">颜色：${esc(card.color)}<br>品类：${esc(card.category)}<br>类型：${esc(card.type)}</p><a class="open" href="/catalog?id=${encodeURIComponent(card.cardId)}">查看这件商品 →</a></div></article>`).join('')}</div>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${selected?esc(selected.cardId)+' 商品资料':'我的商品卡'}</title><style>*{box-sizing:border-box}body{font:20px/1.55 system-ui;color:#17352b;background:#f6f7f2;max-width:1000px;padding:24px;margin:auto}h1{font-size:32px;margin:8px 0}h2{font-size:24px;margin:6px 0}p{margin:10px 0}a{color:inherit}.back{display:inline-block;min-height:48px;color:#175640;padding:8px 0}.eyebrow{color:#936f2b;font-weight:700;margin:16px 0 2px}.intro,.note{color:#596c60}.note{font-size:17px;background:#fff5dd;padding:18px;border-radius:14px;margin:24px 0}.products{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:24px}.product-card{overflow:hidden;border:1px solid #d8e3da;background:white;border-radius:18px}.cover{display:block}.cover img{display:block;width:100%;height:235px;object-fit:cover}.body{padding:18px}.body h2 a{text-decoration:none}.sku{font-size:16px;color:#687568}.price{color:#985425;font-size:29px;font-weight:750}.price small{font-size:16px;color:#6c7368;font-weight:400}.spec{font-size:18px;line-height:1.8}.open{display:block;background:#175640;color:white;border-radius:10px;padding:12px 16px;min-height:50px;text-decoration:none;margin-top:16px}.detail{background:white;border:1px solid #d8e3da;border-radius:18px;overflow:hidden;margin-top:22px;display:grid;grid-template-columns:1fr 1fr}.hero{width:100%;display:block;max-height:650px;object-fit:contain}.info{padding:22px}.badge{font-size:16px;background:#f5edd6;padding:7px 12px;border-radius:16px}.field{display:grid;grid-template-columns:90px 1fr;gap:12px;border-top:1px solid #e7ece7;padding:10px 0}dt{color:#5d7063}dd{margin:0;word-break:break-word}dl{font-size:18px}@media(max-width:650px){body{padding:16px}h1{font-size:28px}.products,.detail{grid-template-columns:1fr}.cover img{height:260px}.body h2{font-size:24px}}</style>${content}<p class="note">价格来自商品资料表的建议价，不代表已确认成交价。颜色、类型、材质等是 AI 图片识别草稿；尺寸和证书缺少依据时显示“待核实”。</p></html>`;
}

export async function catalogResponse(base,url){
  let index;
  try{index=JSON.parse(await readFile(path.join(base,'商品卡索引.json'),'utf8'));}
  catch(e){if(e.code==='ENOENT')return {status:404,type:'text/html; charset=utf-8',body:'<meta charset="utf-8"><h1>还没有商品卡</h1><p>请先返回珠宝助手生成商品卡。</p><a href="/">返回助手</a>'};throw e;}
  const cards=Array.isArray(index.cards)?index.cards:[];
  const id=url.searchParams.get('id');
  const card=cards.find(c=>c.cardId===id);
  if((id || url.pathname==='/catalog/image') && !card)return {status:404,type:'text/plain; charset=utf-8',body:'商品卡未找到，请返回商品卡列表。'};
  if(url.pathname==='/catalog/image'){
    const filename=await realpath(sourceImagePath(card.sourceImage || card.cardId + ".jpg"));
    const root=await realpath(sourceRoot);
    const extension=path.extname(filename).toLowerCase();
    if(!filename.toLowerCase().startsWith(root.toLowerCase()+path.sep) || !mime[extension])return {status:404,type:'text/plain',body:'image not in catalog'};
    return {status:200,type:mime[extension],body:await readFile(filename)};
  }
  return {status:200,type:'text/html; charset=utf-8',body:renderCatalog(cards,id)};
}
