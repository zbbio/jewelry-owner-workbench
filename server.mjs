/**
 * Local first-ticket integration. Only the configured pilot shop exists in this process;
 * never expose this demonstration identity on a network interface.
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createAlbum} from './album/index.mjs';
import {createCatalog} from './catalog/index.mjs';
import {createPilotAccess} from './pilot-access.mjs';
import {createDesk} from './desk.mjs';
import {reviewView} from './album-review.mjs';

const home=path.dirname(fileURLToPath(import.meta.url));
const access=createPilotAccess();
const dataDir=path.resolve(process.env.WORKBENCH_DATA||path.join(os.homedir(),'.jewelry-owner-workbench-public','demo'));
mkdirSync(dataDir,{recursive:true});
const db=new DatabaseSync(path.join(dataDir,'workbench.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
const ctx=Object.freeze({shopId:process.env.WORKBENCH_SHOP||'local-pilot-shop',actorId:'local-pilot-owner',role:'owner'});
let album;
const catalog=createCatalog({db,hasAsset:(ctx,id)=>album.hasAsset(ctx,id)});
album=createAlbum({db,dataDir,catalog});
const desk=createDesk({db,album,catalog,mediaRoot:path.join(dataDir,'studio-media')});
const MAX=36*1024*1024, SINGLE=8*1024*1024, MAX_BODY=Math.ceil(MAX/3)*4+65536;
const port=Number(process.env.PORT||4179);
const siteFiles=new Map([['/',['index.html','text/html; charset=utf-8']],['/index.html',['index.html','text/html; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']]]);
const publicShell=new Map([['/app.webmanifest','application/manifest+json'],['/sw.js','text/javascript; charset=utf-8'],['/icon-192.png','image/png'],['/icon-512.png','image/png']]);
function issue(code,message,httpStatus=400){return Object.assign(new Error(message),{code,httpStatus});}
function respond(res,code,body,type='application/json; charset=utf-8'){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; media-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self' blob: data:; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});res.end(type.startsWith('application/json')?JSON.stringify(body):body);}
async function jsonBody(req){
 if((req.headers['content-type']||'').split(';')[0].trim()!=='application/json') throw issue('UNSUPPORTED_FORMAT','请用 JSON 提交。',415);
 if(Number(req.headers['content-length'])>MAX_BODY)throw issue('UPLOAD_TOO_LARGE','本批图片超过限制。',413);
 let size=0;const buffers=[];for await(const b of req){size+=b.length;if(size>MAX_BODY)throw issue('UPLOAD_TOO_LARGE','本批图片超过限制。',413);buffers.push(b);}
 let v;try{v=JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{throw issue('INVALID_JSON','请求格式错误。');}
 if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.requestId!=='string'||!v.requestId||v.requestId.length>180)throw issue('INVALID_REQUEST','缺少有效请求号。');
 return v;
}
function filePart(s){if(typeof s!=='string'||!s.length||s.length>4*Math.ceil(SINGLE/3))throw issue('FILE_SIZE','图片为空或超过 8 MiB。',413);if(s.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))throw issue('INVALID_FILE','图片编码错误。');const bytes=Buffer.from(s,'base64');if(bytes.length>SINGLE)throw issue('FILE_SIZE','图片超过 8 MiB。',413);return {bytes};}
const server=http.createServer(async(req,res)=>{
 try{
  const bound=server.address().port;const hosts=new Set(['127.0.0.1:'+bound,'localhost:'+bound]);const qaHost=process.env.WORKBENCH_QA_HOST;
  if(access.locked&&/^n3-[0-9a-f]{24}\.localhost$/.test(qaHost||''))hosts.add(qaHost+':'+bound);
  const host=req.headers.host;
  if(!hosts.has(host)) throw issue('INVALID_ORIGIN','仅限本机工作台。',403);
  const origin='http://'+host;const pathname=new URL(req.url,origin).pathname;
  if(req.method==='GET'&&publicShell.has(pathname))return respond(res,200,readFileSync(path.join(home,'web',pathname.slice(1))),publicShell.get(pathname));
  if(['POST','PATCH'].includes(req.method)&&req.headers.origin!==origin)throw issue('INVALID_ORIGIN','仅接受本测试店工作台页面的操作。',403);
  if(req.method==='GET'&&(pathname==='/pilot'||pathname==='/pilot.js')){
   const js=pathname==='/pilot.js';return respond(res,200,readFileSync(path.join(home,js?'pilot.js':'pilot.html')),js?'text/javascript; charset=utf-8':'text/html; charset=utf-8');}
  if(req.method==='POST'&&pathname==='/api/pilot/session'){
   const b=await jsonBody(req),cookie=access.signIn(b.code);if(cookie)res.setHeader('Set-Cookie',cookie);
   return respond(res,200,{authenticated:true,mode:access.locked?'isolated-pilot':'loopback-demo'});}
  if(access.locked&&!access.valid(req)&&!(req.method==='GET'&&pathname==='/style.css')){
   if(req.method==='GET'&&(pathname==='/'||pathname==='/index.html')){res.writeHead(302,{Location:'/pilot','Cache-Control':'no-store'});return res.end();}
   throw issue('LOGIN_REQUIRED','请先登录隔离测试店。',401);}
  if(req.method==='POST'&&pathname==='/api/pilot/logout'){await jsonBody(req);res.setHeader('Set-Cookie',access.logout(req));return respond(res,200,{signedOut:true});}
  if(await desk.route({req,res,pathname,ctx,jsonBody,respond,issue}))return;
  let m;
  if(req.method==='GET'){
   if(siteFiles.has(pathname)){const [f,mime]=siteFiles.get(pathname);return respond(res,200,readFileSync(path.join(home,'web',f)),mime);}
   if(pathname==='/api/cards'){res.setHeader('X-Workbench-Card-Scope',encodeURIComponent(ctx.shopId));return respond(res,200,await catalog.list(ctx));}
   if(pathname==='/api/tasks')return respond(res,200,(await album.listTasks(ctx)).map(reviewView));
   if(m=/^\/api\/(cards|assets|tasks)\/([^/]+)$/.exec(pathname)){
    const [,kind,enc]=m;let id;try{id=decodeURIComponent(enc);}catch{throw issue('INVALID_ID','编号错误。');}
    if(kind==='assets'){const a=await album.readAsset(ctx,id);if(a?.bytes)return respond(res,200,a.bytes,a.mime||'application/octet-stream');}
    else {const a=kind==='cards'?await catalog.get(ctx,id):reviewView(await album.getTask(ctx,id));if(a){if(kind==='cards')res.setHeader('X-Workbench-Card-Scope',encodeURIComponent(ctx.shopId));return respond(res,200,a);}}
   }
  }else if(req.method==='POST'&&['/api/import','/api/resolve','/api/retry'].includes(pathname)){
   if(req.headers.origin!==origin)throw issue('INVALID_ORIGIN','仅接受本机工作台页面的操作。',403);
   const b=await jsonBody(req);
   if(pathname==='/api/retry'){
    if(typeof b.taskId!=='string'||!b.taskId.trim()||Object.keys(b).some(k=>k!=='taskId'&&k!=='requestId'))throw issue('INVALID_RETRY','恢复回执只需要原任务号和本次请求号。');
    return respond(res,200,reviewView(await album.retryTask(ctx,{requestId:b.requestId,taskId:b.taskId})));
   }
   // The client may not designate identity or supply a trusted grouping result.
   if(pathname==='/api/import'){
    if(!Array.isArray(b.files)||b.files.length<1||b.files.length>12)throw issue('FILE_COUNT','每批选择 1–12 张照片。');
    const files=b.files.map(filePart);if(files.reduce((n,x)=>n+x.bytes.length,0)>MAX)throw issue('UPLOAD_TOO_LARGE','每批原图总计不超过 36 MiB。',413);
    const inCard=b.targetProductId!==undefined;
    if(inCard&&(typeof b.targetProductId!=='string'||!Number.isSafeInteger(b.expectedVersion)||b.expectedVersion<1))throw issue('INVALID_TARGET','请刷新原卡，取得当前版本。');
    return respond(res,200,reviewView(await album.importBatch(ctx,{requestId:b.requestId,files,...(inCard?{targetProductId:b.targetProductId,expectedVersion:b.expectedVersion}:{})})));
   }
   if(typeof b.taskId!=='string'||!Array.isArray(b.groups)||!b.groups.length||b.groups.length>12)throw issue('INVALID_RESOLUTION','请选择需确认的照片组。');
   const groups=b.groups.map(g=>{if(!g||!Array.isArray(g.assetIds)||!g.assetIds.length||g.assetIds.length>12||!g.assetIds.every(a=>typeof a==='string')||(g.targetProductId!==undefined&&(typeof g.targetProductId!=='string'||!Number.isSafeInteger(g.expectedVersion)||g.expectedVersion<1)))throw issue('INVALID_RESOLUTION','照片组或卡片版本有误。');return {assetIds:g.assetIds,...(g.targetProductId!==undefined?{targetProductId:g.targetProductId,expectedVersion:g.expectedVersion}:{})};});
   return respond(res,200,reviewView(await album.resolve(ctx,{requestId:b.requestId,taskId:b.taskId,groups})));
  }
  respond(res,404,{error:{code:'NOT_FOUND',message:'没有找到本店的记录。'}});
 }catch(err){
  const code=typeof err.code==='string'?err.code:'INTERNAL_ERROR';
  const status=Number(err.httpStatus||err.statusCode||err.status)||(/CONFLICT|STALE|VERSION/i.test(code)?409:/NOT_FOUND|FORBIDDEN/i.test(code)?404:/INVALID|UNSUPPORTED|MISSING|REQUIRED|EMPTY|UNKNOWN_ASSET/i.test(code)?400:500);
  if(status>=500)console.error('Request failed',code,err.message);
  if(!res.headersSent)respond(res,status>=400&&status<=599?status:500,{error:{code,message:status>=500?'处理未完成，请查询原任务或按原请求重试。':err.message,...(typeof err.taskId==='string'?{taskId:err.taskId}:{})}});else res.end();
 }
});
server.listen(port,'127.0.0.1',()=>console.log('LOCAL http://127.0.0.1:'+server.address().port));
function stop(){server.close(()=>{db.close();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
