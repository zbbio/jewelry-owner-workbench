import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {privateImageDiagnostic,safeImageProviderCode,safeImageProviderParam} from './image-background-provider.mjs';

const valid=x=>typeof x==='string'&&/^[a-z0-9_.:-]{1,128}$/i.test(x);
const jobID=x=>typeof x==='string'&&/^img-job-[a-f0-9-]{36}$/.test(x);
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=(code,httpStatus)=>{throw Object.assign(Error(code),{code,httpStatus});};
const time=()=>new Date().toISOString();
const absolute=x=>typeof x==='string'&&path.isAbsolute(x);
const json=x=>JSON.stringify(x);
const emptyWork=()=>({deliveryStatus:'not_submitted',publishingStatus:'not_requested'});
const safeId=x=>valid(x)?x:null;
const safeCode=x=>typeof x==='string'&&/^IMAGE_[A-Z0-9_]{1,75}$/.test(x)?x:'IMAGE_EXECUTION_FAILED';
const safeHTTP=x=>Number.isSafeInteger(x)&&x>=100&&x<=599?x:null;

export const IMAGE_MAX_ATTEMPTS=131;
const thumbnailScript=[
 'import io,sys,warnings',
 'from PIL import Image,ImageOps',
 'Image.MAX_IMAGE_PIXELS=36000000',
 'warnings.simplefilter("error",Image.DecompressionBombWarning)',
 'with Image.open(io.BytesIO(sys.stdin.buffer.read())) as src:',
 '    if getattr(src,"n_frames",1)!=1 or src.width*src.height>36000000: raise ValueError("image size")',
 '    im=ImageOps.exif_transpose(src)',
 '    im.thumbnail((480,480),Image.Resampling.LANCZOS)',
 '    rgba=im.convert("RGBA")',
 '    bg=Image.new("RGB",rgba.size,"white")',
 '    bg.paste(rgba,mask=rgba.getchannel("A"))',
 '    bg.save(sys.stdout.buffer,"JPEG",quality=83,optimize=True)',
].join('\n');
const thumbnailLimit=2*1024*1024;
const jpeg=b=>b.length>=4&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217;

