// Complete reference edit adapter. The frozen video-provider.mjs owns Ark upload,
// hash readback, duration=-1 submit, GET and download. Keep the existing 4s path untouched.
import {join} from 'node:path';
import {createArkVideoProvider,VIDEO_MODEL} from './video-provider.mjs';
const FILES='https://ark.cn-beijing.volces.com/api/v3/files';
const pin=/^[a-f0-9]{64}$/;
const entity=/^[A-Za-z0-9_-]{1,100}$/;
const error=code=>Object.assign(Error(code),{code,definitive:true});
export function createReferenceVideoProvider({assetStateDir,enableRealSubmit=false,apiKey,fetchImpl=globalThis.fetch}={}){
 const fullTransport=(url,options={})=>{
  if(url===FILES&&options.method==='POST'){
   const form=options.body,file=form?.get?.('file');
   if(!(form instanceof FormData)||file?.type!=='video/mp4'||form.get('purpose')!=='agent')
    throw error('REFERENCE_FILES_REQUEST_INVALID');
   // Same preflight correction as the successful full-edit resume, before POST.
   form.set('expire_at',String(Math.floor(Date.now()/1000)+172800));
   form.set('file',file,'reference_full.mp4');
  }
  return fetchImpl(url,options);
 };
 const read=createArkVideoProvider({apiKey,fetchImpl:fullTransport});
 async function submit({photoId,productPath,productSha256,referencePath,referenceSha256,prompt,requestKey}={}){
  if(enableRealSubmit!==true)throw error('REFERENCE_VIDEO_POST_DISABLED');
  if(typeof assetStateDir!=='string'||!assetStateDir||!entity.test(photoId||'')||!pin.test(productSha256||'')||!pin.test(referenceSha256||''))
   throw error('REFERENCE_VIDEO_SUBMIT_CONFIGURATION');
  const upstream=createArkVideoProvider({apiKey,enableRealSubmit:true,fetchImpl:fullTransport,
    expectedReferenceSha256:referenceSha256,expectedProductSha256:{[photoId]:productSha256},
    assetStatePath:join(assetStateDir,referenceSha256+'.json')});
  return upstream.submit({productId:photoId,productPath,referencePath,prompt,requestKey});
 }
 return {capabilities:Object.freeze({model:VIDEO_MODEL,mode:'edit',durationMode:'full_reference'}),submit,get:read.get,download:read.download};
}
