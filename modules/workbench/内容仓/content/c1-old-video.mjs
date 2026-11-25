import {performance} from 'node:perf_hooks';

export class ContentReadError extends Error {
  constructor(code,httpStatus){super(code);this.code=code;this.httpStatus=httpStatus;}
}
const fail=(c,s)=>{throw new ContentReadError(c,s);};
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,159}$/u.test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0;
const parseVersion=x=>/^[1-9][0-9]{0,8}$/u.test(x??'')?Number(x):null;
const eq=(a,b)=>a?.workId===b?.workId&&a?.workVersion===b?.workVersion;
const headers={'Cache-Control':'private, no-store','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff'};

async function withDeadline(ms,fn){
  const t=performance.now(), ac=new AbortController();
  let timer;
  const error=new ContentReadError('OLD_VIDEO_TIMEOUT',504);
  try{
    const stop=new Promise((_,j)=>{timer=setTimeout(()=>{j(error);ac.abort();},ms);});
    return await Promise.race([stop,Promise.resolve().then(()=>fn(ac.signal)).then(v=>{
      if(performance.now()-t>=ms){ac.abort();throw error;}return v;
    },e=>{if(performance.now()-t>=ms){ac.abort();throw error;}throw e;})]);
  }finally{clearTimeout(timer);}
}
function validate(ctx,q,requestRequired){
  if(!id(ctx?.shopId)||!id(ctx?.actorId))fail('AUTH_REQUIRED',401);
  if(!id(q?.messageId)||!id(q?.productId)||!ver(q?.productVersion)||(requestRequired&&!id(q?.requestId)))fail('INVALID_INPUT',400);
}
function denyCrossOrigin(req){
  if(![undefined,'none','same-origin'].includes(req.headers['sec-fetch-site']))fail('ORIGIN_DENIED',403);
  const o=req.headers.origin;
  if(o!==undefined){
    let u;try{u=new URL(o);}catch{fail('ORIGIN_DENIED',403);}
    if(!['http:','https:'].includes(u.protocol)||u.origin!==o||u.host!==req.headers.host)fail('ORIGIN_DENIED',403);
  }
}
function chooseRange(raw,n){
  if(raw===undefined)return [200,0,n-1];
  if(typeof raw!=='string'||raw.length>64)return null;
  const m=/^bytes=(\d{0,16})-(\d{0,16})$/iu.exec(raw);
  if(!m||!m[1]&&!m[2])return null;
  const a=m[1]?Number(m[1]):null,z=m[2]?Number(m[2]):null;
  if(a!==null&&!Number.isSafeInteger(a)||z!==null&&!Number.isSafeInteger(z))return null;
  if(a===null)return z>0?[206,Math.max(0,n-z),n-1]:null;
  if(a>=n||z!==null&&z<a)return null;
  return [206,a,Math.min(z??n-1,n-1)];
}
const metaPath='/api/n22/content/old-video';
const playPrefix='/api/n22/content/works/';
const playShape=/^\/api\/n22\/content\/works\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,159})\/([1-9][0-9]{0,8})\/play$/u;
const workIdOK=x=>id(x)&&!x.includes(':')&&!x.includes('..');
function params(u,keys){
  if([...u.searchParams.keys()].some(k=>!keys.includes(k))||keys.some(k=>u.searchParams.getAll(k).length!==1))fail('INVALID_INPUT',400);
  return Object.fromEntries(u.searchParams);
}
function json(req,res,http,obj){
  const b=Buffer.from(JSON.stringify(obj));
  res.writeHead(http,{...headers,'Content-Type':'application/json; charset=utf-8','Content-Length':b.length});
  res.end(req.method==='HEAD'?undefined:b);
}

