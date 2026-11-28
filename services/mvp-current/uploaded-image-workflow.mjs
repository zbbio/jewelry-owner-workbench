import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createImageBackgroundService} from './image-background-service.mjs';
import {planUploadedImageBackground} from './image-background-plan.mjs';
import {inspectImage} from './image-background-provider.mjs';
import {boundProduct} from './video-service.mjs';

const tool='image_replace_background', allowed=['photoId','backgroundBrief','requestedAction'];
const scopePattern=/^[a-f0-9]{64}$/, shaPattern=/^[a-f0-9]{64}$/;
const photoPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const jobPattern=/^img-job-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sku=/^[A-Za-z0-9_-]{1,100}$/;
const requestPattern=/^[a-z0-9_.:-]{1,128}$/i;
const formats={'image/jpeg':['.jpg','JPEG'],'image/png':['.png','PNG'],'image/webp':['.webp','WEBP']};
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const absolute=s=>typeof s==='string'&&path.isAbsolute(s);
const warning='AI 换背景预览，非实拍；请用本次上传原图核对珠宝细节。';
const summary=(catalogMatch,matchedProductId=null)=>({catalogMatch,matchedProductId});
const definitions=Object.freeze([{type:'function',function:{name:tool,
 description:'只处理本条可信附件中明确的一张照片。改背景，保珠宝。先别生成或只要方案时给方案；未提供背景使用中性背景。匹配商品仅供关联。',
 parameters:{type:'object',properties:{photoId:{type:'string'},backgroundBrief:{type:'string'},requestedAction:{enum:['plan','preview'],type:'string'}},
 required:['requestedAction'],additionalProperties:false}}}]);
