import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';

export const ORIGINAL_LABEL_SCHEMA='n22-original-label-index/v1';
export const ORIGINAL_LABEL_FILE='p2-original-label-index.v1.json';
const MAX_BYTES=1024*1024, MAX_ROWS=4096, MAX_ASSET=8*1024*1024;
const CATEGORIES=Object.freeze(['bracelet','bangle','pendant','necklace','hand_chain','ring','earring']);
const MIME=['image/jpeg','image/png','image/webp'];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const sha=b=>createHash('sha256').update(b).digest('hex');
const exact=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&
  keys.every(k=>Object.hasOwn(o,k));
const fail=code=>{throw Object.assign(Error(code),{labelCode:code});};
const identity=(s,includeDevice=true)=>[includeDevice?s.dev:'',s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
const secure=s=>s.isFile()&&s.nlink===1n&&s.size>0n&&s.size<=BigInt(MAX_BYTES)&&
  (process.platform==='win32'||(s.mode&0o077n)===0n);
const approvedFields=['sha256','status','objectRef','category','evidenceRef'];
const markerFields=['sha256','status'];

function load(dataDir,config) {
  if(!exact(config,['enabled','shopId','sourceVersion','approvalRef','indexSha256'])||config.enabled!==true||
     ![config.shopId,config.sourceVersion,config.approvalRef].every(id)||!digest(config.indexSha256)||
     typeof dataDir!=='string'||!isAbsolute(dataDir))fail('LABEL_PROFILE_INVALID');
  const file=join(realpathSync(dataDir),ORIGINAL_LABEL_FILE);
  const init=lstatSync(file,{bigint:true});
  if(!secure(init)||realpathSync(file)!==file)fail('LABEL_INDEX_FILE_UNSAFE');
  const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  let bytes;
  try{
    const before=fstatSync(fd,{bigint:true});
    // Windows NTFS reports dev=0 from lstat but the actual volume serial from
    // fstat. Match the file ID and other fields between those two APIs, then
    // compare the full same-API identities and the pinned bytes.
    const commonDevice=process.platform!=='win32';
    if(!secure(before)||identity(init,commonDevice)!==identity(before,commonDevice))fail('LABEL_INDEX_CHANGED');
    const buffer=Buffer.alloc(Number(init.size)+1);
    let n=0;
    while(n<buffer.length){
      const m=readSync(fd,buffer,n,buffer.length-n,null);
      if(!m)break;
      n+=m;
    }
    if(n!==Number(init.size)||identity(fstatSync(fd,{bigint:true}))!==identity(before))fail('LABEL_INDEX_CHANGED');
    bytes=buffer.subarray(0,n);
  }finally{closeSync(fd);}
  if(sha(bytes)!==config.indexSha256)fail('LABEL_INDEX_DIGEST_MISMATCH');
  let doc;
  try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('LABEL_INDEX_INVALID_JSON');}
  if(!exact(doc,['schema','shopId','sourceVersion','approvalRef','records'])||doc.schema!==ORIGINAL_LABEL_SCHEMA||
     doc.shopId!==config.shopId||doc.sourceVersion!==config.sourceVersion||doc.approvalRef!==config.approvalRef||
     !Array.isArray(doc.records)||doc.records.length===0||doc.records.length>MAX_ROWS)fail('LABEL_INDEX_SCOPE_OR_SHAPE');
  const byHash=new Map(), byRef=new Map(), blockers=new Map();
  for(const row of doc.records){
    if(!digest(row?.sha256))fail('LABEL_INDEX_ROW_INVALID');
    if(row.status==='unresolved'||row.status==='withdrawn'){
      if(!exact(row,markerFields))fail('LABEL_INDEX_ROW_INVALID');
      blockers.set(row.sha256,row.status==='withdrawn'?'ORIGINAL_LABEL_WITHDRAWN':'ORIGINAL_LABEL_CONFLICT');
      continue;
    }
    if(!exact(row,approvedFields)||row.status!=='approved'||!id(row.objectRef)||!id(row.evidenceRef)||
       !CATEGORIES.includes(row.category))fail('LABEL_INDEX_ROW_INVALID');
    // The internal object reference is for detecting ambiguity, not a product
    // selector or a result field. More than one conflicting source stays pending.
    const stable=[row.sha256,row.objectRef,row.category].join('\u0000');
    const previous=byRef.get(row.evidenceRef);
    if(previous&&previous!==stable){
      blockers.set(row.sha256,'ORIGINAL_LABEL_CONFLICT');
      blockers.set(previous.split('\u0000',1)[0],'ORIGINAL_LABEL_CONFLICT');
    }
    byRef.set(row.evidenceRef,stable);
    const saved=byHash.get(row.sha256);
    if(saved&&(saved.stable!==stable||saved.evidenceRef!==row.evidenceRef))
      blockers.set(row.sha256,'ORIGINAL_LABEL_CONFLICT');
    if(!saved)byHash.set(row.sha256,{stable,category:row.category,evidenceRef:row.evidenceRef});
  }
  const snapshot=identity(init);
  return {file,snapshot,shopId:config.shopId,sourceVersion:config.sourceVersion,byHash,blockers};
}