export function createC1({studio,authorizeMessage,deadlineMs=4200}={}){
  if(typeof studio?.listWorks!=='function'||typeof studio?.openOldVideo!=='function'||typeof authorizeMessage!=='function'||
    !Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>30000)throw new TypeError('studio reads, scoped message authorizer and deadline required');
  // Only the two narrow read symbols are captured. No fallback into requestVideo / paid price.
  const list=studio.listWorks.bind(studio),open=studio.openOldVideo.bind(studio);
  async function scope(ctx,q,signal){
    const p=await authorizeMessage(ctx,{messageId:q.messageId,signal});
    signal.throwIfAborted();
    if(!p||p.allowOldVideo!==true||p.shopId!==ctx.shopId||p.productId!==q.productId)fail('MESSAGE_PRODUCT_NOT_AVAILABLE',404);
    if(p.productVersion!==q.productVersion)fail('PRODUCT_VERSION_CONFLICT',409);
    if(p.pinnedWorkRef!==undefined&&(!id(p.pinnedWorkRef?.workId)||!ver(p.pinnedWorkRef?.workVersion)))fail('MESSAGE_BINDING_INVALID',503);
    return p;
  }
  async function verified(ctx,q,w,signal){
    signal.throwIfAborted();
    const m=await open(ctx,{productId:q.productId,productVersion:q.productVersion,workId:w.workId,workVersion:w.workVersion});
    signal.throwIfAborted();
    if(!m||m.productId!==q.productId||m.productVersion!==q.productVersion||!eq(m,w)||m.mime!=='video/mp4'||
      !Buffer.isBuffer(m.bytes)||m.bytes.length===0||!/^[a-f0-9]{64}$/u.test(m.sha256??'')||
      !Number.isFinite(m.durationSeconds)||m.durationSeconds<=0)fail('OLD_VIDEO_UNAVAILABLE',404);
    return m;
  }
  async function lookup(ctx,input){
    // Snapshot these scalar fields so a late async callback cannot retarget the operation.
    const q={requestId:input?.requestId,messageId:input?.messageId,productId:input?.productId,productVersion:input?.productVersion};
    validate(ctx,q,true);
    const c={shopId:ctx.shopId,actorId:ctx.actorId,...(ctx.role?{role:ctx.role}:{}),...(ctx.sessionId?{sessionId:ctx.sessionId}:{})};
    const base={...q,shopId:c.shopId,action:'content.find_old_video',source:'studio.approved_works',deliveryStatus:'not_submitted',writesPerformed:false};
    try{
      return await withDeadline(deadlineMs,async signal=>{
        const p=await scope(c,q,signal);
        const all=await list(c,q.productId);
        signal.throwIfAborted();
        if(!Array.isArray(all))fail('OLD_VIDEO_SOURCE_UNAVAILABLE',503);
        const approved=all.filter(w=>w?.productId===q.productId&&w.recordedStatus==='approved');
        if(!approved.length&&!p.pinnedWorkRef)return {...base,outcome:'no_verified_old_clip'};
        const candidates=approved.filter(w=>w.status==='approved'&&w.productVersion===q.productVersion&&workIdOK(w.workId)&&ver(w.workVersion)&&w.workVersion<=999999999&&
          (!p.pinnedWorkRef||eq(w,p.pinnedWorkRef)));
        if(candidates.length!==1)return {...base,outcome:'needs_review'};
        const w={workId:candidates[0].workId,workVersion:candidates[0].workVersion};
        let m;try{m=await verified(c,q,w,signal);}catch(e){
          if(['WORK_NOT_AVAILABLE','OLD_VIDEO_UNAVAILABLE'].includes(e.code))return {...base,outcome:'needs_review'};
          throw e;
        }
        const pinnedPlayUrl=playPrefix+w.workId+'/'+w.workVersion+'/play?'+new URLSearchParams({messageId:q.messageId,
          productId:q.productId,productVersion:String(q.productVersion)});
        return {...base,outcome:'existing_available',retrievalStatus:'playable',workRef:w,
          pinnedPlayUrl,mime:m.mime,fileBytes:m.bytes.length,durationSeconds:m.durationSeconds,sha256:m.sha256};
      });
    }catch(e){
      if(e.code==='OLD_VIDEO_TIMEOUT')return {...base,outcome:'source_timeout',retryable:true};
      if(e.code==='PRODUCT_NOT_FOUND')fail('MESSAGE_PRODUCT_NOT_AVAILABLE',404);
      throw e;
    }
  }
  async function route(req,res,ctx){
    const u=new URL(req.url,'http://127.0.0.1');
    const p=playShape.exec(u.pathname);
    if(u.pathname!==metaPath&&!u.pathname.startsWith(playPrefix))return false;
    try{
      if(!req.url.startsWith('/')||req.url.startsWith('//'))fail('INVALID_INPUT',400);
      denyCrossOrigin(req);
      if(u.pathname===metaPath){
        if(req.method!=='GET')fail('READ_ONLY_ROUTE',405);
        const q=params(u,['requestId','messageId','productId','productVersion']);
        q.productVersion=parseVersion(q.productVersion);
        const result=await lookup(ctx,q);
        json(req,res,result.outcome==='source_timeout'?504:200,result);
        return true;
      }
      if(!p||!workIdOK(p[1]))fail('INVALID_INPUT',400);
      if(!['GET','HEAD'].includes(req.method))fail('READ_ONLY_ROUTE',405);
      const q=params(u,['messageId','productId','productVersion']);
      q.productVersion=parseVersion(q.productVersion);q.workId=p[1];q.workVersion=parseVersion(p[2]);
      validate(ctx,q,false);
      if(!id(q.workId)||!q.workVersion)fail('INVALID_INPUT',400);
      const m=await withDeadline(deadlineMs,async signal=>{
        const p=await scope(ctx,q,signal);
        if(p.pinnedWorkRef&&!eq(p.pinnedWorkRef,q))fail('OLD_VIDEO_UNAVAILABLE',404);
        return verified(ctx,q,q,signal);
      });
      const n=m.bytes.length, range=chooseRange(req.headers.range,n);
      const h={...headers,'Content-Type':'video/mp4','Accept-Ranges':'bytes','Referrer-Policy':'no-referrer'};
      if(!range){res.writeHead(416,{...h,'Content-Range':'bytes */'+n,'Content-Length':0});res.end();return true;}
      const [status,start,end]=range;
      if(status===206)h['Content-Range']='bytes '+start+'-'+end+'/'+n;
      h['Content-Length']=end-start+1;
      res.writeHead(status,h);res.end(req.method==='HEAD'?undefined:m.bytes.subarray(start,end+1));
      return true;
    }catch(e){
      const code=e instanceof ContentReadError?e.code:
        ['WORK_NOT_AVAILABLE','PRODUCT_VERSION_CONFLICT'].includes(e.code)?e.code:'OLD_VIDEO_SOURCE_UNAVAILABLE';
      const http=e instanceof ContentReadError?e.httpStatus:code==='WORK_NOT_AVAILABLE'?404:code==='PRODUCT_VERSION_CONFLICT'?409:503;
      json(req,res,http,{error:{code}});return true;
    }
  }
  return Object.freeze({lookup,route});
}

// The product wire holds a single instance and mounts the same route after its
// authentication gate. Sales may name this function lookupOldVideo.
export function createN22ContentAdapter({studio,authorizeMessage,deadlineMs}={}){
  const c1=createC1({studio,authorizeMessage,deadlineMs});
  return Object.freeze({findExisting:c1.lookup,route:c1.route});
}
