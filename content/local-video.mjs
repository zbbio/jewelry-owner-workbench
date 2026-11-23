import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Only simple, regular MP4s from a server-selected local directory; no URL or nested file references.
const MAX=16*1024*1024, seconds=90;
function intact(bytes) {
  let seen=new Set(), p=0;
  while (p<bytes.length) {
    if (bytes.length-p<8) return false;
    let n=bytes.readUInt32BE(p);
    if (n<8 || n>bytes.length-p) return false; // bounded fixture subset, no open-ended / extended boxes
    seen.add(bytes.toString('ascii',p+4,p+8));p+=n;
  }
  return ['ftyp','moov','mdat'].every(k=>seen.has(k));
}
const run=(bin,args,input)=>spawnSync(bin,args,{input,timeout:6000,windowsHide:true,maxBuffer:512*1024});
export function createLocalVideoStore(localRoot) {
  if (!path.isAbsolute(localRoot) || /^(?:\\\\|\/\/)/.test(localRoot)) throw new TypeError('local media root required');
  const root=fs.realpathSync(localRoot);
  if (!fs.statSync(root).isDirectory() || /^(?:\\\\|\/\/)/.test(root)) throw new TypeError('local directory required');
  function readPlayable(key, expectedSha256) {
    if (typeof key!=='string' || !/^[a-zA-Z0-9_-]{1,96}\.mp4$/i.test(key)) return null;
    // Reject Windows device basenames before any filesystem access.
    if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(key)) return null;
    let fd;
    try {
      const file=path.join(root,key),l=fs.lstatSync(file,{bigint:true});
      if(!l.isFile() || l.isSymbolicLink() || fs.realpathSync(file)!==file) return null;
      fd=fs.openSync(file,'r');
      const s=fs.fstatSync(fd), id=fs.fstatSync(fd,{bigint:true});
      // Windows lstat can omit the volume id (zero) even when fstat supplies it.
      if(!s.isFile() || id.ino!==l.ino || (l.dev!==0n && id.dev!==l.dev) || s.size<32 || s.size>MAX) return null;
      // Bounded snapshot: probes, full decode and returned bytes refer to the same object.
      const bytes=Buffer.alloc(s.size);let pos=0;
      while(pos<bytes.length){const n=fs.readSync(fd,bytes,pos,bytes.length-pos,pos);if(n<=0)return null;pos+=n;}
      if(fs.fstatSync(fd).size!==s.size || !intact(bytes)) return null;
      const sha256=createHash('sha256').update(bytes).digest('hex');
      if(expectedSha256!==undefined && sha256!==expectedSha256) return null;
      const source=['-protocol_whitelist','pipe','-f','mov','-i','pipe:0'];
      const meta=run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,nb_frames,duration:format=duration','-of','json',...source],bytes);
      if(meta.status!==0 || meta.stderr?.length) return null;
      const doc=JSON.parse(meta.stdout),v=doc.streams?.[0],d=Number(v?.duration??doc.format?.duration),n=Number(v?.nb_frames);
      if(!v||v.codec_name!=='h264'||!Number.isFinite(d)||d<=0||d>seconds||!Number.isSafeInteger(n)||n<1||n>5400||v.width<1||v.height<1||v.width>1920||v.height>1920)return null;
      const decoded=run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-xerror','-err_detect','explode','-threads','1',...source,
        '-map','0:v:0','-an','-sn','-dn','-fps_mode','passthrough','-f','null','-','-progress','pipe:1','-nostats'],bytes);
      const status=decoded.stdout?.toString()??'',frames=Array.from(status.matchAll(/^frame=(\d+)\s*$/gm)).at(-1);
      if(decoded.status!==0 || decoded.stderr?.length || !/^progress=end\s*$/m.test(status) || Number(frames?.[1])!==n) return null;
      return {bytes,sha256,codec:'h264',frames:n,durationSeconds:d,mime:'video/mp4'};
    } catch { return null; }
    finally { if(fd!==undefined)fs.closeSync(fd); }
  }
  return {readPlayable};
}
