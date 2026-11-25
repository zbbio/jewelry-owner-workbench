import {createAlbumRoute} from './http.mjs';
import {createGroupDrafts} from './group-drafts.mjs';
const root='/api/n22/album/drafts';
const bad=(code,httpStatus=400)=>Object.assign(Error(code),{code,httpStatus});
async function read(req){
 if((req.headers['content-type']??'').split(';')[0].trim()!=='application/json')throw bad('JSON_REQUIRED',415);
 const chunks=[];let size=0;
 for await(const b of req){size+=b.length;if(size>24576)throw bad('BODY_LIMIT',413);chunks.push(b);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw bad('INVALID_JSON');}
}
/** Optional integration export. Caller owns auth+trusted confirmation; without approval the writer is gated. */
export function createN22AlbumWithDrafts(opts){
 const base=createAlbumRoute(opts), draft=createGroupDrafts(opts);
 const routes={prepare:draft.prepare,correct:draft.correct,preview:draft.previewDelivery,handoff:draft.handoff};
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
 function send(res,status,v){
  res.writeHead(status,{...headers,...(typeof v.requestId==='string'?{'X-N22-Request-Id':v.requestId}:{})});
  res.end(JSON.stringify(v));
 }
 async function route({req,res,pathname,ctx,origin}){
  if(!pathname.startsWith(root+'/'))return base.route({req,res,pathname,ctx,origin});
  try{
   const suffix=pathname.slice(root.length+1);
   if(req.method==='GET'){
    const d=draft.getDraft(ctx,suffix);
    if(!d)throw bad('DRAFT_NOT_IN_SCOPE',404);
    send(res,200,d);return true;
   }
   if(req.method!=='POST'||!Object.prototype.hasOwnProperty.call(routes,suffix))throw bad('NOT_FOUND',404);
   if(!origin||req.headers.origin!==origin||req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))
      throw bad('ORIGIN_DENIED',403);
   const result=await routes[suffix](ctx,await read(req));send(res,200,result);return true;
  }catch(e){if(!res.headersSent)send(res,e.httpStatus??500,{error:{code:e.code??'A34_UNAVAILABLE'}});else res.end();return true;}
 }
 function envelope(v){return {shopId:v.shopId,requestId:v.requestId,messageId:v.messageId,batchId:v.batchId,
   status:'draft_only',actions:[{action:'album_draft',status:v.status,result:v}]};}
 const organize=(s)=>{
   if(typeof s!=='string')return false;
   const text=s.normalize('NFKC').trim();
   return !/(?:按|依照|依)\s*(?:品类|类别|种类)|(?:不要|别|不用)\s*归组/u.test(text)&&
     /^(?:请\s*)?整理[。！!]*$|(?:同一件|同件|同一物件).{0,12}(?:整理|归组|分组)|(?:按原图|这批照片|本批照片|这些照片).{0,12}(?:归组|分组)/u.test(text)&&
     !/确认|发布|生成|制作/u.test(text);
 };
 // Genuine ordinary-turn action. The authenticated host owns message and batch
 // binding; this route cannot create a catalog write intent or call acceptGroup.
 async function draftTurn(ctx,x){
   if(!organize(x?.text))return null;
   const info={shopId:ctx.shopId,requestId:x.requestId,messageId:x.messageId};
   if(!x.batchId)return {...info,status:'needs_photos',actions:[]};
   const u=base.readAuthorizedBatch(ctx,x.batchId);
   if(!u||u.shopId!==ctx.shopId||(u.messageId!==x.messageId&&u.messageId!==x.replyToMessageId))
     throw bad('BATCH_REFERENCE_NOT_VERIFIED',403);
   return envelope(await draft.prepare(ctx,{requestId:x.requestId,messageId:x.messageId,batchId:u.batchId,replyToMessageId:u.messageId}));
 }
 function restoreDraft(ctx,messageId){
   const v=draft.readMessageDraft(ctx,messageId);
   return v?envelope(v):null;
 }
 return Object.freeze({...base,route,draft,draftTurn,restoreDraft});
}
