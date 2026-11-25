import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateCaptionPlan} from '../content/caption-policy.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const reject=code=>{throw Object.assign(new Error(code),{code});};
const fmt={'image/png':['png','png'],'image/jpeg':['jpg','mjpeg'],'image/webp':['webp','webp']};
export function renderConfirmedPlan({root,key,shots,locked}){
  if(!/^[a-z0-9-]{36}\.mp4$/u.test(key)||!Array.isArray(shots)||!locked?.plan?.shots||
    shots.length!==locked.plan.shots.length||shots.length!==locked.assets.length||shots.length<2||shots.length>6)reject('C3_RENDER_INPUT');
  const {path:font,profile:captionProfile,captions}=validateCaptionPlan(locked.plan,locked.captionProfile);
  const dir=fs.mkdtempSync(path.join(root,'.n22-plan-'));
  try{
    fs.copyFileSync(font,path.join(dir,'font.ttc'));
    if(sha(fs.readFileSync(path.join(dir,'font.ttc')))!==captionProfile.fontSha256)
      throw Object.assign(Error('字幕字体已变更，请重新预检。'),{code:'CAPTION_FONT_CHANGED'});
    const args=['-hide_banner','-loglevel','error','-xerror','-nostdin','-filter_complex_threads','1'];
    const filters=[], segmentFrames=[];
    for(const [i,raw] of shots.entries()){
      const item=locked.plan.shots[i], asset=locked.assets.find(a=>a.assetId===item.assetId), f=fmt[raw.mime];
      if(!asset||!f||!Buffer.isBuffer(raw.bytes)||raw.bytes.length!==asset.size||raw.mime!==asset.mime||
         sha(raw.bytes)!==asset.sha256||raw.digest!==asset.sha256)reject('C3_SOURCE_CHANGED');
      if(!Number.isSafeInteger(item.durationMs)||item.durationMs<1000||item.durationMs>7000)reject('C3_RENDER_INPUT');
      const pic='input'+i+'.'+f[0], cap='caption'+i+'.txt', frames=Math.round(item.durationMs*12/1000);
      fs.writeFileSync(path.join(dir,pic),raw.bytes,{flag:'wx'});
      fs.writeFileSync(path.join(dir,cap),captions[i].lines.join('\n'),{encoding:'utf8',flag:'wx'});
      segmentFrames.push(frames);
      args.push('-protocol_whitelist','file','-f','image2','-c:v',f[1],'-threads','1','-loop','1','-framerate','12','-t',(frames/12).toFixed(6),'-i',pic);
      filters.push('['+i+':v]scale=360:478:force_original_aspect_ratio=decrease:force_divisible_by=2,'+
        'pad=360:478:(ow-iw)/2:(oh-ih)/2:color=0x172329,setsar=1,format=yuv420p,'+
        'pad=360:640:0:0:color=0x172329,drawtext=fontfile=font.ttc:textfile='+cap+
        ':expansion=none:fontsize=22:fontcolor=white:line_spacing=5:x=24:y=502'+
        ',trim=end_frame='+frames+',setpts=PTS-STARTPTS[v'+i+']');
    }
    const n=segmentFrames.reduce((x,y)=>x+y,0);
    filters.push(segmentFrames.map((_,i)=>'[v'+i+']').join('')+'concat=n='+shots.length+':v=1:a=0[out]');
    args.push('-filter_complex',filters.join(';'),'-map','[out]','-an','-c:v','libx264','-threads','1','-preset','veryfast',
      '-crf','21','-pix_fmt','yuv420p','-frames:v',String(n),'-movflags','+faststart','-f','mp4','-n','candidate.mp4');
    const r=spawnSync('ffmpeg',args,{cwd:dir,windowsHide:true,timeout:35000,encoding:'utf8',maxBuffer:128*1024});
    if(r.status!==0)reject('C3_RENDER_FAILED');
    fs.copyFileSync(path.join(dir,'candidate.mp4'),path.join(root,key),fs.constants.COPYFILE_EXCL);
    return {durationSeconds:n/12,frames:n,shotCount:shots.length,captionPages:shots.length,segmentFrames,
      planRef:{planId:locked.plan.planId,planVersion:locked.plan.planVersion,draftSetId:locked.draftSetId,draftSetVersion:locked.draftSetVersion},
      planSha256:locked.planSha256,assetPinsDigest:locked.assetPinsDigest,captionProfile,renderer:'local-ffmpeg-static-plan/v1',audio:'none'};
  }finally{for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));fs.rmdirSync(dir);}
}
