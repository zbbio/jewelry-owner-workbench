import fs from 'node:fs';
import path from 'node:path';

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export function requireMediaTools() { for(const exe of ['ffmpeg','ffprobe']){const r=spawnSync(exe,['-version'],{encoding:'utf8',windowsHide:true,timeout:5000});if(r.status!==0)throw Error('Local prerequisite missing: '+exe);}}
export function makeSyntheticMedia(dir){requireMediaTools();fs.mkdirSync(dir,{recursive:true});
const w=160,h=96,px=Buffer.alloc(w*h*3);
for(let i=0;i<w*h;i++){const x=i%w,y=Math.floor(i/w);px[i*3]=x*1.5;px[i*3+1]=y*2;px[i*3+2]=Math.floor(x/20)%2?235:30;}
fs.writeFileSync(path.join(dir,'synth.ppm'),Buffer.concat([Buffer.from('P6\n160 96\n255\n'),px]));
const args=['-y','-v','error','-nostdin','-loop','1','-framerate','8','-i','synth.ppm','-frames:v','8','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','valid.mp4'];
const r=spawnSync('ffmpeg',args,{cwd:dir,encoding:'utf-8',windowsHide:true});if(r.status!==0)throw Error(r.stderr||String(r.error));
const valid=fs.readFileSync(path.join(dir,'valid.mp4'));
fs.writeFileSync(path.join(dir,'truncated.mp4'),valid.subarray(0,valid.length-25));
fs.writeFileSync(path.join(dir,'text.mp4'),Buffer.from('not video'));
const bad=Buffer.from(valid),mdat=bad.indexOf(Buffer.from('mdat'));if(mdat<4)throw Error('missing mdat');bad.fill(0,mdat+4);fs.writeFileSync(path.join(dir,'corrupt.mp4'),bad);
return {ffmpegArgs:args,exit:r.status,files:Object.fromEntries(['synth.ppm','valid.mp4','truncated.mp4','text.mp4','corrupt.mp4'].map(name=>{const b=fs.readFileSync(path.join(dir,name));return[name,[b.length,createHash('sha256').update(b).digest('hex')]]}))};}
