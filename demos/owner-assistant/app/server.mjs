import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mainPort, demoBase, guestOrigin, ownerOrigin } from "./paths.mjs";
import { runAgent } from "./agent.mjs";
import { catalogResponse } from "./catalog-page.mjs";
const port = mainPort; const root = new URL("./", import.meta.url);
const resultRoot = path.join(demoBase, "分类结果");
const esc = (value) => String(value).replace(/[&<>\"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const imageUrl = (group,file) => `/gallery/image?group=${encodeURIComponent(group)}&file=${encodeURIComponent(file)}`;
async function galleryPage(selectedGroup) {
  const manifest = JSON.parse(await readFile(path.join(demoBase, "分类结果.json"), "utf8"));
  const groups = {};
  for (const item of manifest.items || []) (groups[item.group] ||= []).push(item);
  let content;
  if (selectedGroup) {
    const items=groups[selectedGroup] || [];
    content=`<a class="back" href="/gallery">← 返回全部分类</a><h1>${esc(selectedGroup)}</h1><p>共 ${items.length} 张 · 点照片看大图</p><div class="grid">${items.map(item=>`<a class="tile" href="${imageUrl(selectedGroup,item.file)}"><img loading="lazy" src="${imageUrl(selectedGroup,item.file)}" alt="${esc(item.file)}"><span>${esc(item.file)}</span></a>`).join('')}</div>`;
  } else {
    const names=[...new Set([...Object.keys(manifest.groups || {}),...Object.keys(groups)])];
    content=`<a class="back" href="/">← 返回珠宝助手</a><p class="eyebrow">我的分类相册</p><h1>照片已经分好类了</h1><p>共 ${manifest.items.length} 张照片 · 点下面的分类就能看</p><div class="categories">${names.map(group=>{const items=groups[group]||[];return `<a class="category-card" href="/gallery?group=${encodeURIComponent(group)}">${items[0]?`<img src="${imageUrl(group,items[0].file)}" alt="${esc(group)}分类封面">`:'<div class="empty">暂无照片</div>'}<div class="category-label"><strong>${esc(group)}</strong><span>${items.length} 张 · 点开查看 →</span></div></a>`;}).join('')}</div><p class="note">这里只展示分类相册，不移动手机相册里的原照片。</p>`;
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的分类相册</title><style>*{box-sizing:border-box}body{font:20px/1.5 system-ui;max-width:900px;margin:0 auto;padding:28px 22px;background:#f6f7f2;color:#17352b}h1{font-size:32px;margin:12px 0 4px}p{color:#56695e}.eyebrow{margin-bottom:0;color:#8c6a2e;font-weight:700}.back{display:inline-block;color:#175641;padding:10px 0;min-height:48px}.categories{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:26px}.category-card{display:block;border-radius:18px;overflow:hidden;background:white;text-decoration:none;color:#17352b;border:1px solid #d5e2da}.category-card img,.empty{width:100%;height:220px;object-fit:cover;background:#edf2ec}.empty{display:grid;place-items:center;color:#738076}.category-label{padding:16px}.category-label strong{display:block;font-size:25px}.category-label span{display:block;font-size:18px;color:#4f685a;margin-top:5px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.tile{display:block;color:#17352b;text-decoration:none;border:1px solid #d5e2da;border-radius:10px;padding:6px;background:white}.tile img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:7px}.tile span{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.note{font-size:16px;margin-top:24px}@media(max-width:600px){body{padding:16px}h1{font-size:27px}.categories{gap:12px}.category-card img,.empty{height:155px}.category-label{padding:12px}.category-label strong{font-size:22px}.category-label span{font-size:16px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>${content}</html>`;
}
const server = http.createServer(async (req, res) => {
  try {
    const url=new URL(req.url,"http://localhost");
    if(req.method==='GET' && ['/catalog','/catalog/image'].includes(url.pathname)){
      const out=await catalogResponse(demoBase,url);
      res.writeHead(out.status,{'content-type':out.type,'cache-control':'no-store'});return res.end(out.body);
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      if(process.env.MVP_PREVIEW === '1') { res.writeHead(503,{'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({mode:'preview',tool:null,receipt:null,error:'请先配置 DeepSeek 密钥，再启动在线演示。当前只读预览可查看相册、商品卡和店铺。'})); }
      let body = ""; for await (const c of req) body += c; const { text } = JSON.parse(body); const out = await runAgent(String(text || "")); res.writeHead(200, { "content-type": "application/json; charset=utf-8" }); return res.end(JSON.stringify(out)); }
    if (req.method === "GET" && new URL(req.url,"http://localhost").pathname === "/gallery") { const html = await galleryPage(new URL(req.url,"http://localhost").searchParams.get('group')); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control":"no-store" }); return res.end(html); }
    if (req.method === "GET" && req.url.startsWith("/gallery/image?")) {
      const query = new URL(req.url, "http://127.0.0.1").searchParams; const group = query.get("group") || ""; const file = query.get("file") || "";
      const target = path.resolve(resultRoot, group, file); const rootPath = path.resolve(resultRoot) + path.sep;
      if (!target.startsWith(rootPath)) { res.writeHead(400); return res.end("invalid image path"); }
      const manifest=JSON.parse(await readFile(path.join(demoBase,"分类结果.json"),"utf8"));
      if(!mime[path.extname(file).toLowerCase()] || !(manifest.items||[]).some(item=>item.group===group && item.file===file)){res.writeHead(404);return res.end("image not in album");}
      const data = await readFile(target); res.writeHead(200, { "content-type": mime[path.extname(target).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" }); return res.end(data);
    }
    const html = (await readFile(new URL("./index.html", root), "utf8")).replaceAll("__SALES_GUEST_ORIGIN__",guestOrigin).replaceAll("__SALES_OWNER_ORIGIN__",ownerOrigin); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html);
  } catch (e) { res.writeHead(500, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: e.message })); }
});
server.listen(port, "127.0.0.1", () => console.log(`jewelry-agent-mvp http://127.0.0.1:${port}`));
