import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,statSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname,delimiter} from 'node:path';
import {resolveCaptionFont} from '../content/caption-policy.mjs';
import {prepareTwoPlans,editPlan} from '../content/c2-plan-prep.mjs';
import {ctx,source,material,readFixtureAsset} from '../C2/fixture.mjs';
import {reopenProject,saveProject} from '../C2/project.mjs';
import {checkContentReadiness,mountContentProduction} from './content-doctor.mjs';
import {createLocalVideoStore} from '../../../../../店主工作台/content/local-video.mjs';

const here=fileURLToPath(new URL('.',import.meta.url)), repo=dirname(here);
const out=join(here,'证据','audit-'+randomUUID());mkdirSync(out,{recursive:true});
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/u,''));
const hash=x=>createHash('sha256').update(x).digest('hex');
const fileInfo=p=>{const f=realpathSync(p),b=readFileSync(f);return {path:f,sha256:hash(b),bytes:b.length};};
const run=(file,args)=>{
 const z=spawnSync(file,args,{windowsHide:true,timeout:25000,maxBuffer:6*1024*1024});
 assert.equal(z.status,0,z.stderr?.toString());return z.stdout;
};
function binary(base){
 for(const dir of (process.env.PATH??'').split(delimiter)){
  if(!dir)continue;
  const f=join(dir.replace(/^"|"$/gu,''),base+(process.platform==='win32'?'.exe':''));
  try{if(statSync(f).isFile())return fileInfo(f);}catch{}
 }
 throw Error(base+' not available');
}
const c3=read(join(repo,'C3','模块回执.json')),hf=read(join(repo,'C3','HyperFrames对照','指纹与解码.json'));
const orig={ffmpegStatic:c3.artifact.file,hyperframes:hf.asset};
const history={
 ffmpeg:readFileSync(join(repo,'C3','实跑.txt'),'utf8'),
 hyperframes:readFileSync(join(repo,'C3','HyperFrames对照','实跑.txt'),'utf8'),
 hfExit:read(join(repo,'C3','HyperFrames对照','退出.json'))
};
const baseline=Object.fromEntries(Object.entries(orig).map(([key,f])=>[key,fileInfo(f)]));
assert.equal(baseline.ffmpegStatic.sha256,c3.artifact.sha256);assert.equal(baseline.hyperframes.sha256,hf.sha256);
const W=360,H=640;
const positions=[1,6,11], order=[2,1,0];
const probe=[];
for(const [engine,media] of Object.entries(orig)){
 const data=JSON.parse(run('ffprobe',['-v','error','-protocol_whitelist','file','-show_entries',
  'stream=codec_name,codec_type,width,height,nb_frames,pix_fmt,r_frame_rate:stream_tags=encoder:format=duration,size','-of','json',media]));
 assert.equal(data.streams.length,1);const s=data.streams[0];
 assert.deepEqual([s.codec_name,s.codec_type,s.width,s.height,+s.nb_frames,+data.format.duration],['h264','video',360,640,180,15]);
 const frames=[];
 for(const [k,pos] of positions.entries()){
  const rgb=run('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file','-ss',pos+'','-i',media,'-frames:v','1','-threads:v','1',
    '-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  assert.equal(rgb.length,W*H*3);
  const i=order[k], target=[120+i*23,217-i*22,186-i*24];
  let xa=W,xb=0,ya=H,yb=0,n=0,ink=0;
  for(let y=75;y<405;y++)for(let x=10;x<350;x++){
   const a=(y*W+x)*3;
   if((rgb[a]-target[0])**2+(rgb[a+1]-target[1])**2+(rgb[a+2]-target[2])**2<20**2){
    n++;xa=Math.min(xa,x);xb=Math.max(xb,x);ya=Math.min(ya,y);yb=Math.max(yb,y);
   }
  }
  for(let y=491;y<595;y++)for(let x=15;x<345;x++){
   const a=(y*W+x)*3;if(rgb[a]>181&&rgb[a+1]>181&&rgb[a+2]>181)ink++;
  }
  assert.ok(n>500&&ink>40);
  const ratio=(xb-xa+1)/(yb-ya+1);assert.ok(Math.abs(ratio-1)<.025);
  frames.push({seconds:pos,fixtureShot:i+1,width:xb-xa+1,height:yb-ya+1,ratio,subtitleBrightPixels:ink});
 }
 const samplePng=join(out,engine+'-1s.png');
 run('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file','-ss','1','-i',media,'-frames:v','1','-threads:v','1','-n',samplePng]);
 probe.push({engine,media:baseline[engine],data,frames,forensicStill:fileInfo(samplePng),audioStreams:0,fixtureRoundRingWithinRatioTolerance:true});
}
const start=prepareTwoPlans(ctx,source(),{readApprovedAsset:readFixtureAsset});
const p=start.plans[0];
const plan=editPlan(ctx,source(),start,{expectedVersion:1,planId:p.planId,shots:p.shots.toReversed().map((x,i)=>
 ({...x,durationMs:5000,caption:i===0?'改后字幕：先看第三张':'仅隔离图形样片'}))});
