import {createHash} from 'node:crypto';
import {statSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export const CAPTION_LIMIT=56;
const charsPerLine=14;
const cache=new Map();
const profiles=()=>[
 ['msyh','Microsoft YaHei',join(process.env.WINDIR??'C:/Windows','Fonts','msyh.ttc')],
 ['noto-cjk','Noto Sans CJK SC','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'],
 ['hiragino','Hiragino Sans GB','/System/Library/Fonts/Hiragino Sans GB.ttc']
];
const fail=(code,message,captionCheck)=>{throw Object.assign(Error(message),{code,...(captionCheck?{captionCheck}:{})});};
export function inspectCaption(text){
 const used=typeof text==='string'?text.length:null;
 const base={countRule:'utf16_code_units',limit:CAPTION_LIMIT,used,remaining:used===null?null:Math.max(0,CAPTION_LIMIT-used)};
 const bad=(code,message)=>({...base,ok:false,code,message});
 if(typeof text!=='string'||text.trim().length===0)return bad('CAPTION_EMPTY','字幕不能为空。');
 if(/[\r\n\u2028\u2029]/u.test(text))return bad('CAPTION_LINE_BREAK','单段字幕不接受手动换行，请去掉换行或把文案分到其他镜头。');
 if(/[\u0000-\u001f\u007f]|[\ud800-\udfff]/u.test(text)||text.trim()!==text)
   return bad('CAPTION_FORMAT_INVALID','请移除控制字符、无效字符或首尾空白后再保存。');
 if(used>CAPTION_LIMIT)return {...bad('CAPTION_TOO_LONG','本模板每段最多 '+CAPTION_LIMIT+' 个 UTF-16 单元，已超 '+(used-CAPTION_LIMIT)+' 个；请删减或分到其他镜头。'),excess:used-CAPTION_LIMIT};
 return {...base,ok:true,message:'本段还可输入 '+base.remaining+' 个 UTF-16 单元。'};
}
export function requireCaption(text,shotIndex){
 const check=inspectCaption(text);
 if(!check.ok)fail(check.code,check.message,{...check,...(shotIndex?{shotIndex}:{})});
 const scalar=[...text],lines=[];
 for(let i=0;i<scalar.length;i+=charsPerLine)lines.push(scalar.slice(i,i+charsPerLine).join(''));
 return {...check,lines};
}
export function resolveCaptionFont(expected){
 const pool=profiles();
 if(expected)pool.sort((a,b)=>Number(b[0]===expected.fontId)-Number(a[0]===expected.fontId));
 for(const [fontId,fontFamily,path] of pool){
  if(expected&&fontId!==expected.fontId)continue;
  let s;
  try{s=statSync(path,{bigint:true});}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')continue;throw e;}
  if(!s.isFile())continue;
  const key=[s.size,s.mtimeNs,s.ctimeNs,s.ino].join(':');
  let prev=cache.get(path);
  if(prev?.key!==key){
   const sha256=createHash('sha256').update(readFileSync(path)).digest('hex');prev={key,sha256};cache.set(path,prev);
  }
  const profile={policyVersion:'n22-static-caption/v1',countRule:'utf16_code_units',limit:CAPTION_LIMIT,fontId,fontFamily,fontSha256:prev.sha256};
  if(expected&&Object.keys(profile).some(k=>expected[k]!==profile[k]))
   fail('CAPTION_FONT_CHANGED','字幕字体或规则已变更，请重新预检和保存后再制作。');
  return {profile,path};
 }
 fail('CAPTION_FONT_MISSING','本机缺少该字幕字体，暂不制作；请恢复字体后重新预检。');
}
export function validateCaptionPlan(plan,expected){
 if(!Array.isArray(plan?.shots)||!plan.shots.length)fail('CAPTION_FORMAT_INVALID','缺少可校验的镜头字幕。');
 const captions=plan.shots.map((x,i)=>requireCaption(x?.caption,i+1));
 const font=resolveCaptionFont(expected);
 return {...font,captions};
}
