import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveCaptionFont} from '../content/caption-policy.mjs';

const tool=(file,args)=>spawnSync(file,args,{encoding:'utf8',timeout:8000,maxBuffer:2*1024*1024,windowsHide:true,shell:false});
const probe=(file,args)=>{
 const z=tool(file,args);
 return {ok:!z.error&&z.status===0,exitCode:z.status,text:z.stdout??'',signal:z.signal??null};
};
const brief=(name,p)=>({ok:p.ok,exitCode:p.exitCode,banner:p.ok?p.text.split(/\r?\n/u)[0]:null,code:p.ok?null:name+'_UNAVAILABLE'});
export async function checkContentReadiness({enableProduction=false,engine='ffmpeg-static',fontProfile,probeExisting}={}){
 let sqlite=false;
 try{const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(':memory:');try{sqlite=db.prepare('SELECT 1 AS ok').get().ok===1;}finally{db.close();}}catch{}
 // Both are required by the existing read path, even when new production is disabled.
 const ff=brief('FFMPEG',probe('ffmpeg',['-hide_banner','-version']));
 const fp=brief('FFPROBE',probe('ffprobe',['-hide_banner','-version']));
 const old={ready:sqlite&&ff.ok&&fp.ok,nodeVersion:process.version,nodeSqlite:sqlite,ffmpeg:ff,ffprobe:fp,readProbe:'not_configured'};
 if(old.ready&&typeof probeExisting==='function'){
  try{old.readProbe=(await probeExisting())===true?'passed':'failed';}catch{old.readProbe='failed';}
  old.ready=old.readProbe==='passed';
 }
 const production={enabledByOperator:enableProduction===true,ready:false,state:'disabled',engine:'not_started',dependsOn:'read-only platform and local font/encoder; existing read does not depend on these optional capabilities'};
 if(!enableProduction)return {schema:'n22.content-doctor/v1',oldClip:old,production,hyperframes:'comparison_only_no_auto_mount',readOnly:true};
 production.engine=engine;
 if(engine!=='ffmpeg-static'||!old.ready){
   production.state='blocked';production.code=engine!=='ffmpeg-static'?'PRODUCTION_ENGINE_NOT_ENABLED':'BASE_RUNTIME_UNAVAILABLE';
 }else{
   const filters=probe('ffmpeg',['-hide_banner','-filters']), enc=probe('ffmpeg',['-hide_banner','-encoders']);
   const hasDraw=filters.ok&&/\bdrawtext\b/u.test(filters.text);
   const hasX264=enc.ok&&/\blibx264\b/u.test(enc.text);
   production.features={drawtext:hasDraw,libx264:hasX264};
   try{
     const {profile}=resolveCaptionFont(fontProfile);
     production.font=profile;
     production.ready=hasDraw&&hasX264;
     production.state=production.ready?'ready_local':'blocked';
     if(!production.ready)production.code='FFMPEG_FEATURES_MISSING';
   }catch(e){production.state='blocked';production.code=e.code??'CAPTION_FONT_UNAVAILABLE';}
 }
 return {schema:'n22.content-doctor/v1',oldClip:old,production,hyperframes:'comparison_only_no_auto_mount',readOnly:true};
}

// Host wires this after its feature/role gate. Skip the factory entirely on any failure.
export async function mountContentProduction(report,factory){
 return report?.production?.ready===true&&report.production.enabledByOperator===true?await factory():null;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const arg=new Set(process.argv.slice(2));
 if([...arg].some(x=>!['--production'].includes(x)))throw Error('usage: node content-doctor.mjs [--production]');
 const result=await checkContentReadiness({enableProduction:arg.has('--production')});
 console.log(JSON.stringify(result,null,2));
 process.exitCode=result.oldClip.ready&&(!arg.has('--production')||result.production.ready)?0:1;
}
