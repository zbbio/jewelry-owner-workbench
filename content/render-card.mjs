import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const formats={'image/png':['png','png'],'image/jpeg':['jpg','mjpeg'],'image/webp':['webp','webp']};
const sha=b=>createHash('sha256').update(b).digest('hex');
const err=(code,msg)=>Object.assign(new Error(msg),{code,httpStatus:503});
// A single offline portrait template. Input names, filters and output names are generated
// by the server. Owner text is data in UTF-8 files, never an FFmpeg filter expression.
export function renderCard(root,key,shots,copy) {
  if(!/^[0-9a-f-]{36}\.mp4$/.test(key)||!shots.length||shots.length>6)throw err('RENDER_PLAN_INVALID','制作选择无效。');
  const font=[
    path.join(process.env.WINDIR??'C:/Windows','Fonts','msyh.ttc'),
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
  ].find(p=>fs.existsSync(p));
  if(!font)throw err('RENDER_FONT_UNAVAILABLE','缺少可显示中文的字体，尚未出片。');
  const dir=fs.mkdtempSync(path.join(root,'.render-'));
  try{
    fs.copyFileSync(font,path.join(dir,'font.ttc'));
    const lines=[];
    for(const line of copy.split('\n')){
      const chars=[...line];
      if(!chars.length)lines.push('');
      for(let j=0;j<chars.length;j+=14)lines.push(chars.slice(j,j+14).join(''));
    }
    const pages=[];
    for(let j=0;j<lines.length;j+=4)pages.push(lines.slice(j,j+4).join('\n'));
    // Copy, not the number of shots, may require the longer display time.
    const segment=Math.max(2,Math.ceil(pages.length*3/shots.length));
    const dur=segment*shots.length;
    if(dur>85||!pages.length)throw err('RENDER_PLAN_INVALID','介绍分页超过短片长度，请精简文字。');
    const args=['-hide_banner','-loglevel','error','-xerror','-nostdin','-filter_complex_threads','1'],graph=[];
    for(const [i,s] of shots.entries()){
      const f=formats[s.mime];
      if(!f||!Buffer.isBuffer(s.bytes)||s.bytes.length>8*1024*1024||sha(s.bytes)!==s.digest)throw err('SOURCE_CHANGED','原图摘要或格式变化，请重新核对许可。');
      const file='photo'+i+'.'+f[0];fs.writeFileSync(path.join(dir,file),s.bytes,{flag:'wx'});
      args.push('-protocol_whitelist','file','-f','image2','-c:v',f[1],'-threads','1','-loop','1','-framerate','12','-t',String(segment),'-i',file);
      graph.push('['+i+':v]scale=360:478:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=360:478:(ow-iw)/2:(oh-ih)/2:color=0x172329,setsar=1,format=yuv420p[v'+i+']');
    }
    const parts=shots.map((_,i)=>'[v'+i+']').join('')+'concat=n='+shots.length+':v=1:a=0,pad=360:640:0:0:color=0x172329';
    const overlays=pages.map((body,i)=>{
      fs.writeFileSync(path.join(dir,'copy'+i+'.txt'),body,{encoding:'utf8',flag:'wx'});
      return "drawtext=fontfile=font.ttc:textfile=copy"+i+".txt:expansion=none:fontsize=22:fontcolor=white:line_spacing=5:x=24:y=502:enable='gte(t,"+(dur*i/pages.length).toFixed(5)+")*lt(t,"+(dur*(i+1)/pages.length).toFixed(5)+")'";
    });
    graph.push(parts+','+overlays.join(',')+'[out]');
    args.push('-filter_complex',graph.join(';'),'-map','[out]','-an','-c:v','libx264','-threads','1','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-frames:v',String(dur*12),'-movflags','+faststart','-f','mp4','-n','candidate.mp4');
    const r=spawnSync('ffmpeg',args,{cwd:dir,windowsHide:true,encoding:'utf8',timeout:35000,maxBuffer:128*1024});
    if(r.status!==0)throw err('RENDER_FAILED','本地 FFmpeg 未成功；任务保留，可按原号重试。');
    const pending=path.join(dir,'candidate.mp4'), output=path.join(root,key);
    // Fail rather than replace a published revision, even on an accidental key collision.
    fs.copyFileSync(pending,output,fs.constants.COPYFILE_EXCL);
    return {durationSeconds:dur,frames:dur*12,shotCount:shots.length,captionPages:pages.length};
  }finally{
    // Node v23 on this Windows host silently skips recursive rmSync for a
    // non-ASCII parent. Only generated, flat temporary files live here.
    for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));
    fs.rmdirSync(dir);
  }
}