const legacySource=join(repo,'C2','工程','茶桌v2');
const copyLegacy=join(out,'隔离搬移','legacy');
const current=join(out,'隔离搬移','committed');
mkdirSync(join(copyLegacy,'assets'),{recursive:true});
for(const name of ['plan.json','index.html'])copyFileSync(join(legacySource,name),join(copyLegacy,name));
for(const p of material)copyFileSync(join(legacySource,'assets',p.assetId+'.png'),join(copyLegacy,'assets',p.assetId+'.png'));
const ref={state:plan,plan:plan.plans[0]};
assert.equal(reopenProject(copyLegacy,{...ref,allowLegacy:true}).adoptionInput,'legacy_revalidated');
saveProject(current,plan,plan.plans[0],material);
assert.equal(reopenProject(current,ref).adoptionInput,'committed');
const commitMove=join(out,'重定位','子目录','同一工程');mkdirSync(commitMove,{recursive:true});
for(const n of ['plan.json','index.html','COMMITTED.json'])copyFileSync(join(current,n),join(commitMove,n));
mkdirSync(join(commitMove,'assets'));
for(const p of material)copyFileSync(join(current,'assets',p.assetId+'.png'),join(commitMove,'assets',p.assetId+'.png'));
assert.equal(reopenProject(commitMove,ref).assetIntegrity,'verified');
for(const f of ['plan.json','index.html','COMMITTED.json'])assert.equal(fileInfo(join(commitMove,f)).sha256,fileInfo(join(current,f)).sha256);
const listNames=['index.html','plan.json','COMMITTED.json',...material.map(p=>'assets/'+p.assetId+'.png')];
const localMovedFiles=listNames.map(name=>{const v=fileInfo(join(commitMove,name));return {name,sha256:v.sha256,bytes:v.bytes};});

const readClip=()=>!!createLocalVideoStore(dirname(orig.ffmpegStatic)).readPlayable(orig.ffmpegStatic.split(/[\\/]/u).at(-1),baseline.ffmpegStatic.sha256);
const {profile:font,path:fontPath}=resolveCaptionFont();
const badFont={...font,fontSha256:'0'.repeat(64)};
const off=await checkContentReadiness({enableProduction:false,probeExisting:readClip,fontProfile:badFont});
const blocked=await checkContentReadiness({enableProduction:true,probeExisting:readClip,fontProfile:badFont});
const on=await checkContentReadiness({enableProduction:true,probeExisting:readClip,fontProfile:font});
let mounts=0;
const tryMount=async h=>await mountContentProduction(h,()=>{mounts++;return 'factory would be constructed';});
assert.equal(await tryMount(off),null);assert.equal(await tryMount(blocked),null);assert.equal(mounts,0);
assert.ok(off.oldClip.ready&&blocked.oldClip.ready&&on.oldClip.ready&&on.production.ready);
assert.equal(blocked.production.code,'CAPTION_FONT_CHANGED');

