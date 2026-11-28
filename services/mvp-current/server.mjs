import http from "node:http";
import os from "node:os";
import { readFile,realpath,mkdir } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "./agent.mjs";
import {createVideoService,trustedVideoProductPins} from "./video-service.mjs";
import {createArkVideoProvider} from "./video-provider.mjs";
import {createImageBackgroundPlanner} from "./image-background-plan.mjs";
import {createImageBackgroundService,IMAGE_MAX_ATTEMPTS} from "./image-background-service.mjs";
import {createArkImageProvider,inspectImage} from "./image-background-provider.mjs";
import {handleImageBackgroundHttp} from "./image-background-http.mjs";
import { catalogResponse } from "./catalog-page.mjs";
import {renderImagePreview} from "./image-viewer.mjs";
import {createHash,randomUUID} from "node:crypto";
import {buildAlbumFacets} from "./album-facets.mjs";
import {isAlbumBatch,viewAlbumRow} from "./album-map.mjs";
import {demoBase,albumV2Base,dataRoot,sourceRoot,python} from "./paths.mjs";
import {openAlbumJobs,albumJobScope} from "./album-jobs.mjs";
import {isAlbumIntent,isCatalogIntent} from "./album-intent.mjs";
import {currentCatalogAlbum,readCatalogProjection,readCatalogConfirmation,albumPublicationLocked} from "./catalog-projection.mjs";
import {currentToolWrite} from "./tools.mjs";
import {handleAnran} from "./anran-cloud.mjs";
import {allowRequest,readBody} from './access.mjs';
import {openMessagePhotos,isReferenceVideoTurn} from './message-photos.mjs';
import {isUploadedImageTurn,runUploadedImageAgent} from './uploaded-image-agent.mjs';
import {createUploadedImageWorkflow} from './uploaded-image-workflow.mjs';
const port = Number(process.env.PORT || 33113); const root = new URL("./", import.meta.url);
const imageAttemptsSetting=process.env.MVP_IMAGE_MAX_ATTEMPTS??'1';
if(!/^(?:0|[1-9][0-9]{0,2})$/.test(imageAttemptsSetting)||Number(imageAttemptsSetting)>IMAGE_MAX_ATTEMPTS)throw Error('INVALID_IMAGE_MAX_ATTEMPTS');
const resultRoot = path.join(albumV2Base, "分类结果");
const esc = (value) => String(value).replace(/[&<>\"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const imageUrl = (group,file,batch) => `/gallery/image?group=${encodeURIComponent(group)}&file=${encodeURIComponent(file)}${batch?'&batch='+encodeURIComponent(batch):''}`;
const galleryJSON = async file => {
  try {const bytes=await readFile(file); return {value:JSON.parse(bytes.toString("utf8")),sha:createHash("sha256").update(bytes).digest("hex")};}
  catch(e) {if(e instanceof SyntaxError||e.code==="ENOENT")return {};throw e;}
};
const pictureTile=(row,manifest,returnFilters)=>{const src=imageUrl(row.item.group,row.item.file,manifest.batchId);
  const params=new URLSearchParams(src.slice(src.indexOf('?')+1));
  for(const [key,value] of returnFilters) if(value) params.set('from_'+key,value);
  const preview='/gallery/preview?'+params;
  return `<a class="tile" data-image-viewer href="${esc(preview)}"><img loading="lazy" src="${esc(src)}" alt="${esc(row.item.file)}"><span>${esc(row.item.file)}</span><small>颜色（看图）：${esc(row.colors.join("、")||"颜色待观察")}</small><small${row.materialSource?` title="${esc(row.materialSource)}"`:""}>材质（资料标注）：${esc(row.materials.join("、"))}</small></a>`;};
const galleryUrl = entries=>{const p=new URLSearchParams(entries.filter(([,v])=>v));return "/gallery"+(p.size?"?"+p:"");};
const option = (value,label,selected)=>`<option value="${esc(value)}"${value===selected?" selected":""}>${esc(label)}</option>`;
async function galleryPage(query) {
  const selectedGroup=query.get("group")||"", color=query.get("color")||"", material=query.get("material")||"";
  const manifest = JSON.parse(await readFile(path.join(albumV2Base, "分类结果.json"), "utf8"));
  const [bindings,facts,sales]=await Promise.all([
    galleryJSON(path.join(albumV2Base,"已核单图货号.json")),galleryJSON(path.join(demoBase,"商品卡索引.json")),
    galleryJSON(new URL("./sales-data.json",root))
  ]);
  const groups = new Map();
  for (const row of buildAlbumFacets(manifest.items||[],bindings.value,facts.value,facts.sha,sales.value)) {
    const view=viewAlbumRow(row.item,manifest), group=manifest.batchId?view.group:row.item.group;
    if(!groups.has(group))groups.set(group,[]);
    groups.get(group).push({...row,view});
  }
  const filtered=Boolean(color||material), scope=selectedGroup?(groups.get(selectedGroup)||[]):[...groups.values()].flat();
  const values=key=>[...new Set(scope.flatMap(row=>row[key]))].sort((a,b)=>a.localeCompare(b,"zh-CN"));
  const drop=(key,title,selected,labels)=>`<label>${title}<select name="${key}">${option("","不限",selected)}${[...new Set([...labels,...(selected?[selected]:[])])].map(v=>option(v,v,selected)).join("")}</select></label>`;
  const filters=`<form class="filters" action="/gallery" method="get">${selectedGroup?`<input type="hidden" name="group" value="${esc(selectedGroup)}">`:""}${drop("color","颜色（看图）",color,values("colors"))}${drop("material","材质（资料标注）",material,values("materials"))}<button type="submit">筛选照片</button><a href="${esc(galleryUrl([["group",selectedGroup]]))}">清除筛选</a></form>`;
  let content;
  if (selectedGroup || filtered) {
    const matches=row=>(!color || row.colors.includes(color)) && (!material || row.materials.includes(material));
    const visibleGroups=(selectedGroup?[[selectedGroup,scope]]:[...groups]).map(([name,rows])=>[name,rows.filter(matches)]);
    const total=visibleGroups.reduce((sum,[,rows])=>sum+rows.length,0);
    const details=rows=>{
      const types=new Map();
      for(const row of rows){
        const section=row.view.status==="classified"?row.view.subtype:"细类待确认";
        if(!types.has(section))types.set(section,[]);
        types.get(section).push(row);
      }
      return [...types].map(([sub,items])=>`<details${filtered||sub!=="细类待确认"?" open":""}><summary>${esc(sub)} · ${items.length} 张</summary><div class="grid">${items.map(r=>pictureTile(r,manifest,[["group",selectedGroup],["color",color],["material",material]])).join("")}</div></details>`).join("");
    };
    content=`<a class="back" href="${esc(filtered&&selectedGroup?galleryUrl([["color",color],["material",material]]):"/gallery")}">← ${filtered&&selectedGroup?"所有品类的筛选结果":"返回全部分类"}</a><h1>${esc(selectedGroup||"筛选结果")}</h1>${filters}<p>共 ${total} 张照片 · 同品类不是同一件</p><p class="facet-note">颜色只看图，不据此推断材质；材质来自本件资料。</p>${total?visibleGroups.filter(([,rows])=>rows.length).map(([name,rows])=>`${selectedGroup?"":`<h2>${esc(name)}</h2>`}${details(rows)}`).join(""):'<p role="status">没有符合当前筛选的照片。</p>'}`;
  } else {
    const names=[...new Set([...Object.keys(manifest.groups||{}),...groups.keys()])];
    content=`<a class="back" href="/">← 返回珠宝助手</a><h1>照片分类</h1>${filters}<p>共 ${manifest.items.length} 张照片</p><div class="categories">${names.map(group=>{
      const items=groups.get(group)||[], item=items[0]?.item;
      const cover=item?`<img src="${imageUrl(item.group,item.file,manifest.batchId)}" alt="${esc(group)}分类封面">`:'<div class="empty">暂无照片</div>';
      return `<a class="category-card" href="/gallery?group=${encodeURIComponent(group)}">${cover}<div class="category-label"><strong>${esc(group)}</strong><span>${items.length} 张</span></div></a>`;
    }).join('')}</div><p class="note">不动原图，不建商品卡。</p>`;
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>照片分类</title><style>.filters{display:flex;align-items:end;gap:14px;flex-wrap:wrap;margin:16px 0;padding:14px;background:white;border:1px solid #d5e2da;border-radius:12px}.filters label{font-size:15px;display:grid;gap:4px}.filters select,.filters button{font:inherit;padding:7px 12px}.filters a{font-size:16px;color:#175641}.tile small{display:block;font-size:14px;overflow-wrap:anywhere;margin:4px 0}.facet-note{font-size:16px}*{box-sizing:border-box}body{font:20px/1.5 system-ui;max-width:900px;margin:0 auto;padding:28px 22px;background:#f6f7f2;color:#17352b}h1{font-size:32px;margin:12px 0 4px}p{color:#56695e}.eyebrow{margin-bottom:0;color:#8c6a2e;font-weight:700}.back{display:inline-block;color:#175641;padding:10px 0;min-height:48px}.categories{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:26px}.category-card{display:block;border-radius:18px;overflow:hidden;background:white;text-decoration:none;color:#17352b;border:1px solid #d5e2da}.category-card img,.empty{width:100%;height:220px;object-fit:cover;background:#edf2ec}.empty{display:grid;place-items:center;color:#738076}.category-label{padding:16px}.category-label strong{display:block;font-size:25px}.category-label span{display:block;font-size:18px;color:#4f685a;margin-top:5px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.tile{display:block;color:#17352b;text-decoration:none;border:1px solid #d5e2da;border-radius:10px;padding:6px;background:white}.tile img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:7px}.tile span{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.note{font-size:16px;margin-top:24px}@media(max-width:600px){body{padding:16px}h1{font-size:27px}.categories{gap:12px}.category-card img,.empty{height:155px}.category-label{padding:12px}.category-label strong{font-size:22px}.category-label span{font-size:16px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>${content}<script type="module" src="/image-viewer.mjs"></script></html>`;
}
const videoDataDir=path.resolve(process.env.MVP_VIDEO_DATA_DIR||path.join(dataRoot||demoBase,'video-demo'));
const videoPins=trustedVideoProductPins({catalogPath:path.join(demoBase,'商品卡索引.json'),sourceRoot});
const videoGenerationCeiling=Number(process.env.MVP_VIDEO_MAX_NEW_GENERATIONS||'1');
const videoService=createVideoService({
  dataDir:videoDataDir,sourceRoot,catalogPath:path.join(demoBase,'商品卡索引.json'),
  referencePath:path.resolve(process.env.MVP_VIDEO_REFERENCE||path.join(videoDataDir,'reference_4s.mp4')),
  provider:createArkVideoProvider({apiKey:process.env.ARK_API_KEY||'',expectedProductSha256:videoPins,enableRealSubmit:process.env.MVP_VIDEO_GENERATE==='1',referenceFileId:process.env.MVP_VIDEO_REFERENCE_FILE_ID||null,assetStatePath:path.join(videoDataDir,'provider-reference.json')}),
  allowGenerate:process.env.MVP_VIDEO_GENERATE==='1',maxNewGenerations:videoGenerationCeiling
});
try{
  const seed=JSON.parse(await readFile(path.join(videoDataDir,'imported-163.json'),'utf8'));
  await videoService.seedImported(seed);
}catch(e){if(e.code!=='ENOENT')throw e;}
await videoService.resumePending();
const requiresAlbumAuth=process.env.MVP_AUTH_REQUIRED==='1';
// Anonymous single-store submission is an explicit deployment choice, never the default.
const imageEnabled=process.env.MVP_IMAGE_WORKFLOW==='1';
const imageWrite=imageEnabled&&process.env.MVP_IMAGE_GENERATE==='1'&&
  (requiresAlbumAuth||process.env.MVP_IMAGE_PUBLIC_DEMO==='1');
const imageService=imageEnabled?createImageBackgroundService({
  dataDir:path.join(dataRoot||demoBase,'image-background'),
  planner:createImageBackgroundPlanner({catalogPath:path.join(demoBase,'商品卡索引.json'),sourceRoot}),
  provider:createArkImageProvider({apiKey:process.env.ARK_API_KEY,enableRealSubmit:imageWrite,
    inspect:bytes=>inspectImage(bytes,{python}),timeoutMs:180000}),
  allowGenerate:imageWrite,maxNewGenerations:Number(imageAttemptsSetting),python
}):null;
function imageContext(req){
  const scope=albumJobScope(req,requiresAlbumAuth);
  // Public preview is one demo scope; protected mode is scoped to a verified demo login.
  return scope?{shopId:'image-'+scope,actorId:'owner-'+scope,role:'owner'}:null;
}
const runOwnerAgent=(text,options={})=>runAgent(text,{...options,videoService,imageService,requestId:options.requestId||randomUUID()});
const albumJobs=openAlbumJobs({
  dir:path.resolve(process.env.ALBUM_JOBS_DB_DIR||path.join(dataRoot||os.homedir(),dataRoot?'album-jobs':'.mvp-album-jobs')),
  run:text=>runOwnerAgent(text,{albumOnly:true}),
  runCatalog:(catalogBatch,text)=>runOwnerAgent(text,{catalogOnly:true,catalogBatch}),
  catalogPublication:currentCatalogAlbum,catalogProjection:readCatalogProjection,catalogConfirmation:readCatalogConfirmation,
  activeWrite:()=>currentToolWrite()||(albumPublicationLocked()?'album':null),
  publication:async()=>{
    try{return JSON.parse(await readFile(path.join(albumV2Base,'分类结果.json'),'utf8'));}
    catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}
  }
});
const jobJSON=(res,status,body)=>{
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});
  return res.end(JSON.stringify(body));
};
const messagePhotos=openMessagePhotos({dir:path.join(dataRoot||demoBase,'message-photos'),python,secure:process.env.MVP_COOKIE_SECURE==='1'});
const uploadImageAttempts=process.env.MVP_MESSAGE_IMAGE_MAX_ATTEMPTS??'1';
if(!['0','1','unlimited'].includes(uploadImageAttempts))throw Error('INVALID_MESSAGE_IMAGE_BUDGET');
const uploadImageMaxGenerations=uploadImageAttempts==='unlimited'?null:Number(uploadImageAttempts);
const uploadImageGenerate=process.env.MVP_MESSAGE_IMAGE_GENERATE==='1'&&uploadImageMaxGenerations!==0;
const uploadedImages=createUploadedImageWorkflow({
  dataDir:path.join(dataRoot||demoBase,'uploaded-image'),photoRoot:messagePhotos.photoRoot,
  catalogPath:path.join(demoBase,'商品卡索引.json'),sourceRoot,python,
  provider:createArkImageProvider({apiKey:process.env.ARK_API_KEY,enableRealSubmit:uploadImageGenerate,
    inspect:bytes=>inspectImage(bytes,{python}),timeoutMs:180000}),
  allowGenerate:uploadImageGenerate,maxNewGenerations:uploadImageMaxGenerations
});
const styleImageDispatch=context=>runUploadedImageAgent(context,{workflow:uploadedImages,
  apiKey:process.env.MVP_FIXTURE==='1'?null:process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL||'deepseek-chat'});
// The registered input file is server-owned. With no config the complete-edit lane is inert.
const referenceVideoConfig=process.env.MVP_REFERENCE_VIDEO_CONFIG;
let referenceVideoWorkflow=null;
const productNamesBySha=new Map();
if(referenceVideoConfig){
  const config=JSON.parse(await readFile(referenceVideoConfig,'utf8'));
  if(config.productNamesBySha!==undefined){
    const names=config.productNamesBySha;
    if(!names||typeof names!=='object'||Array.isArray(names))throw Error('INVALID_REFERENCE_VIDEO_PRODUCT_NAMES');
    for(const [digest,value] of Object.entries(names)){
      const name=typeof value==='string'?value.trim():'';
      if(!/^[0-9a-f]{64}$/.test(digest)||!name||Array.from(name).length>32||
         /[<>/\\\x00-\x1f]|BCMLDIY|货号|编号|[0-9]{3,}\s*号|价格|证书|¥/iu.test(name))throw Error('INVALID_REFERENCE_VIDEO_PRODUCT_NAMES');
      productNamesBySha.set(digest,name);
    }
  }
  const attempts=process.env.MVP_REFERENCE_VIDEO_MAX_NEW_GENERATIONS??'1';
  if(!['0','1'].includes(attempts))throw Error('INVALID_REFERENCE_VIDEO_BUDGET');
  const dir=path.resolve(process.env.MVP_REFERENCE_VIDEO_DATA_DIR||path.join(dataRoot||demoBase,'reference-video'));
  const allowGenerate=process.env.MVP_REFERENCE_VIDEO_GENERATE==='1'&&attempts==='1';
  await mkdir(messagePhotos.photoRoot,{recursive:true,mode:0o700});
  const {createReferenceVideoWorkflow}=await import('./reference-video-service.mjs');
  const {createReferenceVideoProvider}=await import('./reference-video-provider.mjs');
  const provider=createReferenceVideoProvider({assetStateDir:path.join(dir,'ark-assets'),enableRealSubmit:allowGenerate,apiKey:process.env.ARK_API_KEY||''});
  referenceVideoWorkflow=createReferenceVideoWorkflow({
    dataDir:dir,photoRoot:messagePhotos.photoRoot,referenceEntries:config.referenceEntries,knownWorks:config.knownWorks,
    provider,allowGenerate,maxNewGenerations:Number(attempts),python,
    ffmpeg:process.env.MVP_REFERENCE_VIDEO_FFMPEG,ffprobe:process.env.MVP_REFERENCE_VIDEO_FFPROBE
  });
}
const styleVideoDispatch=referenceVideoWorkflow?({messageId,...context})=>{
  const productName=productNamesBySha.get(context.photos[0]?.sha256);
  return runOwnerAgent(context.userText,{referenceVideoWorkflow,referenceVideoContext:{...context,...(productName?{productName}:{})}});
}:undefined;
export const server = http.createServer(async (req, res) => {
  try {
    const url=new URL(req.url,"http://localhost");
    if(url.pathname.startsWith("/demo/")) return await handleAnran(req,res,url);
    // Only the registered output MP4 is a customer share; its UUID is the capability.
    if(referenceVideoWorkflow&&['GET','HEAD'].includes(req.method)&&/^\/style-video\/media\/[a-f0-9-]{36}$/.test(url.pathname)&&
       await referenceVideoWorkflow.handleHttp(req,res,url,{}))return;
    if(!await allowRequest(req,res))return;
    if(url.pathname.startsWith('/style-video/')){
      if(referenceVideoWorkflow&&await referenceVideoWorkflow.handleHttp(req,res,url,{scope:messagePhotos.getScope(req)}))return;
      return jobJSON(res,404,{error:'没有找到风格视频入口。'});
    }
    if(url.pathname.startsWith('/style-image/')&&await uploadedImages.handleHttp(req,res,url,{scope:messagePhotos.getScope(req)}))return;
    if(url.pathname.startsWith('/api/message-photos/')&&await messagePhotos.handle(req,res,url))return;
    if(req.method==='GET'&&url.pathname==='/message-photo-ui.mjs'){
      const script=await readFile(new URL('./message-photo-ui.mjs',root));
      res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
      return res.end(script);
    }
    if(handleImageBackgroundHttp(req,res,url,imageService,imageContext(req)))return;
    if(url.pathname.startsWith('/video/')){if(await videoService.handleHttp(req,res,url))return;return jobJSON(res,404,{error:'没有找到视频入口。'});}
    if(req.method==='GET'&&url.pathname==='/album-intent.mjs'){
      const script=await readFile(new URL('./album-intent.mjs',root));
      res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
      return res.end(script);
    }
    if(req.method==='GET'&&url.pathname==='/image-viewer.mjs'){
      const script=await readFile(new URL('./image-viewer.mjs',root));
      res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
      return res.end(script);
    }
    if(req.method==='GET'&&(url.pathname==='/api/album-jobs'||url.pathname.startsWith('/api/album-jobs/'))){
      const id=url.pathname.slice('/api/album-jobs/'.length);
      const job=albumJobs.get(id,albumJobScope(req,requiresAlbumAuth));
      return job?jobJSON(res,200,{job}):jobJSON(res,404,{error:'未找到相册任务。',code:'album_job_not_found'});
    }
    if(url.pathname==='/api/catalog-confirmations'&&req.method==='GET'){
      const scope=albumJobScope(req,requiresAlbumAuth);
      if(!scope)return jobJSON(res,401,{error:'请先登录演示'});
      res.setHeader('Vary','Cookie, X-Catalog-Job-Ids');
      return jobJSON(res,200,{batches:albumJobs.listCatalogConfirmations(scope,req.headers['x-catalog-job-ids'])});
    }
    if(req.method==='POST'&&/^\/api\/catalog-confirmations\/[0-9a-f]{64}\/seen$/u.test(url.pathname)){
      const scope=albumJobScope(req,requiresAlbumAuth), key=url.pathname.split('/')[3];
      if(!albumJobs.markCatalogConfirmationSeen(scope,key,req.headers['x-catalog-job-ids']))return jobJSON(res,404,{error:'未找到待确认通知'});
      res.writeHead(204,{'cache-control':'no-store'});return res.end();
    }
    if(req.method==='GET'&&(url.pathname==='/api/catalog-jobs'||url.pathname.startsWith('/api/catalog-jobs/'))){
      const id=url.pathname.slice('/api/catalog-jobs/'.length);
      const job=albumJobs.getCatalog(id,albumJobScope(req,requiresAlbumAuth));
      return job?jobJSON(res,200,{job}):jobJSON(res,404,{error:'未找到商品卡任务。',code:'catalog_job_not_found'});
    }
    if(req.method==='GET' && ['/catalog','/catalog/image','/catalog/preview'].includes(url.pathname)){
      const out=await catalogResponse(demoBase,url);
      res.writeHead(out.status,{'content-type':out.type,'cache-control':'no-store'});return res.end(out.body);
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const body=await readBody(req); const payload=JSON.parse(body);
      if(payload&&Object.hasOwn(payload,'attachments'))return messagePhotos.receive(req,res,payload,styleVideoDispatch,isUploadedImageTurn(payload.text,true)?styleImageDispatch:undefined);
      if(styleVideoDispatch&&payload&&!Object.hasOwn(payload,'albumJobId')&&!Object.hasOwn(payload,'catalogJobId')&&
         isReferenceVideoTurn(payload.text))return messagePhotos.referenceVideo(req,res,payload,styleVideoDispatch);
      if(payload&&!Object.hasOwn(payload,'albumJobId')&&!Object.hasOwn(payload,'catalogJobId')&&
         isUploadedImageTurn(payload.text))return messagePhotos.uploadedImage(req,res,payload,styleImageDispatch);
      const {text,albumJobId,catalogJobId,sourceAlbumJobId}=payload;
      if(isCatalogIntent(text)){
        const scope=albumJobScope(req,requiresAlbumAuth);
        if(!scope)return jobJSON(res,401,{error:'请先登录演示'});
        if(albumJobId!==undefined)return jobJSON(res,409,{error:'此任务编号不可用于该请求。',code:'catalog_job_conflict'});
        const {job,start,httpStatus,...failure}=albumJobs.submitCatalog(catalogJobId,scope,text,sourceAlbumJobId);
        if(!job)return jobJSON(res,httpStatus??409,failure);
        try{return jobJSON(res,202,{job});}finally{start?.();}
      }
      if(isAlbumIntent(text)){
        const scope=albumJobScope(req,requiresAlbumAuth);
        if(!scope)return jobJSON(res,401,{error:'请先登录演示'});
        if(catalogJobId!==undefined)return jobJSON(res,409,{error:'此任务编号不可用于该请求。',code:'album_job_conflict'});
        const {job,start,...failure}=albumJobs.submit(albumJobId,scope,text);
        if(!job)return jobJSON(res,409,failure);
        try{return jobJSON(res,202,{job});}finally{start?.();}
      }
      if(albumJobId&&albumJobs.get(albumJobId,albumJobScope(req,requiresAlbumAuth)))
        return jobJSON(res,409,{error:'此任务编号不可用于该请求。',code:'album_job_conflict'});
      if(catalogJobId&&albumJobs.getCatalog(catalogJobId,albumJobScope(req,requiresAlbumAuth)))
        return jobJSON(res,409,{error:'此任务编号不可用于该请求。',code:'catalog_job_conflict'});
      const out=await runOwnerAgent(String(text||""),{imageContext:imageContext(req)});
      res.writeHead(200,{"content-type":"application/json; charset=utf-8"});return res.end(JSON.stringify(out));
    }
    if (req.method === "GET" && new URL(req.url,"http://localhost").pathname === "/gallery") { const html = await galleryPage(url.searchParams); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control":"no-store" }); return res.end(html); }
    if (req.method === "GET" && url.pathname==="/gallery/preview") {
      const q=url.searchParams, group=q.get('group'), file=q.get('file'), batch=q.get('batch');
      const back=galleryUrl(['group','color','material'].map(key=>[key,q.get('from_'+key)]));
      const src=group&&file&&(batch===null||isAlbumBatch(batch))?imageUrl(group,file,batch):'';
      const body=renderImagePreview({src,back,alt:file||'相册原图'});
      res.writeHead(src?200:404,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
      return res.end(body);
    }
    if (req.method === "GET" && url.pathname==="/gallery/image") {
      const query=url.searchParams, group=query.get("group")||"", file=query.get("file")||"";
      const batch=query.get("batch");
      const manifest=JSON.parse(await readFile(path.join(albumV2Base,"分类结果.json"),"utf8"));
      const current=Object.hasOwn(manifest,"batchId");
      if((batch!==null&&(!isAlbumBatch(batch)||batch!==manifest.batchId))||
         (current&&!isAlbumBatch(manifest.batchId))){
        res.writeHead(404);return res.end("batch not available");
      }
      const mimeType=mime[path.extname(file).toLowerCase()];
      const item=(manifest.items||[]).find(item=>item.group===group&&item.file===file);
      if(!item||!mimeType){res.writeHead(404);return res.end("image not in album");}
      const version=current?path.resolve(resultRoot,"版本",manifest.batchId):path.resolve(resultRoot);
      const target=path.resolve(version,group,file);
      if(!target.startsWith(version+path.sep)||path.basename(file)!==file||path.basename(group)!==group){
        res.writeHead(400);return res.end("invalid image path");
      }
      if(await realpath(target).catch(()=>null)!==target){res.writeHead(404);return res.end("image not available");}
      const data=await readFile(target);
      res.writeHead(200,{"content-type":mimeType,"cache-control":"no-store"});return res.end(data);
    }
    const html = await readFile(new URL("./index.html", root)); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html);
  } catch (e) { res.writeHead(e.statusCode||500, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: process.env.MVP_AUTH_REQUIRED==='1'?'本次任务暂未完成，请稍后重试。':e.message })); }
});
server.once('close',()=>{albumJobs.close();imageService?.close();void uploadedImages.close().catch(()=>{});messagePhotos.close();void referenceVideoWorkflow?.close().catch(()=>{});});
server.listen(port, "127.0.0.1", () => console.log(`jewelry-agent-mvp http://127.0.0.1:${server.address().port}`));
