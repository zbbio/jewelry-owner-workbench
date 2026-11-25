import {createC1} from './c1-old-video.mjs';

export const originalPlaybackVersion='n99.c2.v1';
const stem='/api/n22/content/original-message-video';
const token='[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,127}';
const p=new RegExp('^'+stem+'/('+token+')/('+token+')(/play)?$','u');
const id=x=>typeof x==='string'&&new RegExp('^'+token+'$','u').test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0&&x<=999999999;
const work=x=>id(x?.workId)&&!x.workId.includes(':')&&!x.workId.includes('..')&&ver(x.workVersion);
const same=(a,b,k)=>!!a&&!!b&&k.every(x=>a[x]===b[x]);
const ids=['conversationId','messageId','runId','requestId'];
const fail=(code,httpStatus)=>Object.assign(Error(code),{code,httpStatus});
const headers={'Cache-Control':'private, no-store','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff'};
const validOwner=c=>c?.role==='owner'&&['shopId','actorId','sessionId'].every(k=>id(c[k]));
function json(req,res,status,x){
 const b=Buffer.from(JSON.stringify(x));
 res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8','Content-Length':b.length});
 res.end(req.method==='HEAD'?undefined:b);
}
function sameOrigin(req){
 const s=req.headers['sec-fetch-site'],o=req.headers.origin;
 if(s!==undefined&&s!=='same-origin'&&s!=='none')return false;
 if(o===undefined)return true;
 try{const u=new URL(o);return ['http:','https:'].includes(u.protocol)&&u.origin===o&&u.host===req.headers.host;}
 catch{return false;}
}
function expectQuery(url,keys){
 if([...url.searchParams].length!==keys.length||keys.some(k=>url.searchParams.getAll(k).length!==1))throw fail('INVALID_QUERY',400);
 return Object.fromEntries(keys.map(k=>[k,url.searchParams.get(k)]));
}
// readOriginal is the authenticated product conversation port, not a legacy
// session alias or a browser/model supplied receipt. No write ports are accepted.
export function createC2OriginalPlayback({studio,readOriginal,isLiveOwner,deadlineMs=4200}={}){
 if(typeof studio?.listWorks!=='function'||typeof studio?.openOldVideo!=='function'||
    typeof readOriginal!=='function'||typeof isLiveOwner!=='function'||!ver(deadlineMs)||deadlineMs>30000)
   throw TypeError('C2 requires original history, active owner and adopted media read ports');
 const live=c=>{
   if(!validOwner(c)||isLiveOwner(c)!==true)throw fail('SESSION_REQUIRED',401);
 };
 async function evidence(c,ref){
  live(c);
  const row=await readOriginal(c,{conversationId:ref.conversationId,messageId:ref.messageId});
  live(c);
  if(!same(row,ref,ids.slice(0,3))||!id(row.requestId)||!['completed','partial_success'].includes(row.status)||!Array.isArray(row.toolReceipts))
    throw fail('ORIGINAL_MESSAGE_NOT_AVAILABLE',404);
  const clips=row.toolReceipts.filter(r=>r?.toolName==='content_find_existing');
  if(clips.length!==1)throw fail('ORIGINAL_VIDEO_NOT_AVAILABLE',404);
  const result=clips[0], x=result.result;
  if(!same(result,row,ids)||result.toolVersion!=='n99.c1.v1'||!id(result.callId)||!id(result.receiptId)||
     (result.shopId!=null&&result.shopId!==c.shopId)||(x?.shopId!=null&&x.shopId!==c.shopId)||
     !id(x?.productId)||!ver(x.productVersion)||x.deliveryStatus!=='not_submitted')
    throw fail('ORIGINAL_VIDEO_NOT_AVAILABLE',404);
  if(x.outcome==='no_verified_old_clip'&&x.workRef==null)
    return {ref:{...ref,requestId:row.requestId},pin:x,empty:true};
  if(x.outcome!=='existing_available'||x.retrievalStatus!=='playable'||!work(x.workRef))
    throw fail('ORIGINAL_VIDEO_NOT_AVAILABLE',404);
  return {ref:{...ref,requestId:row.requestId},pin:{productId:x.productId,productVersion:x.productVersion,
    workRef:{workId:x.workRef.workId,workVersion:x.workRef.workVersion}}};
 }
 async function route(req,res,context){
  if(typeof req.url!=='string'||!req.url.startsWith(stem+'/'))return false;
  const c=context&&Object.freeze({shopId:context.shopId,actorId:context.actorId,sessionId:context.sessionId,role:context.role});
  try{
   live(c);
   if(!sameOrigin(req))throw fail('ORIGIN_DENIED',403);
   const u=new URL(req.url,'http://127.0.0.1'),m=p.exec(u.pathname);
   if(!m||req.url.split('?')[0]!==u.pathname||u.hash)throw fail('NOT_FOUND',404);
   const play=Boolean(m[3]);
   if(req.method!=='GET'&&!(play&&req.method==='HEAD'))throw fail('METHOD_NOT_ALLOWED',405);
   const params=expectQuery(u,play?['runId','productId','productVersion','workId','workVersion']:['runId']);
   if(!id(params.runId))throw fail('INVALID_QUERY',400);
   const {ref,pin,empty}=await evidence(c,{conversationId:m[1],messageId:m[2],runId:params.runId});
   const base={...ref,productId:pin.productId,productVersion:pin.productVersion,deliveryStatus:'not_submitted'};
   if(empty){
    if(play)throw fail('ORIGINAL_VIDEO_NOT_AVAILABLE',404);
    json(req,res,200,{...base,outcome:'no_verified_old_clip'});return true;
   }
   const w=pin.workRef;
   if(play&&(params.productId!==pin.productId||params.productVersion!==String(pin.productVersion)||
       params.workId!==w.workId||params.workVersion!==String(w.workVersion)))throw fail('ORIGINAL_VIDEO_VERSION_MISMATCH',404);
   const c1=createC1({deadlineMs,studio:{
     listWorks:(ctx,pid)=>studio.listWorks(ctx,pid),
     async openOldVideo(ctx,key){
      live(ctx);
      const value=await studio.openOldVideo(ctx,key);
      live(ctx);
      return value;
     }
    },authorizeMessage:(ctx,x)=>{
     live(ctx);
     return x.messageId===ref.messageId?{shopId:c.shopId,productId:pin.productId,productVersion:pin.productVersion,
       allowOldVideo:true,pinnedWorkRef:w}:null;
    }});
   const oldQs=new URLSearchParams({messageId:ref.messageId,productId:pin.productId,productVersion:String(pin.productVersion)});
   if(play){
    // Use the existing Range / HEAD / byte validation. Only adjust its internal URL.
    // A revoked session just before the old handler flushes cannot get bytes.
    const internal=Object.create(req);internal.url='/api/n22/content/works/'+w.workId+'/'+w.workVersion+'/play?'+oldQs;
    let revoked=false;
    const result={
     writeHead(status,fields){
      if((status===200||status===206)&&isLiveOwner(c)!==true){revoked=true;res.writeHead(401,headers);}
      else res.writeHead(status,fields);
     },
     end(body){res.end(revoked?undefined:body);}
    };
    await c1.route(internal,result,c);return true;
   }
   const r=await c1.lookup(c,{...base});
   live(c);
   if(r.outcome==='source_timeout'){json(req,res,504,{...base,outcome:'source_timeout'});return true;}
   if(r.outcome!=='existing_available'||!same(r.workRef,w,['workId','workVersion'])){
    json(req,res,200,{...base,outcome:'needs_review'});return true;
   }
   const q=new URLSearchParams({runId:ref.runId,productId:pin.productId,productVersion:String(pin.productVersion),
      workId:w.workId,workVersion:String(w.workVersion)});
   json(req,res,200,{...base,outcome:'existing_available',retrievalStatus:'playable',workRef:w,
     playPath:stem+'/'+ref.conversationId+'/'+ref.messageId+'/play?'+q});
  }catch(e){json(req,res,e.httpStatus??503,{error:{code:e.httpStatus?(e.code??'INVALID_REQUEST'):'ORIGINAL_VIDEO_SOURCE_UNAVAILABLE'}});}
  return true;
 }
 return Object.freeze({route});
}