/**
 * Optional, server-only evidence for P2. No default lookup/import of any table.
 * Invoke through the trusted authenticated Album/P2 composition, not a network route.
 * Accepted original bytes are hashed again, never guessed from a name or similarity.
 */
export function createOriginalLabelSource({dataDir,config,readAuthorizedBatch,readAuthorizedAsset}={}){
  let snapshot, missing={state:'disabled',code:'LABEL_SOURCE_NOT_ENABLED'};
  if(config?.enabled===true){
    try{
      if(typeof readAuthorizedBatch!=='function'||typeof readAuthorizedAsset!=='function')fail('LABEL_ALBUM_PORTS_UNAVAILABLE');
      snapshot=load(dataDir,config);
    }catch(e){missing={state:'unavailable',code:e?.labelCode??'LABEL_INDEX_UNAVAILABLE'};}
  }
  let stale=false;
  function current(){
    if(!snapshot||stale)return false;
    try{
      const s=lstatSync(snapshot.file,{bigint:true});
      if(!secure(s)||identity(s)!==snapshot.snapshot)stale=true;
    }catch{stale=true;}
    return !stale;
  }
  function status(){
    if(!snapshot)return {...missing};
    return current()?{state:'ready',sourceVersion:snapshot.sourceVersion}:{state:'unavailable',code:'LABEL_INDEX_CHANGED'};
  }
  function locate(ctx,pin) {
    if(!snapshot||ctx?.shopId!==snapshot.shopId||!id(ctx.actorId)||!id(pin?.batchId)||!id(pin.assetId)||!digest(pin.sha256))return null;
    const hit=snapshot.byHash.get(pin.sha256), reason=snapshot.blockers.get(pin.sha256);
    return hit||reason?{hit,reason}:null;
  }
  function membership(ctx,pin) {
    const b=readAuthorizedBatch(ctx,pin.batchId);
    if(b?.shopId!==ctx.shopId||b.batchId!==pin.batchId||!Array.isArray(b.assets))return false;
    const m=b.assets.filter(a=>a.assetId===pin.assetId&&a.status==='kept');
    return m.length===1&&m[0].sha256===pin.sha256;
  }
  function readLabel(ctx,pin){
    const x=locate(ctx,pin);
    if(!x||!current())return null;
    try{
      if(!membership(ctx,pin))return null;
      const a=readAuthorizedAsset(ctx,pin.batchId,pin.assetId);
      if(!Buffer.isBuffer(a?.bytes)||a.bytes.length<1||a.bytes.length>MAX_ASSET||!MIME.includes(a.mime)||
         sha(a.bytes)!==pin.sha256||!current())return null;
      const link={shopId:ctx.shopId,batchId:pin.batchId,assetId:pin.assetId,sha256:pin.sha256,source:'original_label',
        sourceVersion:snapshot.sourceVersion};
      return x.reason?{...link,matched:false,blocked:true,reason:x.reason}:
        {...link,category:x.hit.category,evidenceRef:x.hit.evidenceRef,matched:true};
    }catch{return null;}
  }
  // Stock P2 ignores negative label envelopes. Use this in its readVision and
  // readHuman wiring whenever an index is enabled. It does not affect raw asset
  // access, preview, dedupe, or group routing. A real revision is required to
  // re-open a blocked original, not a fallback suggestion.
  function guardOriginalLabelFallback(next){
    if(typeof next!=='function')return undefined;
    return (ctx,pin)=>{
      const x=locate(ctx,pin);
      if(x&&(x.reason||!current())){
        try{
          if(membership(ctx,pin))return null;
        }catch{return null;}
      }
      return next(ctx,pin);
    };
  }
  return Object.freeze({readLabel,guardOriginalLabelFallback,status});
}
