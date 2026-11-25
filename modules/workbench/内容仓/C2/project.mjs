import {lstatSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,renameSync,rmdirSync,readdirSync,unlinkSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {byteHash as sha,readPlanPins,MIME_EXT,MAX_ASSET_BYTES} from '../content/c2-plan-prep.mjs';
import {validateCaptionPlan} from '../content/caption-policy.mjs';

const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/u.test(x);
const safe=x=>String(x).replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const esc=JSON.stringify;
export const sum=p=>p.shots.reduce((n,x)=>n+x.durationMs,0);
const fail=(code,assetId)=>{throw Object.assign(new Error(code),{code,...(assetId?{assetId}:{})});};
const bytesOf=x=>Buffer.from(esc(x,null,2)+'\n');
const assetName=p=>p.assetId+'.'+MIME_EXT[p.mime];
const stat=p=>{try{return lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
function dirAt(p,code){const s=stat(p);if(!s?.isDirectory()||s.isSymbolicLink())fail(code);}
function fileAt(p,{missing='C2_PROJECT_INCOMPLETE',bad='C2_PROJECT_INVALID',assetId,limit=MAX_ASSET_BYTES}={}){
 const s=stat(p);if(!s)fail(missing,assetId);
 if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>limit)fail(bad,assetId);
 try{return readFileSync(p);}catch(e){if(e.code==='ENOENT')fail(missing,assetId);throw e;}
}
function assertBytes(pin,bytes){
 if(bytes.length!==pin.size||sha(bytes)!==pin.sha256)fail('C2_ASSET_DIGEST_MISMATCH',pin.assetId);
}
function jsonAt(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{fail('C2_PROJECT_INVALID');}}

export function htmlOf(plan,pins){
 const total=sum(plan)/1000;let start=0;
 const clips=plan.shots.map((x,i)=>{
  if(!id(x.assetId)||!Number.isInteger(x.durationMs)||x.durationMs<1000||x.durationMs>7000)throw new TypeError('unsupported shot');
  const t=(start/1000).toFixed(3), duration=(x.durationMs/1000).toFixed(3);start+=x.durationMs;
  const time=' data-start="'+t+'" data-duration="'+duration+'"';
  return '<img class="clip" id="shot-'+(i+1)+'"'+time+' data-track-index="1" src="assets/'+(pins?assetName(pins[i]):x.assetId+'.png')+'" alt="">'+
    '<p class="clip" id="caption-'+(i+1)+'"'+time+' data-track-index="2">'+safe(x.caption)+'</p>';
 });
 return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><title>'+safe(plan.label)+'</title>'+
  '<style>html,body{margin:0;background:#16252b;color:white;font:20px sans-serif}.clip{position:absolute;text-align:center;box-sizing:border-box}img{left:0;top:0;width:360px;height:480px;object-fit:contain}p{left:12px;right:12px;top:495px;margin:0}</style>'+
  '</head><body><div id="main" data-composition-id="main" data-no-timeline data-width="360" data-height="640" data-start="0" data-duration="'+total.toFixed(3)+'">'+
  clips.join('\n')+'</div></body></html>\n';
}
function expected(state,plan){
 const pins=readPlanPins(state,plan);
 const legacy={schema:'n22.c2-edit-project/v1',draftSetId:state.draftSetId,draftSetVersion:state.version,sourceDigest:state.sourceDigest,
  productId:state.productId,productVersion:state.productVersion,plan};
 const current={...legacy,schema:'n22.c2-edit-project/v2',assetPinsDigest:state.assetPinsDigest,
  assets:pins.map(({assetId,sha256,size,mime})=>({assetId,sha256,size,mime}))};
 return {pins,legacy,current,html:htmlOf(plan,pins),legacyHtml:htmlOf(plan)};
}
function checkTree(folder,e,allowLegacy=false){
 dirAt(folder,'C2_PROJECT_INCOMPLETE');
 const planFile=fileAt(join(folder,'plan.json'),{limit:256*1024}), stored=jsonAt(planFile);
 const isLegacy=stored?.schema==='n22.c2-edit-project/v1';
 if(isLegacy&&!allowLegacy)fail('C2_LEGACY_REQUIRES_APPROVED_SOURCE');
 if(!isDeepStrictEqual(stored,isLegacy?e.legacy:e.current))fail('C2_PROJECT_VERSION_MISMATCH');
 const htmlFile=fileAt(join(folder,'index.html'),{limit:256*1024});
 if(htmlFile.toString('utf8')!==(isLegacy?e.legacyHtml:e.html))fail('C2_PROJECT_INVALID');
 if(!isLegacy){
   const marker=jsonAt(fileAt(join(folder,'COMMITTED.json'),{limit:4096}));
   if(!isDeepStrictEqual(marker,{schema:'n22.c2-commit/v1',planSha256:sha(planFile),htmlSha256:sha(htmlFile)}))
     fail('C2_PROJECT_INVALID');
 }
 const assets=join(folder,'assets');
 dirAt(assets,'C2_ASSET_MISSING');
 for(const pin of e.pins){
   const file=isLegacy?pin.assetId+'.png':assetName(pin);
   assertBytes(pin,fileAt(join(assets,file),{missing:'C2_ASSET_MISSING',bad:'C2_ASSET_INVALID',assetId:pin.assetId}));
 }
 return {...stored,assetIntegrity:'verified',adoptionInput:isLegacy?'legacy_revalidated':'committed',assetPinsDigest:e.current.assetPinsDigest,
  assets:e.current.assets};
}
export function saveProject(out,state,plan,materials,{checkpoint=()=>{}}={}){
 const e=expected(state,plan);
 validateCaptionPlan(plan,state.captionProfile);
 if(!Array.isArray(materials))fail('C2_ASSET_MISSING');
 // Material entries are transport only, never an authority for the digest.
 const snapshots=e.pins.map(pin=>{
   const candidates=materials.filter(m=>m?.assetId===pin.assetId);
   if(!candidates.length)fail('C2_ASSET_MISSING',pin.assetId);
   const [m]=candidates;
   if(candidates.length!==1||!Buffer.isBuffer(m.bytes)||m.bytes.length>MAX_ASSET_BYTES)fail('C2_ASSET_INVALID',pin.assetId);
   const bytes=Buffer.from(m.bytes);
   assertBytes(pin,bytes);
   return {pin,bytes};
 });
 const planFile=bytesOf(e.current),htmlFile=Buffer.from(e.html);
 const proof={planSha256:sha(planFile),htmlSha256:sha(htmlFile),durationMs:sum(plan),assetPinsDigest:state.assetPinsDigest};
 if(basename(out).startsWith('.c2-stage-'))fail('C2_PROJECT_PATH_INVALID');
 if(stat(out)){checkTree(out,e);return proof;}
 const parent=dirname(out);mkdirSync(parent,{recursive:true});
 const stage=mkdtempSync(join(parent,'.c2-stage-'));
 const assetDir=join(stage,'assets');
 let published=false;
 try{
   mkdirSync(assetDir);
   for(const {pin,bytes} of snapshots){
     writeFileSync(join(assetDir,assetName(pin)),bytes,{flag:'wx'});
     checkpoint('after_asset',pin.assetId);
   }
   writeFileSync(join(stage,'plan.json'),planFile,{flag:'wx'});
   writeFileSync(join(stage,'index.html'),htmlFile,{flag:'wx'});
   writeFileSync(join(stage,'COMMITTED.json'),bytesOf({schema:'n22.c2-commit/v1',planSha256:proof.planSha256,htmlSha256:proof.htmlSha256}),{flag:'wx'});
   checkpoint('before_publish');
   checkTree(stage,e);
   renameSync(stage,out);published=true;
   return proof;
 }catch(err){
   if(err.code?.startsWith('C2_'))throw err;
   throw Object.assign(new Error('C2_PROJECT_EXPORT_INTERRUPTED',{cause:err}),{code:'C2_PROJECT_EXPORT_INTERRUPTED'});
 }finally{
   if(!published){
     if(stat(assetDir)){for(const file of readdirSync(assetDir))unlinkSync(join(assetDir,file));rmdirSync(assetDir);}
     for(const file of readdirSync(stage))unlinkSync(join(stage,file));rmdirSync(stage);
   }
 }
}
export function reopenProject(dir,{state,plan,allowLegacy=false}={}){
 if(basename(dir).startsWith('.c2-stage-'))fail('C2_PROJECT_INCOMPLETE');
 return checkTree(dir,expected(state,plan),allowLegacy===true);
}
