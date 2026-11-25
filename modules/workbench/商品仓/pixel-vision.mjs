import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('./pixel-rule.py',import.meta.url));
const kinds=new Set(['image/jpeg','image/png','image/webp']);
const statuses=new Set(['heuristic_strong','insufficient']);
const version={ruleId:'n22-closed-loop',ruleVersion:'1.0.0'};
const response=(x)=>x&&x.ruleId===version.ruleId&&x.ruleVersion===version.ruleVersion
  && typeof x.runtime==='string'&&/^OpenCV-[\w.+-]{1,32}$/u.test(x.runtime);
const tooLarge=8*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function call(exe,args,input){
  return new Promise((ok,no)=>{
    const env={PATH:process.env.PATH??'',...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),
      ...(process.env.WINDIR?{WINDIR:process.env.WINDIR}:{}),OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'};
    const cp=execFile(exe,['-I','-B',script,...args],{timeout:9500,windowsHide:true,maxBuffer:16000,env},
      (e,out)=>{if(e)return no(Error('PIXEL_WORKER_OFFLINE'));try{ok(JSON.parse(out));}catch{no(Error('PIXEL_WORKER_PROTOCOL'));}});
    cp.stdin.on('error',()=>{});
    cp.stdin.end(input);
  });
}
export async function createLocalPixelVision({readAuthorizedAsset,python=process.platform==='win32'?'python':'python3'}={}){
  let runtime=null,active=0;
  if(typeof readAuthorizedAsset==='function'){
    try{const probed=await call(python,['--check']);if(response(probed))runtime=probed.runtime;}catch{}
  }
  return Object.freeze({
    status:Object.freeze({mounted:!!runtime,source:'pixel_rule',...version,runtime}),
    async readVision(ctx,x){
      if(!runtime||!ctx?.shopId||!x?.batchId||!x?.assetId||!/^[a-f0-9]{64}$/u.test(x.sha256??''))return null;
      const original=await readAuthorizedAsset(ctx,x.batchId,x.assetId);
      if(!original||!Buffer.isBuffer(original.bytes)&&!(original.bytes instanceof Uint8Array)||!kinds.has(original.mime)||
        !original.bytes.length||original.bytes.length>tooLarge||digest(original.bytes)!==x.sha256)return null;
      const bound={...x,shopId:ctx.shopId,evidenceRef:version.ruleId+':'+version.ruleVersion,analysisKind:'pixel_rule'};
      const abstain=reason=>({...bound,...version,runtime,decoded:false,category:null,confidence:'insufficient',reason,features:{}});
      if(active>=2)return abstain('PIXEL_BUSY');
      active++;
      try{
        const value=await call(python,[],Buffer.from(original.bytes));
        if(!response(value)||typeof value.decoded!=='boolean'||!statuses.has(value.confidence)||
          ![null,'bracelet','bangle'].includes(value.category)||typeof value.reason!=='string'||!/^PIXEL_[A-Z_]+$/u.test(value.reason))return abstain('PIXEL_WORKER_PROTOCOL');
        return {...bound,...value};
      }catch{return abstain('PIXEL_WORKER_OFFLINE');}
      finally{active--;}
    }
  });
}