const protectedHeaders={'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
const escapeHtml=s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
function send(req,res,status,mime,body,headers={}){
 const bytes=Buffer.isBuffer(body)?body:Buffer.from(body);
 res.writeHead(status,{...protectedHeaders,...headers,'Content-Type':mime,'Content-Length':bytes.length});
 return res.end(req.method==='HEAD'?undefined:bytes),true;
}
const json=(req,res,status,obj)=>send(req,res,status,'application/json; charset=utf-8',JSON.stringify(obj));
function checkedCode(err){
 return /^IMAGE_[A-Z0-9_]{1,80}$/.test(err?.code||'')||err?.code==='INVALID_PLAN_INPUT'?err.code:'IMAGE_UPLOAD_WORKFLOW_FAILED';
}
function receipt(result,status='completed'){
 return {tool,status,receiptId:'style-image-'+randomUUID(),result};
}
const inside=(root,file)=>{
 const route=path.relative(root,file);
 return route&&route!=='..'&&!route.startsWith('..'+path.sep)&&!path.isAbsolute(route);
};
const localContext=(scope,userText='')=>({role:'owner',shopId:'upload:'+scope,actorId:'message-owner',userText});

function optionalCatalog(catalogPath,sourceRoot){
 const sourceHashes=new Map();
 return target=>{
  try{
   if(!absolute(catalogPath)||!absolute(sourceRoot))return summary('lookup_unavailable');
   const root=fs.realpathSync(sourceRoot), stat=fs.statSync(catalogPath);
   if(!stat.isFile()||stat.size>8*1024**2)return summary('lookup_unavailable');
   const {cards}=JSON.parse(fs.readFileSync(catalogPath,'utf8').replace(/^\uFEFF/,''));
   if(!Array.isArray(cards)||cards.length>2000)return summary('lookup_unavailable');
   const groups=new Map(), ids=new Set();
   for(const card of cards){
    const id=card?.cardId||card?.id;
    if(!sku.test(id||'')||ids.has(id)||card.cardId!==undefined&&card.id!==undefined&&card.cardId!==card.id||!absolute(card.sourceImage))
     return summary('lookup_unavailable');
    ids.add(id);
    const file=fs.realpathSync(card.sourceImage);
    if(!inside(root,file))return summary('lookup_unavailable');
    const group=groups.get(file)||[];group.push({card,id});groups.set(file,group);
   }
   const matches=new Set();
   for(const [file,group] of groups){
    const ext=path.extname(file).toLowerCase();
    const owner=group.find(x=>path.basename(file,ext)===x.id);
    const stat=fs.statSync(file);
    if(!owner||!stat.isFile()||stat.size<=0||stat.size>30*1024**2)return summary('lookup_unavailable');
    const stamp=[owner.id,stat.size,stat.ino,stat.mtimeMs,stat.ctimeMs].join(':');
    let info=sourceHashes.get(file);
    if(!info||info.stamp!==stamp){
     const bound=boundProduct({catalogPath,sourceRoot},owner.id,[owner.card]); // legacy strict source validation + SHA
     const end=fs.statSync(file);
     if(bound.file!==file||end.size!==stat.size||end.mtimeMs!==stat.mtimeMs||end.ctimeMs!==stat.ctimeMs)
      return summary('lookup_unavailable');
     info={stamp,sha256:bound.sha256};sourceHashes.set(file,info);
     if(sourceHashes.size>2000)sourceHashes.delete(sourceHashes.keys().next().value);
    }
    if(info.sha256===target)for(const seen of group)matches.add(seen.id);
   }
   if(matches.size>1)return summary('ambiguous');
   if(!matches.size)return summary('unmatched');
   return summary('exact_match',matches.values().next().value);
  }catch{return summary('lookup_unavailable');}
 };
}
export function createUploadedImageWorkflow({
 dataDir,photoRoot,catalogPath,sourceRoot,provider,allowGenerate=false,maxNewGenerations=1,python=process.platform==='win32'?'python':'python3'
}={}){
 if(!absolute(dataDir)||!absolute(photoRoot)||![0,1,null].includes(maxNewGenerations))throw TypeError('Absolute private dataDir/photoRoot and budget 0, 1 or null required');
 const photoDir=path.resolve(photoRoot);
 if(path.resolve(dataDir)===photoDir||inside(photoDir,path.resolve(dataDir)))throw TypeError('Image work directory must not be an attachment directory');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const privateDir=path.join(fs.realpathSync(dataDir),'uploaded-image-workflow-v1');
 fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
 if(fs.realpathSync(privateDir)!==privateDir||!fs.lstatSync(privateDir).isDirectory())throw TypeError('Private upload workflow directory required');
 const plans=new WeakMap(), decoded=new Map(), match=optionalCatalog(catalogPath,sourceRoot);
 function readPhoto(pin,claimedPath){
  if(!pin||pin.sourceKind!=='message_photo'||!scopePattern.test(pin.scope||'')||!photoPattern.test(pin.photoId||'')||
    pin.assetId!=='message-photo:'+pin.photoId||!shaPattern.test(pin.sourceSha256||'')||!Object.hasOwn(formats,pin.contentType))
   fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');
  const [ext,format]=formats[pin.contentType];
  const folder=path.join(photoDir,pin.scope),expected=path.join(folder,pin.photoId+ext);
  if(claimedPath!==undefined&&(!absolute(claimedPath)||path.resolve(claimedPath)!==expected))fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');
  let bytes;
  try{
   if(fs.realpathSync(photoDir)!==photoDir||fs.realpathSync(folder)!==folder||fs.realpathSync(expected)!==expected)
    fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');
   const stat=fs.lstatSync(expected);
   if(!stat.isFile()||stat.size<1||stat.size>10*1024**2)fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');
   bytes=fs.readFileSync(expected);
   if(bytes.length!==stat.size||hash(bytes)!==pin.sourceSha256)fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');
  }catch{fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');}
  const key=pin.contentType+':'+pin.sourceSha256;
  if(!decoded.has(key)){
   if(inspectImage(bytes,{python}).format!==format)fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');
   decoded.set(key,true);
   if(decoded.size>128)decoded.delete(decoded.keys().next().value);
  }
  return {bytes,contentType:pin.contentType,sourceSha256:pin.sourceSha256};
 }
 const engine=createImageBackgroundService({dataDir:privateDir,
  planner:{plan(args){const plan=plans.get(args);if(!plan)fail('INVALID_PLAN_INPUT');return plan;},readPinnedSource:readPhoto},
  provider,allowGenerate,maxNewGenerations,python});
 const inflight=new Set();let closing;
 function publicPin(source){
  return {sourceSha256:source.sourceSha256,matchedProductId:source.matchedProductId??null,catalogMatch:source.catalogMatch};
 }
 function present(job){
  const {jobId:id,status}=job;
  const pathMedia='/style-image/media/'+id+'/';
  const ready=status==='preview_ready'&&job.work?.version===1;
  return {id,status,...publicPin(job.source),originalUrl:pathMedia+'original',watchUrl:'/style-image/watch/'+id,
   statusUrl:'/style-image/jobs/'+id,aiGenerated:ready,warning,...(job.reused?{reused:true}:{}),
   ...(ready?{version:1,previewUrl:pathMedia+'generated',thumbnailUrl:pathMedia+'thumbnail',
    warnings:job.warnings?.includes('SOURCE_ASPECT_RATIO_CHANGED')?['SOURCE_ASPECT_RATIO_CHANGED']:[]}:{}),
   ...(job.errorCode?{code:checkedCode({code:job.errorCode})}:{})};
 }
 async function dispatch(name,args,ctx={}){
  let trustedArgs;
  try{
   if(name!==tool||!args||Object.getPrototypeOf(args)!==Object.prototype||
      Object.keys(args).some(k=>!allowed.includes(k))||!['plan','preview'].includes(args.requestedAction)||
      args.photoId!==undefined&&!photoPattern.test(args.photoId))fail('INVALID_PLAN_INPUT');
   if(!scopePattern.test(ctx.scope||'')||!requestPattern.test(ctx.requestId||''))fail('IMAGE_SCOPE_DENIED');
   const photos=Array.isArray(ctx.photos)?ctx.photos:[];
   if(args.photoId===undefined&&photos.length!==1)fail('IMAGE_UPLOAD_PHOTO_REQUIRED');
   const selected=args.photoId===undefined?photos:photos.filter(x=>x?.photoId===args.photoId);
   if(selected.length!==1||!selected[0]||!absolute(selected[0].path))fail('IMAGE_UPLOAD_SOURCE_UNAUTHORIZED');
   const photo=selected[0], source={sourceKind:'message_photo',scope:ctx.scope,photoId:photo.photoId,assetId:'message-photo:'+photo.photoId,
      productVersion:null,sourceSha256:photo.sha256,contentType:photo.mimeType};
   readPhoto(source,photo.path);
   Object.assign(source,match(source.sourceSha256));
   // Keep plan identity independent of optional catalog metadata; the same upload always edits its own bytes.
   const p=planUploadedImageBackground(source,{requestedAction:args.requestedAction,backgroundBrief:args.backgroundBrief},
      {userText:ctx.userText});
   trustedArgs={};plans.set(trustedArgs,p);
   const row=await engine.execute(localContext(ctx.scope,ctx.userText),{args:trustedArgs,requestId:ctx.requestId});
   if(row.jobId)return receipt({status:row.status,job:present(row)});
   return receipt({status:row.status,plan:{planId:row.planId,status:row.status,...publicPin(row.source),
      backgroundBrief:row.backgroundBrief,requestedAction:row.requestedAction,warning}});
  }catch(err){return receipt({code:checkedCode(err)},'failed');}
  finally{if(trustedArgs)plans.delete(trustedArgs);}
 }
 function execute(name,args,ctx){
  if(closing)return Promise.resolve(receipt({code:'IMAGE_UPLOAD_WORKFLOW_CLOSED'},'failed'));
  const work=dispatch(name,args,ctx);inflight.add(work);
  return work.finally(()=>inflight.delete(work));
 }
 async function handleHttp(req,res,url,{scope}={}){
  if(url.pathname!=='/style-image'&&!url.pathname.startsWith('/style-image/'))return false;
  if(!['GET','HEAD'].includes(req.method))return json(req,res,405,{code:'IMAGE_MEDIA_READ_ONLY'});
  const missing=()=>json(req,res,404,{code:'IMAGE_MEDIA_NOT_AVAILABLE'});
  if(closing||!scopePattern.test(scope||''))return missing();
  const [a,kind,id,item,...rest]=url.pathname.split('/').slice(1);
  if(a!=='style-image'||!jobPattern.test(id||'')||rest.length)return missing();
  const ctx=localContext(scope);
  try{
   if(kind==='jobs'&&item===undefined)return json(req,res,200,{job:present(engine.status(ctx,id))});
   if(kind==='media'&&['original','generated','thumbnail'].includes(item)){
    const asset=item==='thumbnail'?engine.thumbnail(ctx,{jobId:id,kind:'generated',version:1}):engine.media(ctx,{jobId:id,kind:item,version:1});
    return send(req,res,200,asset.contentType,asset.bytes);
   }
   if(kind==='watch'&&item===undefined){
    const job=present(engine.status(ctx,id));
    engine.media(ctx,{jobId:id,kind:'original',version:1});
    const picture=(url,label)=>'<figure><figcaption>'+label+'</figcaption><a href="'+escapeHtml(url)+'"><img src="'+escapeHtml(url)+'" alt="'+label+'"></a></figure>';
    const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原图与换背景预览</title><style>body{font:16px system-ui;margin:16px}img{display:block;max-width:100%;height:auto}figure{margin:12px 0}</style><h1>原图与换背景预览</h1><p>'+escapeHtml(warning)+'</p>'+picture(job.originalUrl,'本次上传原图')+(job.previewUrl?picture(job.previewUrl,'换背景预览'):'<p>目前没有可打开的新预览。</p>');
    return send(req,res,200,'text/html; charset=utf-8',html,{'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"});
   }
   return missing();
  }catch(err){if(err?.code==='IMAGE_THUMBNAIL_UNAVAILABLE')return json(req,res,503,{code:err.code});return missing();}
 }
 function close(){return closing??=(async()=>{await Promise.allSettled([...inflight]);engine.close();})();}
 return Object.freeze({definitions,execute,handleHttp,close});
}