const hfPkg=join(repo,'C2','工具锁','node_modules','hyperframes');
const hp=read(join(hfPkg,'package.json'));
const lock=read(join(repo,'C2','工具锁','package-lock.json'));
const nodeInfo={...fileInfo(process.execPath),version:process.version,licenseSource:'https://raw.githubusercontent.com/nodejs/node/v23.11.1/LICENSE'};
const ffmpeg={...binary('ffmpeg'),banner:off.oldClip.ffmpeg.banner,license:run('ffmpeg',['-hide_banner','-L']).toString().split(/\r?\n/u).slice(0,4),
 config:run('ffmpeg',['-hide_banner','-version']).toString().split(/\r?\n/u).find(x=>x.startsWith('configuration:'))};
const installedLicense=join(dirname(dirname(ffmpeg.path)),'LICENSE');
try{ffmpeg.installedLicense=fileInfo(installedLicense);}catch{ffmpeg.installedLicense=null;}
const ffprobe={...binary('ffprobe'),banner:off.oldClip.ffprobe.banner};
const chromePath='C:/Program Files/Google/Chrome/Application/chrome.exe';
const chrome={...fileInfo(chromePath),versionObservedNow:run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
 "(Get-Item -LiteralPath 'C:/Program Files/Google/Chrome/Application/chrome.exe').VersionInfo.ProductVersion"]).toString().trim()};
const distEntries=['cli.js'].map(name=>{const x=fileInfo(join(hfPkg,'dist',name));return {name,sha256:x.sha256,bytes:x.bytes};});
const stageFiles=['content/c1-old-video.mjs','content/c2-plan-prep.mjs','content/caption-policy.mjs','C2/plan-version-store.mjs','C2/project.mjs','C3/studio-work-copy.mjs','C3/production.mjs',
 'C3/render-plan.mjs','C4/adoption.mjs','D3/d3-content.mjs','C4SHIP/content-doctor.mjs'];
const sourceManifest=stageFiles.map(f=>{const x=fileInfo(join(repo,f));return {pathFromContentRepo:f,sha256:x.sha256,bytes:x.bytes};});
const substrateRoot=fileURLToPath(new URL('../../../../../店主工作台',import.meta.url));
const substrate=['content/index.mjs','content/local-video.mjs','content/render-card.mjs'].map(f=>{const x=fileInfo(join(substrateRoot,f));return {pathFromWorkbench:f,sha256:x.sha256,bytes:x.bytes};});
const durations={ffmpegTestTotalMs:Number(/\((\d+(?:\.\d+)?)ms\)/u.exec(history.ffmpeg.split(/\r?\n/u).find(x=>x.includes('actual FFmpeg')&&x.includes('ms)'))??'')?.[1]),
 ffmpegRenderOnlyMs:null,hyperframesCommandWallMs:history.hfExit.elapsedMs,hyperframesPipelineMs:16251,hyperframesCaptureStreamingMs:15487,
 peakTemporaryDiskBytes:{ffmpeg:null,hyperframes:null},extraRenders:0};
assert.ok(Number.isFinite(durations.ffmpegTestTotalMs));
const cpu=run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
 'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json -Compress']).toString();