export function createImageBackgroundService({dataDir,planner,provider,allowGenerate=false,maxNewGenerations=1,python}={}){
 if(!absolute(dataDir)||typeof planner?.plan!=='function'||typeof planner?.readPinnedSource!=='function'||
    (maxNewGenerations!==null&&(!Number.isInteger(maxNewGenerations)||maxNewGenerations<0||maxNewGenerations>IMAGE_MAX_ATTEMPTS)))throw TypeError('Dedicated image data directory, planner and budget 0..131 or null required');
 const root=path.resolve(dataDir), dir=path.join(root,'image-works');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path.join(root,'image-background.sqlite'));
 db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
 db.exec([
  'CREATE TABLE IF NOT EXISTS image_jobs(job_id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, plan_id TEXT NOT NULL,',
  'request_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(shop_id,plan_id));',
  'CREATE TABLE IF NOT EXISTS image_requests(shop_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,',
  'job_id TEXT NOT NULL, plan_id TEXT NOT NULL, PRIMARY KEY(shop_id,actor_id,request_id));'
 ].join(' '));
 const byJob=db.prepare('SELECT payload FROM image_jobs WHERE shop_id=? AND job_id=?');
 const byPlan=db.prepare('SELECT payload FROM image_jobs WHERE shop_id=? AND plan_id=?');
 const byReq=db.prepare('SELECT job_id,plan_id FROM image_requests WHERE shop_id=? AND actor_id=? AND request_id=?');
 const list=db.prepare('SELECT payload FROM image_jobs WHERE shop_id=? ORDER BY rowid DESC LIMIT 500');
 const count=db.prepare('SELECT count(*) AS n FROM image_jobs');
 const unresolved=db.prepare("SELECT 1 FROM image_jobs WHERE json_extract(payload,'$.status') IN ('intent_recorded','submission_unknown') LIMIT 1");
 const create=db.prepare('INSERT INTO image_jobs VALUES (?,?,?,?,?)');
 const bind=db.prepare('INSERT INTO image_requests VALUES (?,?,?,?,?)');
 const change=db.prepare('UPDATE image_jobs SET payload=? WHERE shop_id=? AND job_id=?');
 const read=r=>r?JSON.parse(r.payload):null;
 let closed=false;
 function shop(ctx){
   if(ctx?.role!=='owner'||!valid(ctx.shopId)||!valid(ctx.actorId))fail('IMAGE_SCOPE_DENIED',403);
   return ctx.shopId;
 }
 const workPath=id=>path.join(dir,id+'-v1.png');
 function tx(fn){
   db.exec('BEGIN IMMEDIATE');
   try{const out=fn();db.exec('COMMIT');return out;}
   catch(e){db.exec('ROLLBACK');throw e;}
 }
 function existing(ctx,requestId,p){
   const r=byReq.get(ctx.shopId,ctx.actorId,requestId);
   if(r&&r.plan_id!==p.planId)fail('IMAGE_REQUEST_REUSE_CONFLICT',409);
   return read(r?byJob.get(ctx.shopId,r.job_id):byPlan.get(ctx.shopId,p.planId));
 }
 function associate(ctx,requestId,job){
   if(!byReq.get(ctx.shopId,ctx.actorId,requestId))bind.run(ctx.shopId,ctx.actorId,requestId,job.jobId,job.planId);
 }
 function record(ctx,job,patch){
   // No read path may turn a durable intent into another POST.
   const out={...job,...patch,updatedAt:time()};
   if(change.run(json(out),ctx.shopId,job.jobId).changes!==1)fail('IMAGE_INTENT_NOT_FOUND',409);
   return out;
 }
 function status(ctx,id){
   const s=shop(ctx);
   if(!jobID(id))fail('IMAGE_JOB_NOT_FOUND',404);
   const row=read(byJob.get(s,id));if(!row)fail('IMAGE_JOB_NOT_FOUND',404);
   return row;
 }
 function jobs(ctx){return list.all(shop(ctx)).map(read);}
 function work(ctx,{jobId,version}={}){
   const j=status(ctx,jobId);
   if(!j.work||j.status!=='preview_ready'||j.work.version!==version)fail('IMAGE_WORK_NOT_AVAILABLE',404);
   return j.work;
 }
 function media(ctx,{jobId,kind,version}={}){
   const j=status(ctx,jobId);
   if(version!==1||!['original','generated'].includes(kind))fail('IMAGE_MEDIA_NOT_AVAILABLE',404);
   if(kind==='original'){const {bytes,contentType,sourceSha256}=planner.readPinnedSource(j.source);return {bytes,contentType,sha256:sourceSha256};}
   if(j.status!=='preview_ready'||!j.work)fail('IMAGE_MEDIA_NOT_AVAILABLE',404);
   let bytes;
   try{bytes=fs.readFileSync(workPath(jobId));}catch{fail('IMAGE_MEDIA_NOT_AVAILABLE',404);}
   if(hash(bytes)!==j.work.sha256)fail('IMAGE_WORK_INTEGRITY_ERROR',409);
   return {bytes,contentType:'image/png',sha256:j.work.sha256};
 }
 function thumbnail(ctx,input){
   // Revalidate the scoped original/work pin before consulting any shared byte cache.
   const source=media(ctx,input);
   const folder=path.join(root,'image-thumbnails');
   fs.mkdirSync(folder,{recursive:true,mode:0o700});
   if(!fs.lstatSync(folder).isDirectory())fail('IMAGE_THUMBNAIL_UNAVAILABLE',503);
   const file=path.join(folder,'jpeg-v1-'+hash(source.bytes)+'.cache');
   try{
     const stat=fs.lstatSync(file);
     if(stat.isFile()&&stat.size<=thumbnailLimit+32){
       const packed=fs.readFileSync(file), bytes=packed.subarray(32);
       if(jpeg(bytes)&&packed.subarray(0,32).toString('hex')===hash(bytes))return {bytes,contentType:'image/jpeg'};
     }
   }catch(e){if(e.code!=='ENOENT')throw e;}
   if(typeof python!=='string'||!python)fail('IMAGE_THUMBNAIL_UNAVAILABLE',503);
   const r=spawnSync(python,['-I','-B','-c',thumbnailScript],{input:source.bytes,maxBuffer:thumbnailLimit,timeout:30000,windowsHide:true});
   if(r.error||r.status!==0||!r.stdout||!jpeg(r.stdout))fail('IMAGE_THUMBNAIL_UNAVAILABLE',503);
   const bytes=r.stdout, tmp=file+'.'+randomUUID()+'.tmp';
   const fd=fs.openSync(tmp,'wx',0o600);
   try{
     try{fs.writeFileSync(fd,Buffer.concat([Buffer.from(hash(bytes),'hex'),bytes]));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
     fs.renameSync(tmp,file);
   }finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
   return {bytes,contentType:'image/jpeg'};
 }
 function savePrivateDiagnostic(jobId,details){
   if(!jobID(jobId)||!details)return;
   const folder=path.join(root,'image-diagnostics');
   try{
     fs.mkdirSync(folder,{mode:0o700});
   }catch(e){if(e?.code!=='EEXIST')return;}
   try{
     const stat=fs.lstatSync(folder);
     if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))return;
     const fd=fs.openSync(path.join(folder,jobId+'.json'),'wx',0o600);
     try{fs.writeFileSync(fd,json(details)+'\n','utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   }catch{/* Preserve the upstream outcome even if the private filesystem is unavailable. */}
 }
 async function execute(ctx,input){
   shop(ctx);
   if(!input||Object.getPrototypeOf(input)!==Object.prototype||
      Object.keys(input).some(k=>!['requestId','args'].includes(k))||!valid(input.requestId))
     fail('IMAGE_REQUEST_INVALID',400);
   const {requestId,args}=input;
   const p=planner.plan(args,{userText:ctx.userText,expectedProductId:ctx.expectedProductId});
   if(p.requestedAction!=='preview')return p;
   // Query/replay is valid with submission switched off, but no new intent can be written.
   if(allowGenerate!==true||maxNewGenerations===0){
     const prior=existing(ctx,requestId,p);
     return prior?{...prior,reused:true}:{...p,status:'generation_disabled'};
   }
   // Reserve the intent using the independent image database before touching provider transport.
   // An intent left by a process crash is read as potentially sent; never replay it.
   let send;
   const got=tx(()=>{
     const old=existing(ctx,requestId,p);
     if(old){associate(ctx,requestId,old);return {job:old,reused:true};}
     if(maxNewGenerations!==null&&count.get().n>=maxNewGenerations)fail('IMAGE_BUDGET_EXHAUSTED',409);
     if(unresolved.get())fail('IMAGE_UNRESOLVED_SUBMISSION',409);
     if(typeof provider?.prepare!=='function')fail('IMAGE_PROVIDER_NOT_CONFIGURED',503);
     const src=planner.readPinnedSource(p.source);
     send=provider.prepare({source:src,expectedSha256:p.source.sourceSha256,backgroundBrief:p.backgroundBrief});
     if(typeof send!=='function')fail('IMAGE_PROVIDER_NOT_CONFIGURED',503);
     const jobId='img-job-'+randomUUID();
     const job={...p,status:'intent_recorded',generationStatus:'submission_pending_or_unknown',jobId,requestId,
       ...emptyWork(),creationAttempts:1,createdAt:time(),work:null,usage:null,providerRequestId:null,providerHttpStatus:null};
     create.run(jobId,ctx.shopId,p.planId,requestId,json(job));
     associate(ctx,requestId,job);
     return {job,reused:false};
   });
   const {job,reused}=got;
   if(reused)return {...job,reused};
   let out;
   try{out=await send();}
   catch(e){
     savePrivateDiagnostic(job.jobId,privateImageDiagnostic(e));
     return record(ctx,job,{status:e?.unknown===true?'submission_unknown':'failed',
       generationStatus:e?.unknown===true?'submission_unknown':'failed',errorCode:safeCode(e?.code),
       providerRequestId:safeId(e?.requestId),providerHttpStatus:safeHTTP(e?.httpStatus),providerCode:safeImageProviderCode(e?.providerCode),providerParam:safeImageProviderParam(e?.providerParam)});
   }
   const providerMeta={providerRequestId:safeId(out?.requestId),providerHttpStatus:safeHTTP(out?.httpStatus),usage:out?.usage??null};
   try{
     if(!Buffer.isBuffer(out?.bytes)||out.contentType!=='image/png'||hash(out.bytes)!==out.sha256||
        !Number.isSafeInteger(out.width)||!Number.isSafeInteger(out.height))fail('IMAGE_OUTPUT_INVALID',502);
     const file=workPath(job.jobId),tmp=file+'.'+randomUUID()+'.tmp';
     const fd=fs.openSync(tmp,'wx',0o600);
     try{
       try{fs.writeFileSync(fd,out.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
       // Link without overwrite: neither a restart nor a wrong path can replace an old work.
       fs.linkSync(tmp,file);
     }finally{fs.unlinkSync(tmp);}
   }catch(e){
     return record(ctx,job,{...providerMeta,status:'failed',generationStatus:'failed',
       errorCode:e?.code==='IMAGE_OUTPUT_INVALID'?e.code:'IMAGE_WORK_STORE_FAILED'});
   }
   const work={assetId:'image-work:'+job.jobId,version:1,contentType:out.contentType,sha256:out.sha256,width:out.width,
     height:out.height,sourceWidth:out.sourceWidth,sourceHeight:out.sourceHeight,bytes:out.bytes.length,sourceSha256:p.source.sourceSha256,aiGenerated:true};
   return record(ctx,job,{...providerMeta,status:'preview_ready',generationStatus:'completed',qualityStatus:'needs_review',warnings:out.warnings?.includes('SOURCE_ASPECT_RATIO_CHANGED')?['SOURCE_ASPECT_RATIO_CHANGED']:[],work});
 }
 return Object.freeze({execute,status,jobs,work,media,thumbnail,close(){if(!closed){db.close();closed=true;}}});
}
