import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const exec=promisify(execFile), finish=fileURLToPath(new URL('./reference-video-finish.py',import.meta.url));
const mediaEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(?:PATH|SystemRoot|WINDIR|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL|LD_LIBRARY_PATH)$/i.test(k)));
mediaEnv.PYTHONUTF8='1';

const RULE='customer-name-bgm-v1', planName='content_video_plan', makeName='content_video_make', statusName='content_video_status', searchName='content_video_search_reference';
const SH=/^[a-f0-9]{64}$/, UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, ID=/^[A-Za-z0-9_-]{1,100}$/;
const limits={photo:30*1024**2,reference:200*1024**2,media:256*1024**2};
const images={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'};
const hash=b=>createHash('sha256').update(b).digest('hex');
const keyOf=(pic,ref)=>hash(JSON.stringify([pic,ref,RULE]));
const stamp=()=>new Date().toISOString();
const deny=code=>{throw Object.assign(Error(code),{code});};
const text=(v,length=160)=>typeof v==='string'?v.trim().slice(0,length):'';
const fields={ [searchName]:['query'], [planName]:['photoId','referenceId'],[makeName]:['planId'],[statusName]:['jobId'] };
const definitions=Object.entries(fields).map(([name,keys])=>({type:'function',function:{name,
 description:{[searchName]:'只查已登记的完整参考片标签，不宣称看过图片。',[planName]:'按本次授权的照片与已登记完整参考片给方案，保参考节奏/BGM、只留确认品名；不制作。',[makeName]:'仅在店主当轮明确要制作时执行已确认方案；能复用同图同参考同规则的已验成片时不新生成。',[statusName]:'只读本会话已有任务；绝不重新制作。'}[name],
 parameters:{type:'object',properties:Object.fromEntries(keys.map(k=>[k,{type:'string'}])),required:keys,additionalProperties:false}}}));
const b64Mime=(buffer,type)=>type==='image/jpeg'?buffer.subarray(0,3).equals(Buffer.from([255,216,255])):
 type==='image/png'?buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
 type==='image/webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';
function readPinned(file,pin,limit,fail,root){
 if(typeof file!=='string'||!path.isAbsolute(file)||!SH.test(pin||''))deny(fail);
 let real,stat;
 try{real=fs.realpathSync(file);stat=fs.statSync(real);}catch{deny(fail);}
 if(root){const child=path.relative(root,real);if(!child||child==='..'||child.startsWith('..'+path.sep)||path.isAbsolute(child))deny(fail);}
 if(!stat.isFile()||stat.size<1||stat.size>limit)deny(fail);
 const bytes=fs.readFileSync(real);if(bytes.length!==stat.size||hash(bytes)!==pin)deny(fail);
 return bytes;
}
const mp4=b=>b.length>12&&b.subarray(4,8).toString()==='ftyp';
function approvedTitle(ref){
 const {titleBox:b,titleProfile:p}=ref;
 return (p==='opening-gold-v1'||p==='no-embedded-product-title')||
  (p===undefined&&b&&['x','y','w','h'].every(k=>Number.isSafeInteger(b[k]))&&
   b.x>=0&&b.y>=0&&b.w>0&&b.h>0&&b.x+b.w<=720&&b.y+b.h<=940&&
   (b.startSeconds===undefined||Number.isFinite(b.startSeconds))&&(b.endSeconds===undefined||Number.isFinite(b.endSeconds))&&
   (b.startSeconds??0)>=0&&(b.endSeconds??0.042)>(b.startSeconds??0)&&(b.endSeconds??0.042)<=ref.durationSeconds+0.25);
}
function cleanName(raw,fallback){
 const value=text(raw,33);
 return value&&Array.from(value).length<=32&&!/BCMLDIY|货号|编号|[0-9]{3,}\s*号|价格|证书|¥|[\r\n<>]/iu.test(value)?value:fallback;
}
function explicitMake(s){
 if(typeof s!=='string'||!s||/(?:不要|别|先不|暂不|不必|不用|无需|不想|不能|不|禁止|取消|停止|暂缓)\s*(?:(?:再|重新|马上|现在|真的|直接|给我)\s*){0,3}(?:生成|制作|出片|重做|做)(?!\s*(?:(?:新增|新的|任何)\s*)?(?:旁白|配音|解说|配乐|人声|音乐|字幕|片头|片尾))|(?:只|仅).{0,6}(?:方案|脚本|镜头|查旧片)|(?:只|仅)(?:想|是想|需要)?(?:查(?:找|看)?|找|收存|保存|上传)/u.test(s))return false;
 if(/(?:制作|生成|出个|做成|做|给我出)(?!\s*(?:过|好|完|的|了|方案|脚本|分镜))[^。！；!?]{0,24}(?:视频|短片|成片)(?!\s*(?:方案|脚本|分镜|规划))|(?:^|[，；,])\s*(?:请|帮我|直接)?\s*出片(?:$|[，。！；,])/u.test(s))return true;
 // An omitted object is authorized only with both a reference-film cue and
 // an imperative edit action; an unrelated “做” or a capability question is not consent.
 if(/(?:请问|想问|能不能|可不可以|能否|可以不可以|如何|怎么|是否能)|[?？]\s*$/u.test(s))return false;
 const reference=/(?:原片|旧片|参考片|样片)|(?:参考|参照|照着|沿用|跟着|以前|之前|过往|原来|旧的)[^，、；。！？!?,;\r\n]{0,14}(?:视频|短片|成片|片子|样片|片段)|(?:视频|短片|片子|样片|片段)[^，、；。！？!?,;\r\n]{0,10}(?:作参考|当参考|做参考)/u;
 const edition=/(?:做(?:出|成)?\s*(?:一|1)(?:版|条)|(?:照着|照此)\s*(?:(?:它|原片|旧片|参考片|[这那](?:段|部))\s*)?做)(?:\s*吧)?(?=\s*(?:$|[，、；。！？!?,;\r\n]|先(?:别发|给我看)|别发|给我(?:看|过目)))/u;
 return reference.test(s)&&edition.test(s);
}

const prompt='编辑 @视频1：只替换原镜头中目标珠宝为 @图片1 同一件的外观；图片只是珠宝外观参考，不插入图片帧。保留珠序、圈型、人物、手势、光线、构图、镜头先后、切点、动作、片长、原来源水印及AI标。不改其他画面，不增加镜头、片头片尾、新文字、旁白或音乐。只输出完整原参考视频长度的局部替换结果。';
export function createReferenceVideoWorkflow({dataDir,photoRoot,referenceEntries=[],knownWorks=[],provider,allowGenerate=false,maxNewGenerations=1,ffmpeg,ffprobe,python,font=process.env.STYLE_VIDEO_FONT_PATH}={}){
 if(typeof dataDir!=='string'||typeof photoRoot!=='string'||![0,1].includes(maxNewGenerations)||!Array.isArray(referenceEntries)||!Array.isArray(knownWorks))
  deny('WORKFLOW_CONFIGURATION');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const dir=fs.realpathSync(dataDir),root=fs.realpathSync(photoRoot);
 const references=new Map();
 for(const item of referenceEntries){
  const r=structuredClone(item);
  if(!ID.test(r?.referenceId||'')||!text(r.name)||!SH.test(r.sha256||'')||!path.isAbsolute(r.path||'')||references.has(r.referenceId)||
     !Number.isFinite(r.durationSeconds)||r.durationSeconds<10||r.durationSeconds>180||r.tags&&!Array.isArray(r.tags))deny('REFERENCE_REGISTRATION_INVALID');
  references.set(r.referenceId,r);
 }
 const known=new Map();
 for(const x of knownWorks){
  if(!SH.test(x?.photoSha256||'')||!SH.test(x.referenceSha256||'')||x.ruleVersion!==RULE||!SH.test(x.sha256||'')||!path.isAbsolute(x.path||''))deny('KNOWN_WORK_REGISTRATION_INVALID');
  const key=keyOf(x.photoSha256,x.referenceSha256);if(known.has(key))deny('KNOWN_WORK_REGISTRATION_INVALID');
  known.set(key,{...x,name:cleanName(x.name,'珠宝商品')});
 }
 const db=new DatabaseSync(path.join(dir,'workflow.sqlite'));
 db.exec('PRAGMA busy_timeout=4000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
 db.exec(`
 CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,scope TEXT NOT NULL,k TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(scope,k));
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,k TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL,
 name TEXT NOT NULL, reused INTEGER NOT NULL,created TEXT NOT NULL, request TEXT NOT NULL,
 task TEXT, error TEXT, media TEXT, sha TEXT, UNIQUE(scope,k));`);
 const sql=(query)=>db.prepare(query),getJob=sql('SELECT * FROM jobs WHERE id=?'),oldJob=sql('SELECT * FROM jobs WHERE scope=? AND k=?');
 const getPlan=sql('SELECT * FROM plans WHERE scope=? AND id=?');
 const oldPlan=sql('SELECT * FROM plans WHERE scope=? AND k=?');
 const insPlan=sql('INSERT OR IGNORE INTO plans VALUES(?,?,?,?)');
 const insJob=sql('INSERT INTO jobs(id,scope,k,status,attempt,name,reused,created,request,sha) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const used=sql('SELECT COALESCE(SUM(attempt),0) AS n FROM jobs');
 const markTask=sql("UPDATE jobs SET status='processing',task=?,error=NULL WHERE id=? AND status='unknown'");
 const markError=sql('UPDATE jobs SET status=?,error=? WHERE id=? AND status<>\'ready\'');
 const markReady=sql("UPDATE jobs SET status='ready',media=?,sha=?,error=NULL WHERE id=? AND status='processing'");
 const scopeOf=ctx=>{const s=ctx?.scope;if(typeof s!=='string'||!s||s.length>160||s.includes('\0'))deny('VIDEO_SCOPE_REQUIRED');return s;};
 const reselect=(ctx,id,pin)=>{
  const matches=(Array.isArray(ctx.photos)?ctx.photos:[]).filter(x=>x?.photoId===id);
  if(matches.length!==1||!Object.hasOwn(images,matches[0].mimeType)||pin&&matches[0].sha256!==pin)deny('VIDEO_PHOTO_NOT_AUTHORIZED');
  const item=matches[0],bytes=readPinned(item.path,item.sha256,limits.photo,'VIDEO_PHOTO_NOT_AUTHORIZED',root);
  if(!b64Mime(bytes,item.mimeType))deny('VIDEO_PHOTO_NOT_AUTHORIZED');
  return {bytes,sha256:item.sha256,ext:images[item.mimeType]};
 };
 const readRef=ref=>{
  const bytes=readPinned(ref.path,ref.sha256,limits.reference,'VIDEO_REFERENCE_CHANGED');
  if(!mp4(bytes))deny('VIDEO_REFERENCE_CHANGED');return bytes;
 };
 const readKnown=x=>{
  const bytes=readPinned(x.path,x.sha256,limits.media,'VIDEO_KNOWN_WORK_CHANGED');
  if(!mp4(bytes))deny('VIDEO_KNOWN_WORK_CHANGED');
 };
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const warning='AI合成预览，非实拍；珠序、形态和镜头相符仍需人工核实。';
 const expose=j=>({id:j.id,status:j.status==='unknown'&&workers.has(j.id)?'processing':j.status,name:j.name,reused:!!j.reused,
  mediaUrl:j.status==='ready'?'/style-video/media/'+j.id:null,statusUrl:'/style-video/status/'+j.id,aiGenerated:true,warning,...(j.error?{code:j.error}:{})});
 function receipt(tool,result,status='completed'){return {tool,status,receiptId:'style-video-'+randomUUID(),result,sideEffects:[]};}
 let stopped=false, preflight;
 const workers=new Map(),timers=new Map();
 const toolbox=()=>['--ffmpeg',ffmpeg,'--ffprobe',ffprobe,'--font',font];
 async function readyTools(){
  if([ffmpeg,ffprobe,python,font].some(v=>typeof v!=='string'||!v))deny('VIDEO_MEDIA_TOOLS_NOT_CONFIGURED');
  try{
   preflight??=exec(python,['-B',finish,'--check-deps',...toolbox()],{timeout:30000,windowsHide:true,env:mediaEnv});
   await preflight;
  }catch{preflight=null;deny('VIDEO_MEDIA_TOOLS_UNAVAILABLE');}
 }
 function schedule(id,ms=1100){
  if(stopped||workers.has(id)||timers.has(id)||!provider)return;
  const timer=setTimeout(()=>{timers.delete(id);track(id,()=>poll(id));},ms);
  timer.unref();timers.set(id,timer);
 }
 function track(id,work){
  if(stopped||workers.has(id))return;
  const running=Promise.resolve().then(work).catch(()=>{}).finally(()=>{
   workers.delete(id);
   if(!stopped&&getJob.get(id)?.status==='processing')schedule(id);
  });
  workers.set(id,running);
 }
 function privateJob(id){return path.join(dir,'works',id);}
 async function start(id,plan,photo,ref,refBytes){
  const target=privateJob(id);
  try{
   fs.mkdirSync(target,{recursive:true,mode:0o700});
   const picture=path.join(target,'photo'+photo.ext),reference=path.join(target,'reference.mp4');
   fs.writeFileSync(picture,photo.bytes,{flag:'wx',mode:0o600});
   fs.writeFileSync(reference,refBytes,{flag:'wx',mode:0o600});
   fs.writeFileSync(path.join(target,'spec.json'),JSON.stringify({name:plan.name,durationSeconds:ref.durationSeconds,titleBox:ref.titleBox,titleProfile:ref.titleProfile}),{flag:'wx',mode:0o600});
   const out=await provider.submit({photoId:plan.photoId,productPath:picture,productSha256:plan.photoSha256,
    referencePath:reference,referenceSha256:plan.referenceSha256,prompt,requestKey:id});
   if(!ID.test(out?.taskId||''))return markError.run('unknown','VIDEO_SUBMISSION_OUTCOME_UNKNOWN',id);
   markTask.run(out.taskId,id);
  }catch(e){markError.run(e?.definitive===true?'failed':'unknown',e?.definitive===true?'VIDEO_SUBMISSION_REJECTED':'VIDEO_SUBMISSION_OUTCOME_UNKNOWN',id);}
 }
 async function poll(id){
  const row=getJob.get(id);if(!row||row.status!=='processing'||!row.task)return;
  let s;
  try{s=await provider.get(row.task);}catch{return;}
  if(['failed','cancelled','canceled','expired'].includes(s?.status)){markError.run('failed','VIDEO_PROVIDER_FAILED',id);return;}
  if(!['succeeded','ready','completed'].includes(s?.status))return;
  const target=privateJob(id),raw=path.join(target,'raw.mp4'),ref=path.join(target,'reference.mp4');
  try{
   if(!fs.existsSync(raw)){
    const part=path.join(target,'download-'+randomUUID()+'.mp4');
    await provider.download(row.task,part);
    const stat=fs.statSync(part);if(stat.size<13||stat.size>limits.media||!mp4(fs.readFileSync(part)))deny('VIDEO_PROVIDER_FILE_INVALID');
    if(!fs.existsSync(raw))fs.renameSync(part,raw);
   }
  }catch{return;} // Read/download may retry; it never calls submit.
  const output='final-'+randomUUID()+'.mp4';
  try{
   await readyTools();
   const {stdout}=await exec(python,['-B',finish,...toolbox(),'--raw',raw,'--reference',ref,'--output',path.join(target,output),'--spec',path.join(target,'spec.json')],{timeout:420000,windowsHide:true,maxBuffer:1<<20,env:mediaEnv});
   const result=JSON.parse(stdout);if(!result.requiresManualReview||!Object.values(result.compatibility||{}).every(Boolean))deny('VIDEO_OUTPUT_INVALID');
   const bytes=fs.readFileSync(path.join(target,output));if(bytes.length>limits.media||!mp4(bytes))deny('VIDEO_OUTPUT_INVALID');
   markReady.run(output,hash(bytes),id);
  }catch{markError.run('failed','VIDEO_POSTPROCESS_FAILED',id);}
 }
 async function execute(name,args,context={}){
  try{
   if(stopped)deny('VIDEO_WORKFLOW_CLOSED');
   const scope=scopeOf(context);
   if(!Object.hasOwn(fields,name)||!args||typeof args!=='object'||Array.isArray(args)||
     Object.keys(args).length!==fields[name].length||!fields[name].every(k=>Object.hasOwn(args,k)&&typeof args[k]==='string'))deny('VIDEO_TOOL_ARGUMENTS');
   if(name===searchName){
    const q=text(args.query,190).normalize('NFKC').toLowerCase(), generic=/^(?:参考片|参考视频|视频|旧片|完整参考|珠宝|手串|短片|旧素材|参考|素材)$/u;
    return receipt(name,{source:'registered_reference_metadata_only',visualAnalyzed:false,
     references:[...references.values()].filter(r=>{
      const tokens=[r.referenceId,r.name,...(r.tags||[]),r.description].map(x=>text(x).normalize('NFKC').toLowerCase()).filter(Boolean);
      return q&&(generic.test(q)||tokens.some(t=>t.includes(q)||q.includes(t)));
     }).slice(0,8).map(r=>({referenceId:r.referenceId,name:r.name,tags:(r.tags||[]).map(t=>text(t,40)),durationSeconds:r.durationSeconds,editMode:'full_reference'}))});
   }
   if(name===statusName){
    const job=UUID.test(args.jobId)?getJob.get(args.jobId):null;
    if(!job||job.scope!==scope)deny('VIDEO_JOB_NOT_FOUND');
    if(job.status==='processing')schedule(job.id,20);
    return receipt(name,{job:expose(job),requiresManualReview:true,willGenerate:false});
   }
   if(name===planName){
    const ref=references.get(args.referenceId);if(!ref)deny('VIDEO_REFERENCE_NOT_FOUND');
    const photo=reselect(context,args.photoId);readRef(ref);
    const key=keyOf(photo.sha256,ref.sha256),cached=known.get(key);
    const name=cleanName(context.productName,/手串/u.test(context.userText||'')?'手串':'珠宝商品');
    const same=oldPlan.get(scope,key);
    const plan={photoId:args.photoId,referenceId:ref.referenceId,photoSha256:photo.sha256,referenceSha256:ref.sha256,name:cached?.name||name,ruleVersion:RULE};
    // A photo alias is an authorized reference, not a second work or plan.
    const id=same?.id||randomUUID();
    insPlan.run(id,scope,key,JSON.stringify(plan));
    const saved=oldPlan.get(scope,key);
    return receipt(planName,{plan:{id:saved.id,planId:saved.id,photoId:args.photoId,referenceId:ref.referenceId,name:JSON.parse(saved.body).name,ruleVersion:RULE,
     durationSeconds:ref.durationSeconds,audio:'original_reference_bgm',narration:false,internalSku:false,reusable:!!cached,willGenerate:false},willGenerate:false});
   }
   const p=UUID.test(args.planId)?getPlan.get(scope,args.planId):null;if(!p)deny('VIDEO_PLAN_NOT_FOUND');
   const plan=JSON.parse(p.body),ref=references.get(plan.referenceId);
   if(!ref||ref.sha256!==plan.referenceSha256)deny('VIDEO_REFERENCE_CHANGED');
   const owned=(context.photos||[]).find(x=>x?.sha256===plan.photoSha256&&x.photoId===plan.photoId)||
      (context.photos||[]).find(x=>x?.sha256===plan.photoSha256);
   if(!owned)deny('VIDEO_PHOTO_NOT_AUTHORIZED');
   const photo=reselect(context,owned.photoId,plan.photoSha256),refBytes=readRef(ref);
   const previous=oldJob.get(scope,p.k);
   if(previous)return receipt(makeName,{job:expose(previous),duplicate:true,willGenerate:false,requiresManualReview:true});
   const hit=known.get(p.k);
   if(hit){readKnown(hit);const job=tx(()=>{
    const repeat=oldJob.get(scope,p.k);if(repeat)return repeat;
    const id=randomUUID();insJob.run(id,scope,p.k,'ready',0,hit.name,1,stamp(),text(context.requestId,160),hit.sha256);return getJob.get(id);
   });return receipt(makeName,{job:expose(job),reused:true,willGenerate:false,requiresManualReview:true});}
   if(allowGenerate!==true||maxNewGenerations<1||!provider||['submit','get','download'].some(k=>typeof provider[k]!=='function'))deny('VIDEO_GENERATION_DISABLED');
   if(!explicitMake(context.userText))deny('VIDEO_EXPLICIT_GENERATION_INTENT_REQUIRED');
   if(!approvedTitle(ref))deny('VIDEO_REFERENCE_TITLE_RECIPE_REQUIRED');
   if(used.get().n>=maxNewGenerations)deny('VIDEO_GENERATION_BUDGET_EXHAUSTED');
   await readyTools();
   if(stopped)deny('VIDEO_WORKFLOW_CLOSED');
   const claim=tx(()=>{
    const previous=oldJob.get(scope,p.k);if(previous)return {job:previous,claimed:false};
    if(used.get().n>=maxNewGenerations)deny('VIDEO_GENERATION_BUDGET_EXHAUSTED');
    const id=randomUUID();insJob.run(id,scope,p.k,'unknown',1,plan.name,0,stamp(),text(context.requestId,160),null);
    return {job:getJob.get(id),claimed:true};
   });
   if(claim.claimed)track(claim.job.id,()=>start(claim.job.id,{...plan,photoId:owned.photoId},photo,ref,refBytes));
   return receipt(makeName,{job:expose(claim.job),duplicate:!claim.claimed,willGenerate:claim.claimed,requiresManualReview:true});
  }catch(e){const code=typeof e?.code==='string'&&/^VIDEO_[A-Z_]+$/.test(e.code)?e.code:'VIDEO_WORKFLOW_ERROR';
    return receipt(typeof name==='string'&&Object.hasOwn(fields,name)?name:'content_video', {code,willGenerate:false},'failed');}
 }
 function reply(req,res,code,value){
  const bytes=Buffer.from(JSON.stringify(value));
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Length':bytes.length});
  res.end(req.method==='HEAD'?undefined:bytes);return true;
 }
 const verified=new Map();
 function openMedia(item){
  const real=fs.realpathSync(item.path),fd=fs.openSync(real,'r');
  try{
   const stat=fs.fstatSync(fd);
   if(!stat.isFile()||stat.size<13||stat.size>limits.media||!SH.test(item.sha256||''))deny('VIDEO_MEDIA_CHANGED');
   const id=[item.sha256,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
   if(verified.get(real)!==id){
    const buf=Buffer.allocUnsafe(256*1024),digest=createHash('sha256');
    let count=0;
    while(count<stat.size){
     const n=fs.readSync(fd,buf,0,Math.min(buf.length,stat.size-count),count);
     if(!n||(!count&&!mp4(buf.subarray(0,n))))deny('VIDEO_MEDIA_CHANGED');
     digest.update(buf.subarray(0,n));count+=n;
    }
    const after=fs.fstatSync(fd);
    if(after.size!==stat.size||after.ctimeMs!==stat.ctimeMs||after.mtimeMs!==stat.mtimeMs||digest.digest('hex')!==item.sha256)
     deny('VIDEO_MEDIA_CHANGED');
    verified.set(real,id);if(verified.size>64)verified.delete(verified.keys().next().value);
   }
   return {fd,size:stat.size};
  }catch(e){fs.closeSync(fd);throw e;}
 }

 async function handleHttp(req,res,url,context={}){
  const match=/^\/style-video\/(status|media)\/([^/]+)$/.exec(url.pathname);
  if(!match)return false;
  if(!['GET','HEAD'].includes(req.method))return reply(req,res,405,{code:'VIDEO_READ_ONLY'});
  const notFound=()=>reply(req,res,404,{code:'VIDEO_NOT_FOUND'});
  const [,kind,id]=match;if(stopped||!UUID.test(id))return notFound();
  const job=getJob.get(id);
  if(!job)return notFound();
  if(kind==='status'){
   if(typeof context.scope!=='string'||job.scope!==context.scope)return notFound();
   if(job.status==='processing')schedule(job.id,20);
   return reply(req,res,200,{job:expose(job)});
  }
  if(job.status!=='ready')return notFound();
  const item=job.reused?known.get(job.k):{path:path.join(privateJob(id),job.media||''),sha256:job.sha};
  let size,fd;
  try{
   if(!item||item.sha256!==job.sha||!job.reused&&!/^final-[a-f0-9-]{36}\.mp4$/.test(job.media||''))return notFound();
   ({fd,size}=openMedia(item));
  }catch{return notFound();}
  let start=0,end=size-1,status=200;
  if(req.headers.range){
   const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
   if(m&&(m[1]||m[2])){
    if(!m[1])start=Math.max(0,size-Number(m[2]));
    else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
   }else start=size;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start> end||start>=size){
    fs.closeSync(fd);res.writeHead(416,{'Content-Range':'bytes */'+size,'Accept-Ranges':'bytes','Cache-Control':'no-store'});res.end();return true;
   }
   status=206;
  }
  res.writeHead(status,{'Content-Type':'video/mp4','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer',
   'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Length':end-start+1,...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
  if(req.method==='HEAD'){fs.closeSync(fd);res.end();return true;}
  const body=fs.createReadStream(null,{fd,start,end,autoClose:true});
  body.on('error',()=>res.destroy());res.on('close',()=>body.destroy());
  body.pipe(res);return true;
 }
 for(const job of sql("SELECT id FROM jobs WHERE status='processing'").all())schedule(job.id,30);
 let closing;
 function close(){return closing??=(async()=>{stopped=true;for(const t of timers.values())clearTimeout(t);timers.clear();await Promise.allSettled([...workers.values()]);db.close();})();}
 return {definitions,execute,handleHttp,close};
}
