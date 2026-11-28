import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chmodSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const imageTurnsPath='/api/message-photos/image-turns';
const assetPath='/api/message-photos/assets', historyPath='/api/message-photos/messages', videoTurnsPath='/api/message-photos/video-turns';
const secureCookieName='mvp_message_photos', demoCookieName='mvp_message_photos_http';
const isLoopback=addr=>addr==='127.0.0.1'||addr==='::1'||addr==='::ffff:127.0.0.1';
const MiB=1024*1024, maxBytes=10*MiB, maxStore=128*MiB, maxScope=64*MiB;
const token=/^[a-f0-9]{64}$/;
const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const formats=new Map([['image/jpeg','JPEG'],['image/png','PNG'],['image/webp','WEBP']]);
const notFound='找不到这张照片。';
const privateHeaders={'cache-control':'private, no-store','vary':'Cookie','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin'};
const json=(res,status,body)=>{res.writeHead(status,{...privateHeaders,'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));return true};
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const replyFor=(n,text)=>'已收到'+n+'张照片。'+(text?'':'想怎么处理这些图片？')+' 当前新增图片生成未开放，本条未提交生成。';

// This guard only narrows admission/tool availability; the SDK still selects tools.
const videoSubject=/视频|短片|成片|片子|做片|出片|旧片|参考片|片段|旧素材/u;
const storageOnly=/(?:只|仅)\s*(?:收存|保存|留存|留档|存档|收着|存图)|(?:取消|停止)\s*(?:本轮|这次|这条)?(?:视频|短片|成片|制作)|(?:视频|短片|成片)[^。！？；;，,]{0,6}(?:取消|停止)/u;
const noMake=/(?:先别|先不|暂不|暂缓|不需要|不要|不用|无需|禁止|取消|停止|别|不必|不想|不)\s*(?:(?:再|重新|实际|现在|马上|直接|给我)\s*){0,3}(?:(?:本轮|这次|这条)?(?:视频|短片|成片)|(?:生成|制作|重做|做)(?!\s*(?:配音|旁白|解说|字幕|音乐|配乐|片头|片尾|人声))|出片)|(?:视频|短片|成片)\s*(?:暂时|这次)?\s*(?:先)?不考虑/u;
const planOnly=/(?:列|拟|写|给我|提供|只看|先看)\s*(?:个|一份|一下|一版)?\s*(?:参考视频|视频|短片|成片)?(?:方案|分镜|脚本|计划|镜头)/u;
const noPlan=/(?:先别|先不|不要|无需|不用|别|不)\s*(?:再\s*)?(?:列|拟|写|给|提供)[^。！？；;，,]{0,10}(?:方案|分镜|脚本|计划|镜头)/u;
const lookupOnly=/(?:只|仅)\s*(?:查|找|看|检索)|(?:查看|查询|找找|回看)\s*(?:已有|已做的|已生成的|之前的|以前的)?(?:成片|旧片|视频任务|视频状态)/u;
const makeDirect=/(?:做|生成|制作|编辑|剪辑|改成)(?!\s*(?:过|好|完|的|了|方案|脚本|分镜|规划))[^。！？；;，,]{0,10}(?:视频|短片|成片|片子)(?!\s*(?:方案|脚本|分镜|规划))|做片|出片/u;
const makeEdition=/(?:视频|短片|成片|片子|旧片|参考片|片段|旧素材)[^。！？；;]{0,30}(?:做|制作|剪|剪辑|生成|出)\s*(?:一|1)(?:个)?版/u;
export function referenceVideoIntent(text){
 if(typeof text!=='string'||!videoSubject.test(text)||storageOnly.test(text))return 'none';
 if(planOnly.test(text)&&!noPlan.test(text))return 'plan';
 if(lookupOnly.test(text))return 'lookup';
 if(noMake.test(text))return 'none';
 return makeDirect.test(text)||makeEdition.test(text)?'make':'lookup';
}
export function isReferenceVideoTurn(text,attached=false){
 return referenceVideoIntent(text)!=='none'&&
   (attached||/这(?:一|两|三)?张(?:商品|珠宝|手串|珠串|手链|项链|耳饰|戒指)?(?:图|照片)|刚才.{0,8}(?:照片|图片|那张)|刚(?:刚)?发.{0,8}(?:照片|图片|那张|(?:手串|珠串|商品|珠宝)照)|上面那张|上传.{0,8}(?:照片|图片|那张)|刚发的图/.test(text));
}
const videoWait='照片已绑定；正在匹配已登记参考素材，尚未确认新生成。';
const videoUnknown='视频请求结果暂不明确，未自动重试。请查看已有任务状态。';
const videoClarify='请明确只选一张作为本件目标照片，再说明要做的视频。';
const imageWait='照片已绑定，正在处理换背景请求；请查看原消息进度。';
const imageUnknown='图片请求结果暂不明确，只查看原任务，不自动重试。';
const imageClarify='请选一张照片作为本次换背景的原图；多张照片请单独发送要处理的那张。';

function photoCookiePolicy(req,secureDefault){
 const forwarded=req.headers['x-forwarded-proto'];
 // The Node listener is loopback-only. The local reverse proxy must replace, not
 // append or relay, the client-supplied protocol header. Unknown hints fail secure.
 const proxyHttp=!req.socket.encrypted&&forwarded==='http'&&
   isLoopback(req.socket.remoteAddress)&&isLoopback(req.socket.localAddress);
 const secure=Boolean(!proxyHttp&&(req.socket.encrypted||forwarded!==undefined||secureDefault));
 return {name:secure?secureCookieName:demoCookieName,secure,proxyHttp};
}
// Retain the R1 HTTPS digest; an HTTP token is never valid in that namespace.
const photoScopeDigest=(name,value)=>sha(name===demoCookieName?'http-demo-v1:'+value:value);
function issuePhotoScope(res,policy){
 const value=randomBytes(32).toString('hex');
 res.setHeader('set-cookie',policy.name+'='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+(policy.secure?'; Secure':''));
 return photoScopeDigest(policy.name,value);
}
function scopeOf(req,cookieName){
 const cookies=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));
 if(cookies.length!==1)return null;
 const value=cookies[0].slice(cookieName.length+1);
 return token.test(value)?photoScopeDigest(cookieName,value):null;
}
function sameSite(req){
 const site=req.headers['sec-fetch-site'];
 return !site||site==='same-origin'||site==='none';
}
function readImageBody(req,res){
 return new Promise((resolve,reject)=>{
   const lengths=req.headers['content-length'];
   const discard=()=>{res.setHeader('connection','close');req.resume()};
   if(lengths&&Number(lengths)>maxBytes){discard();reject(fail(413,'每张照片最多 10 MiB。'));return}
   let total=0,ended=false,chunks=[];
   const timer=setTimeout(()=>finish(fail(408,'上传超时，请重试。'),true),20000);
   function finish(err,close=false){
     if(ended)return;ended=true;clearTimeout(timer);
     if(close)discard();
     if(err){chunks=[];reject(err)}else resolve(Buffer.concat(chunks,total));
   }
   req.on('data',chunk=>{
     if(ended)return;
     total+=chunk.length;
     if(total>maxBytes)finish(fail(413,'每张照片最多 10 MiB。'),true);
     else chunks.push(chunk);
   });
   req.once('end',()=>finish());req.once('error',()=>finish(fail(400,'上传已中断，请重试。')));
   req.once('aborted',()=>finish(fail(400,'上传已中断，请重试。')));
 });
}
function matchesMagic(bytes,type){
 if(type==='image/jpeg')return bytes.length>=4&&bytes.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))&&bytes.readUInt16BE(bytes.length-2)===0xffd9;
 if(type==='image/png')return bytes.length>=20&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex'));
 return bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)===bytes.length-8;
}
const decoder=[
 'import io,struct,sys,warnings',
 'from PIL import Image,ImageOps,ImageFile',
 'Image.MAX_IMAGE_PIXELS = 36000000',
 'ImageFile.LOAD_TRUNCATED_IMAGES = False',
 'warnings.simplefilter("error", Image.DecompressionBombWarning)',
 'raw=sys.stdin.buffer.read(10*1024*1024+1)',
 'fmt=sys.argv[1]',
 'def check(im):',
 '    if im.format != fmt or im.width*im.height > 36000000 or getattr(im,"n_frames",1) != 1: raise ValueError()',
 'with Image.open(io.BytesIO(raw), formats=[fmt]) as im:',
 '    check(im); im.verify()',
 'with Image.open(io.BytesIO(raw), formats=[fmt]) as im:',
 '    check(im); im.load()',
 '    width,height=im.size',
 '    im.thumbnail((320,320))',
 '    orient=ImageOps.exif_transpose(im)',
 '    rgba=orient.convert("RGBA")',
 '    thumb=Image.new("RGB",rgba.size,(255,255,255)); thumb.paste(rgba,mask=rgba.getchannel("A"))',
 '    sys.stdout.buffer.write(struct.pack(">II",width,height)); thumb.save(sys.stdout.buffer,format="JPEG",quality=83)',
].join('\n');
function inspect(bytes,type,python){
 return new Promise((resolve,reject)=>{
  const child=spawn(python,['-I','-B','-c',decoder,formats.get(type)],{stdio:['pipe','pipe','ignore'],windowsHide:true});
  const chunks=[];let length=0,invalid=false,timeout=false;
  const timer=setTimeout(()=>{timeout=true;child.kill()},12000);
  child.stdout.on('data',b=>{length+=b.length;if(length>512*1024){invalid=true;child.kill()}else chunks.push(b)});
  child.stdin.on('error',()=>{});
  child.once('error',()=>{clearTimeout(timer);reject(fail(503,'照片校验暂不可用，请稍后重试。'))});
  child.once('close',code=>{
   clearTimeout(timer);
   if(timeout){reject(fail(503,'照片校验超时，请稍后重试。'));return}
   if(code!==0||invalid||length<12){reject(fail(415,'照片损坏、包含多帧或超过 3600 万像素。'));return}
   const out=Buffer.concat(chunks,length);
   const width=out.readUInt32BE(0),height=out.readUInt32BE(4);
   if(!width||!height||width*height>36e6){reject(fail(415,'照片尺寸无效。'));return}
   resolve({width,height,thumbnail:out.subarray(8)});
  });
  child.stdin.end(bytes);
 });
}
const metadata='id,sha256,type,bytes,width,height';
const assetRef=row=>({id:row.id,sha256:row.sha256,contentType:row.type,bytes:row.bytes,width:row.width,height:row.height,url:assetPath+'/'+row.id,thumbnailUrl:assetPath+'/'+row.id+'/thumbnail'});
export function openMessagePhotos({dir,python,secure=false}){
 mkdirSync(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,'photos.sqlite');
 const db=new DatabaseSync(file);
 if(process.platform!=='win32')chmodSync(file,0o600);
 db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
 // Byte quotas account for original + thumbnail; cap DB pages as an additional guard.
 const pageSize=db.prepare('pragma page_size').get().page_size;
 db.exec('PRAGMA max_page_count='+Math.floor(152*MiB/pageSize));
 db.exec("CREATE TABLE IF NOT EXISTS photos (scope TEXT NOT NULL, upload_key TEXT NOT NULL, id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, type TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, body BLOB NOT NULL, thumb BLOB NOT NULL, PRIMARY KEY(scope,upload_key)); CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(scope,request_id));");
 const findUpload=db.prepare('SELECT '+metadata+' FROM photos WHERE scope=? AND upload_key=?');
 const findMeta=db.prepare('SELECT '+metadata+' FROM photos WHERE scope=? AND id=?');
 const bindPhoto=db.prepare('SELECT '+metadata+',body FROM photos WHERE scope=? AND id=?');
 const findMessage=db.prepare('SELECT signature,payload FROM messages WHERE scope=? AND request_id=?');
 const stored=db.prepare('SELECT COUNT(*) AS n,coalesce(sum(bytes+length(thumb)),0) AS bytes FROM photos');
 const owned=db.prepare('SELECT COUNT(*) AS n,coalesce(sum(bytes+length(thumb)),0) AS bytes FROM photos WHERE scope=?');
 const put=db.prepare('INSERT INTO photos VALUES (?,?,?,?,?,?,?,?,?,?)');
 const save=db.prepare('INSERT INTO messages(scope,request_id,signature,payload) VALUES (?,?,?,?)');
 const getHistory=db.prepare('SELECT payload FROM messages WHERE scope=? ORDER BY seq');
 const photoRoot=path.resolve(realpathSync(dir),'workflow-inputs');
 function openTurns(table,turnProp,wait,unknown,clarify,label){
   db.exec('CREATE TABLE IF NOT EXISTS '+table+' (seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(scope,request_id));');
   return {turnProp,wait,unknown,clarify,label,
     find:db.prepare('SELECT signature,payload FROM '+table+' WHERE scope=? AND request_id=?'),
     put:db.prepare('INSERT INTO '+table+'(scope,request_id,signature,payload) VALUES (?,?,?,?)'),
     set:db.prepare('UPDATE '+table+' SET payload=? WHERE scope=? AND request_id=?'),
     total:db.prepare('SELECT COUNT(*) n FROM '+table),
     list:db.prepare('SELECT payload FROM '+table+' WHERE scope=? ORDER BY seq DESC LIMIT 100')};
 }
 const videoLane=openTurns('style_video_turns','styleVideoTurn',videoWait,videoUnknown,videoClarify,'视频');
 const imageLane=openTurns('style_image_turns','styleImageTurn',imageWait,imageUnknown,imageClarify,'图片');
 const recentMessage=db.prepare('SELECT payload FROM messages WHERE scope=? ORDER BY seq DESC LIMIT 1');
 const readTurn=(row,lane)=>{
   const turn=JSON.parse(row.payload);
   // A previous process may have submitted before persisting its receipt: never resume that POST.
   return turn.state==='routing'&&!activeTurns.has(turn.scopeKey)?{...turn,state:'uncertain',reply:lane.unknown}:turn;
 };
 const activeTurns=new Set();
 const countMessages=db.prepare('SELECT COUNT(*) n FROM messages'), countOwner=db.prepare('SELECT COUNT(*) n FROM messages WHERE scope=?');
 const media={original:db.prepare('SELECT type, body AS data, bytes FROM photos WHERE scope=? AND id=?'),
   thumbnail:db.prepare("SELECT 'image/jpeg' type, thumb AS data,length(thumb) bytes FROM photos WHERE scope=? AND id=?")};
 const heads={original:findMeta,thumbnail:db.prepare("SELECT 'image/jpeg' type,length(thumb) bytes FROM photos WHERE scope=? AND id=?")};
 const rate=new Map();let running=0;
 function rateAllowed(req){
   // Use the TCP peer only, never a caller-specified X-Forwarded-For. A shared reverse
   // proxy shares this limit unless operators add their own trusted edge limits.
   const now=Date.now(),peer=req.socket.remoteAddress||'unknown';
   for(const [key,b] of rate)if(b.until<=now)rate.delete(key);
   const bucket=rate.get(peer);
   if(bucket){if(bucket.n>=18)return false;bucket.n++;return true}
   if(rate.size>=2048)return false;
   rate.set(peer,{n:1,until:now+60000});return true;
 }
 function atomic(fn){
   db.exec('BEGIN IMMEDIATE');
   try{const value=fn();db.exec('COMMIT');return value}
   catch(e){db.exec('ROLLBACK');throw e}
 }
 function sendError(res,e){
   // No SQLite/Pillow errors, file paths, cookie values, or raw bytes in API/logs.
   return e.statusCode?json(res,e.statusCode,{error:e.message}):json(res,503,{error:'照片服务暂不可用，请稍后重试。'});
 }
 async function upload(req,res,scope,policy){
   // R1's open page has already tried history and will retry the same draft
   // without fetching it again. Only the trusted HTTP demo's own page may bootstrap.
   // Browsers can omit Fetch Metadata on a public plaintext origin; Origin is still required.
   const site=req.headers['sec-fetch-site'];
   const bootstrap=!scope&&policy.proxyHttp&&(!site||site==='same-origin')&&
     Boolean(req.headers.host)&&req.headers.origin==='http://'+req.headers.host;
   if(!scope&&!bootstrap){req.resume();return json(res,403,{error:'请刷新页面后再发送照片。'})}
   if(!formats.has(req.headers['content-type'])||!id.test(req.headers['x-message-photo-key']||'')){
     req.resume();return json(res,415,{error:'请选择 JPEG、PNG 或 WebP 照片。'});
   }
   if(!rateAllowed(req)||running>=2){req.resume();res.setHeader('retry-after','60');return json(res,429,{error:'照片上传较多，请稍后重试。'})}
   running++;
   try{
    const type=req.headers['content-type'],key=req.headers['x-message-photo-key'];
    const bytes=await readImageBody(req,res);
    if(bootstrap)scope=issuePhotoScope(res,policy);
    const hash=sha(bytes);
    const match=()=>{
     const row=findUpload.get(scope,key);
     if(row&&(row.sha256!==hash||row.type!==type))throw fail(409,'同一个上传编号对应了不同照片，请重新选择。');
     return row;
    };
    let row=match();
    if(row)return json(res,200,{asset:assetRef(row)});
    if(!matchesMagic(bytes,type))throw fail(415,'照片内容与格式不符。');
    const {width,height,thumbnail}=await inspect(bytes,type,python);
    let replay=false;
    row=atomic(()=>{
     const prior=match();if(prior){replay=true;return prior}
     const total=stored.get(),local=owned.get(scope),cost=bytes.length+thumbnail.length;
     if(total.n>=2048||total.bytes+cost>maxStore||local.n>=120||local.bytes+cost>maxScope)throw fail(507,'照片存储已达上限，本次未保存。');
     const photoId=randomUUID();
     // Both private blobs and metadata commit in the same SQLite transaction.
     put.run(scope,key,photoId,hash,type,bytes.length,width,height,bytes,thumbnail);
     return findMeta.get(scope,photoId);
    });
    return json(res,replay?200:201,{asset:assetRef(row)});
   }catch(e){return sendError(res,e)}finally{running--}
 }
 function getScope(req){return sameSite(req)?scopeOf(req,photoCookiePolicy(req,secure).name):null}
 const noPrivate=({scopeKey,...turn})=>turn;
 function pinnedPhoto(scope,photoId){
   const row=bindPhoto.get(scope,photoId);
   if(!row||sha(row.body)!==row.sha256||!formats.has(row.type))throw fail(404,notFound);
   mkdirSync(photoRoot,{recursive:true,mode:0o700});
   const folder=path.join(photoRoot,scope);
   mkdirSync(folder,{recursive:true,mode:0o700});
   if(realpathSync(photoRoot)!==photoRoot||realpathSync(folder)!==folder)throw fail(404,notFound);
   const f=path.join(folder,row.id+({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'})[row.type]);
   try{writeFileSync(f,row.body,{flag:'wx',mode:0o600,flush:true})}catch(e){if(e.code!=='EEXIST')throw e}
   if(realpathSync(f)!==f||sha(readFileSync(f))!==row.sha256)throw fail(404,notFound);
   return {photoId:row.id,sha256:row.sha256,path:f,mimeType:row.type};
 }
 function queueTurn(lane,scope,requestId,text,anchor,dispatch,inline){
   const key=(lane===imageLane?'image:':'')+scope+':'+requestId, signature=sha(JSON.stringify([text,inline?anchor?.messageId:null,inline]));
   let start=false, turn;
   atomic(()=>{
     const prior=lane.find.get(scope,requestId);
     if(prior){
       if(prior.signature!==signature)throw fail(409,'该消息编号已提交不同内容。');
       turn=readTurn(prior,lane);return;
     }
     if(lane.total.get().n>=4096)throw fail(507,lane.label+'请求记录已达保存上限。');
     const valid=anchor?.attachments?.length===1;
     turn={id:requestId,scopeKey:key,messageId:inline?anchor?.messageId:null,photoMessageId:anchor?.messageId||null,
       ...(inline?{}:{userText:text}),...(lane===imageLane&&valid?{sourceSha256:anchor.attachments[0].sha256}:{}),state:valid?'routing':'clarify',reply:valid?lane.wait:lane.clarify};
     lane.put.run(scope,requestId,signature,JSON.stringify(turn));start=valid;
   });
   if(start){
     activeTurns.add(key);
     // Work runs only after the DB claim commits; an attachment replay does not enqueue the task again.
     void Promise.resolve().then(async()=>{
       const photo=pinnedPhoto(scope,anchor.attachments[0].id);
       return await dispatch({scope,requestId,userText:text,photos:[photo],messageId:anchor.messageId});
     }).then(out=>{
       const next={...turn,state:out?.state==='uncertain'?'uncertain':'complete',reply:typeof out?.reply==='string'?out.reply.slice(0,4000):'已返回风格'+lane.label+'工作流回执。'};
       if(out?.job)next.job=out.job;
       if(lane===imageLane&&out?.tool)next.tool=out.tool;
       if(out?.runtime==='openai_agents_sdk'&&out.mode==='deepseek'){
         Object.assign(next,{runtime:out.runtime,mode:out.mode,model:out.model,
           routeRequestId:out.routeRequestId,receipts:out.receipts});
       }
       lane.set.run(JSON.stringify(next),scope,requestId);
     }).catch(()=>{try{lane.set.run(JSON.stringify({...turn,state:'uncertain',reply:lane.unknown}),scope,requestId)}catch{}})
       .finally(()=>activeTurns.delete(key));
   }
   return noPrivate(turn);
 }
 function followTurn(lane,req,res,payload,dispatch){
   if(!sameSite(req)||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,403,{error:'请从当前页面发起'+lane.label+'请求。'});
   const {text,requestId}=payload;
   if(typeof text!=='string'||text.length>4000||(requestId!==undefined&&(typeof requestId!=='string'||!id.test(requestId)))||
      Object.keys(payload).some(k=>!['text','requestId'].includes(k)))return json(res,400,{error:'请使用本会话的照片和'+lane.label+'指令。'});
   const scope=getScope(req);
   if(!scope)return json(res,200,{reply:lane.clarify,[lane.turnProp]:{state:'clarify',reply:lane.clarify}});
   try{
     const row=recentMessage.get(scope), anchor=row?JSON.parse(row.payload):null;
     const key=sha(JSON.stringify([text,anchor?.messageId])).slice(0,32).replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
     const turn=queueTurn(lane,scope,requestId||key,text,anchor,dispatch,false);
     return json(res,200,{reply:turn.reply,[lane.turnProp]:turn});
   }catch(e){return sendError(res,e)}
 }
 function receive(req,res,payload,dispatch,imageDispatch){
   if(!sameSite(req)||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,403,{error:'请从当前页面发送照片。'});
   const scope=getScope(req);
   if(!scope)return json(res,403,{error:'请刷新页面后再发送照片。'});
   const {text='',attachments,requestId}=payload;
   if(Object.keys(payload).some(k=>!['text','attachments','requestId'].includes(k))||typeof text!=='string'||text.length>4000||
      typeof requestId!=='string'||!id.test(requestId)||!Array.isArray(attachments)||attachments.length<1||attachments.length>3||
      new Set(attachments).size!==attachments.length||attachments.some(i=>typeof i!=='string'||!id.test(i))){
     return json(res,400,{error:'每条消息请选择 1 至 3 张不同照片，文字最多 4000 字。'});
   }
   try{
    const signature=sha(JSON.stringify([text,attachments]));
    const video=typeof dispatch==='function'&&isReferenceVideoTurn(text,true);
    const image=typeof imageDispatch==='function'&&!video;
    let created=false;
    const out=atomic(()=>{
     const refs=attachments.map(photoId=>{
       const row=bindPhoto.get(scope,photoId);
       if(!row||sha(row.body)!==row.sha256)throw fail(404,notFound);
       return assetRef(row);
     });
     const existing=findMessage.get(scope,requestId);
     if(existing){
       if(existing.signature!==signature)throw fail(409,'该消息编号已提交不同内容。');
       return JSON.parse(existing.payload);
     }
     if(countMessages.get().n>=4096||countOwner.get(scope).n>=200)throw fail(507,'照片消息已达保存上限，本条未保存。');
     const message={messageId:randomUUID(),text,attachments:refs,status:'received',generationSubmitted:false,mediaAnalyzed:false,reply:video||image?'已收到'+refs.length+'张照片。':replyFor(refs.length,text.trim())};
     save.run(scope,requestId,signature,JSON.stringify(message));created=true;
     return message;
    });
     const lane=video?videoLane:image?imageLane:null;
    // A receipt created before this workflow existed is not permission to enqueue on replay.
    const turn=lane&&(lane!==imageLane||created||lane.find.get(scope,requestId))?
      queueTurn(lane,scope,requestId,text,out,video?dispatch:imageDispatch,true):null;
    return json(res,200,{received:true,messageId:out.messageId,message:out,reply:turn?.reply||out.reply,tool:null,...(turn?{[lane.turnProp]:turn}:{})});
   }catch(e){return sendError(res,e)}
 }
 async function handle(req,res,url){
   const p=url.pathname;
   if(p!==historyPath&&p!==videoTurnsPath&&p!==imageTurnsPath&&p!==assetPath&&!p.startsWith(assetPath+'/'))return false;
   const method=req.method;
   if(!sameSite(req)){if(method==='POST')req.resume();return json(res,403,{error:'请从当前页面访问照片。'})}
   const policy=photoCookiePolicy(req,secure),scope=scopeOf(req,policy.name);
   try{
    if((p===videoTurnsPath||p===imageTurnsPath)&&method==='GET'){
     const lane=p===imageTurnsPath?imageLane:videoLane;
     if(!scope)return json(res,403,{error:'请从当前照片会话查看'+lane.label+'状态。'});
     return json(res,200,{turns:lane.list.all(scope).reverse().map(row=>noPrivate(readTurn(row,lane)))});
    }
    if(p===historyPath&&method==='GET'){
     if(!scope)issuePhotoScope(res,policy);
     return json(res,200,{messages:scope?getHistory.all(scope).map(x=>JSON.parse(x.payload)):[]});
    }
    if(p===assetPath&&method==='POST')return await upload(req,res,scope,policy);
    const [photoId,suffix,extra]=p.slice(assetPath.length+1).split('/');
    if(!scope||!id.test(photoId)||extra!==undefined||(suffix!==undefined&&suffix!=='thumbnail'))return json(res,404,{error:notFound});
    if(method!=='GET'&&method!=='HEAD')return json(res,405,{error:'此照片入口只供查看。'});
    const group=suffix==='thumbnail'?'thumbnail':'original';
    const row=(method==='HEAD'?heads:media)[group].get(scope,photoId);
    if(!row)return json(res,404,{error:notFound});
    res.writeHead(200,{...privateHeaders,'content-type':row.type,'content-length':row.bytes});
    res.end(method==='HEAD'?undefined:row.data);return true;
   }catch(e){return sendError(res,e)}
 }
 return {handle,receive,referenceVideo:(...args)=>followTurn(videoLane,...args),
  uploadedImage:(...args)=>followTurn(imageLane,...args),getScope,photoRoot,close:()=>db.close()};
}
