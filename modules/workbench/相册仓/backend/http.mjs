import {createAlbum} from './album/index.mjs';
import {createOriginalLabelSource} from './original-label.mjs';

export const BATCH_ROOT='/api/n22/album/batches';
export const LIMITS=Object.freeze({files:12,perFileBytes:8*1024*1024,batchBytes:36*1024*1024});
const MAX_JSON=Math.ceil(LIMITS.batchBytes/3)*4+1024;
const key=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(x);
const scoped=x=>typeof x==='string'&&x.trim().length>0&&x.length<=512;
const context=x=>scoped(x?.shopId)&&scoped(x?.actorId);
const bad=(status,code)=>Object.assign(new Error(code),{httpStatus:status,code});
const ensure=(yes,status,code)=>{if(!yes)throw bad(status,code);};
export function assetPath(batch,asset){
  ensure(key(batch)&&key(asset),400,'invalid_asset_reference');
  return BATCH_ROOT+'/'+batch+'/assets/'+asset;
}
function shape(task){
  const a=task.analysis;
  const items=task.items.map(row=>{
    const {itemId,ordinal,status,sha256,assetId,duplicateOf,reason,source}=row;
    return {itemId,ordinal,status,source, ...(sha256?{sha256}:{}),
      ...(assetId?{assetId,thumbnailRef:assetPath(task.taskId,assetId),categoryStatus:'pending_confirmation'}:{}),
      ...(duplicateOf?{duplicateOf,duplicateReason:'exact_sha256_match',thumbnailRef:assetPath(task.taskId,duplicateOf)}:{}),
      ...(reason?{reason}:{})};
  });
  const counts={selected:items.length,kept:0,duplicate:0,failed:0};
  for(const row of items)counts[row.status]++;
  return {requestId:a.requestId,messageId:a.messageId,batchId:task.taskId,mode:'organize_only',
    status:task.status,counts,items,pendingAssetIds:task.pendingAssetIds,receipts:[]};
}
async function jsonBody(req) {
  ensure((req.headers['content-type']||'').split(';')[0].trim()==='application/json',415,'json_required');
  ensure(!(Number(req.headers['content-length'])>MAX_JSON),413,'batch_too_large');
  let sum=0;const chunks=[];
  for await(const x of req){sum+=x.length;ensure(sum<=MAX_JSON,413,'batch_too_large');chunks.push(x);}
  let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw bad(400,'invalid_json');}
  ensure(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).length===3&&
    Object.keys(b).every(k=>k==='requestId'||k==='messageId'||k==='files')&&key(b.requestId)&&key(b.messageId),400,'invalid_organize_request');
  ensure(Array.isArray(b.files)&&b.files.length>=1&&b.files.length<=LIMITS.files,400,'invalid_file_count');
  let bytes=0;
  const files=b.files.map(s=>{
    ensure(typeof s==='string'&&s.length>0&&s.length<=Math.ceil(LIMITS.perFileBytes/3)*4&&
        s.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(s),400,'invalid_file_encoding');
    const body=Buffer.from(s,'base64');
    ensure(body.length>=1&&body.length<=LIMITS.perFileBytes,413,'file_too_large');
    ensure(body.toString('base64')===s,400,'invalid_file_encoding');
    bytes+=body.length; ensure(bytes<=LIMITS.batchBytes,413,'batch_too_large');
    return {bytes:body};
  });
  return {requestId:b.requestId,messageId:b.messageId,files};
}
export function createAlbumRoute({db,dataDir,originalLabelSource}) {
  // Deliberately no catalog, no model and no outbox delivery function in the public surface.
  const album=createAlbum({db,dataDir});
  function stored(ctx,batchId) {
    if(!context(ctx)||!key(batchId))return null;
    const task=album.getTask(ctx,batchId);
    return task?.kind==='import'&&task.analysis?.mode==='organize_only'?shape(task):null;
  }
  function readAuthorizedBatch(ctx,batchId){
    const b=stored(ctx,batchId);if(!b)return null;
    // For P2 only: duplicate/failed rows need distinct opaque keys; these are not saved photo IDs.
    return {shopId:ctx.shopId,batchId,messageId:b.messageId,requestId:b.requestId,assets:b.items.map(row=>({...row,assetId:row.assetId??row.itemId,
       status:row.status==='failed'?'unreadable':row.status}))};
  }
  function readAuthorizedAsset(ctx,batchId,assetId){
    if(!key(assetId))return null;
    const b=stored(ctx,batchId);
    if(!b?.items.some(x=>x.assetId===assetId||x.duplicateOf===assetId))return null;
    return album.readAsset(ctx,assetId);
  }
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
     'Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
  function respond(res,status,value,requestId){
    res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',
      ...(requestId?{'X-N22-Request-Id':requestId}:{})});res.end(JSON.stringify(value));
  }
  async function route({req,res,pathname,ctx,origin}) {
    if(pathname!==BATCH_ROOT&&!pathname.startsWith(BATCH_ROOT+'/'))return false;
    try{
      ensure(context(ctx),401,'session_required');
      const parts=pathname===BATCH_ROOT?[]:pathname.slice(BATCH_ROOT.length+1).split('/');
      if(req.method==='POST'&&!parts.length){
        // Outer listener still applies its existing Host allow-list and authenticated shop.
        const requestOrigin=origin??('http://'+req.headers.host);
        ensure(req.headers.origin===requestOrigin&&(!req.headers['sec-fetch-site']||
          ['same-origin','none'].includes(req.headers['sec-fetch-site'])),403,'origin_denied');
        const x=await jsonBody(req);
        const result=shape(await album.organizeBatch(ctx,x));
        respond(res,200,result,result.requestId);return true;
      }
      if(req.method==='GET'&&parts.length===1){
        const result=stored(ctx,parts[0]);ensure(result,404,'batch_not_found');
        respond(res,200,result,result.requestId);return true;
      }
      if(req.method==='GET'&&parts.length===3&&parts[1]==='assets'){
        const file=readAuthorizedAsset(ctx,parts[0],parts[2]); ensure(file,404,'asset_not_in_batch');
        res.writeHead(200,{...headers,'Content-Type':file.mime,'Content-Length':file.bytes.length});res.end(file.bytes);return true;
      }
      throw bad(404,'album_route_not_found');
    }catch(e){
      if(!res.headersSent)respond(res,e.httpStatus??500,{error:{code:e.code??'album_error'}});
      else res.end();
      return true;
    }
  }
  const labels=createOriginalLabelSource({dataDir,config:originalLabelSource,readAuthorizedBatch,readAuthorizedAsset});
  return Object.freeze({route,readAuthorizedBatch,readAuthorizedAsset,readLabel:labels.readLabel,
    guardOriginalLabelFallback:labels.guardOriginalLabelFallback,originalLabelSourceStatus:labels.status});
}