const selfCli={};
for(const [label,args] of [['off',[]],['on',['--production']]]){
 const proc=spawnSync(process.execPath,[join(here,'content-doctor.mjs'),...args],{encoding:'utf8',windowsHide:true,timeout:25000});
 assert.equal(proc.status,0,proc.stderr);
 selfCli[label+'Exit']=proc.status;
 selfCli[label]=join(here,label==='off'?'自检-关闭制作.txt':'自检-本机依赖.txt');
 writeFileSync(selfCli[label],proc.stdout+(proc.stderr??''));
}
const runtime={schema:'n22.content-deploypack/v1',ticket:'N22-C4SHIP/内容仓',checkedUtc:new Date().toISOString(),
 host:{platform:process.platform,arch:process.arch,cpu:JSON.parse(cpu),gpuUsed:false,caveat:'historical render logs prove software modes; CPU description is current same local host inventory, not measurements of past CPU load'},
 engines:{node:nodeInfo,ffmpeg,ffprobe,font:{...fileInfo(fontPath),profile:font},
  hyperframes:{package:hp.name,version:hp.version,license:hp.license,pin:'c6307feea45404033c698de31cc9e77e5fb56536',
   cli:fileInfo(join(hfPkg,hp.bin.hyperframes??hp.bin)),installerIntegrity:lock.packages['node_modules/hyperframes'].integrity,
   lock:fileInfo(join(repo,'C2','工具锁','package-lock.json')),distEntries,chrome}},
 package:{default:'closed_for_new_production',includeInternalSourceOnly:sourceManifest,requiredRelativeWorkbenchSource:substrate,
  doNotBundle:['node runtime','Gyan ffmpeg or ffprobe','Chrome','Windows msyh TTC','HyperFrames node_modules','any MP4/PNG original or fixture','shop state and media','credentials'],
  mounts:{readOnly:'Node+ffmpeg/ffprobe and authenticated C1 media projection/store; independently owned',production:'isolated D3 content SQLite/media root and locally approved font plus encoders/filters',optionalComparison:'HyperFrames CLI/Chrome; not auto-mounted'},productionMountGuard:'content-doctor.mjs#mountContentProduction'},
 mobility:{legacyReopened:true,currentMovedAndReopened:true,proofOutsideProject:'persisted trusted draft and asset digests still required',
  files:localMovedFiles,relativeAssetsOnly:true,currentMovedPath:commitMove,prodTreeRelocation:'not verified; retain workbench and content layout, remap operator config and use a consistent DB/media snapshot'},
 media:probe,history:{...durations,ffmpegConcurrency:'one encoder thread; renderCard adaptation uses CPU libx264 and one filter-complex thread',
  hyperframesConcurrency:'one worker, software Chromium capture, no GPU acceleration per log',
  limits:['No historic peak temp disk / RAM was captured; current retained files are not peak','FFmpeg time includes suite, scripts and probes, cannot compare to engine-only','Samples are authored geometry and silent; no real goods, no audio sync or mobile'],logDigests:{
   ffmpeg:hash(readFileSync(join(repo,'C3','实跑.txt'))),hyperframes:hash(readFileSync(join(repo,'C3','HyperFrames对照','实跑.txt')))}},
 readiness:{disabledWithoutFont:off,mismatchedFontBlocksOnlyProduction:blocked,withLocalDependencies:on,optionalFactoriesCalled:mounts},
 cli:selfCli,
 sourceNotice:{
   hyperframes:'Apache-2.0 root LICENSE at pinned commit; upstream root NOTICE URL returned 404; installed root lacked LICENSE/NOTICE; transitive notice/distribution review pending',
   ffmpeg:'this binary self-reports GPL-3.0-or-later, configure enables GPL/version3/libx264; public corresponding source, notices and codec rights not cleared',
   font:'Windows system YaHei local only; no redistribution grant for font file',
   node:'v23 line EOL, actual local runtime only; supported LTS retest required before packaging',
   music:'none in both artifacts; no rights implied'
 },
 release:{publicBundleApproved:false,externalBinaryOrFontApproved:false,noNetworkOrBackendRequests:true,noProductionRendersThisTurn:true,noDevice:true}
};
for(const [k,f] of Object.entries(orig))assert.deepEqual(fileInfo(f),baseline[k]);
writeFileSync(join(here,'内容运行清单.json'),JSON.stringify(runtime,null,2)+'\n');
console.log('C4SHIP '+JSON.stringify({legacyMobility:runtime.mobility.legacyReopened,movedV2:runtime.mobility.currentMovedAndReopened,
 media:probe.map(x=>({engine:x.engine,sha256:x.media.sha256,frames:x.frames})),readOnly:[off.oldClip.ready,blocked.oldClip.ready],
 prod:[off.production.state,blocked.production.state,on.production.state],history:durations,output:out}));
