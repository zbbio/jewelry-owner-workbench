const nums={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6};
const quotes={'「':'」','『':'』','“':'”','"':'"'};
const lead=/^(?:请\s*)?(?:帮我\s*)?把\s*(?:刚才(?:的)?\s*)?第\s*([一二12])\s*(?:套|版)(?:的)?\s*第\s*([一二三四五六1-6])\s*镜(?:头)?(?:的)?\s*字幕\s*(?:改成|改为|换成)\s*[：:]?\s*/u;
const cue=/(?:字幕[\s\S]{0,32}(?:改|换|编辑|修改)|(?:改|换|编辑|修改)[\s\S]{0,32}字幕)/u;
const divider=/^[，,；;\n。！？!?]/u;
const allowedTail=/^(?:先)?(?:别|不(?:要|用|必)?|无需)(?:再)?(?:制作|做|新做|渲染|出片|发布|发送|外发|采用|确认|上架)(?:本件|这版|新片|视频)?(?:了)?$/u;
const replaceable=/[，,；;\n。！？!?]+/u;

export function parseD3CaptionCommand(text){
 const q=text.trim(), m=lead.exec(q);
 if(!m&&!cue.test(q.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/gu,'')))return null;
 const invalid={command:'edit',ordinal:null,invalid:true,noPublish:true};
 if(!m)return invalid;
 const offset=m[0].length, opener=q[offset];
 if(!Object.hasOwn(quotes,opener))return invalid;
 const end=q.indexOf(quotes[opener],offset+1);
 if(end<0)return invalid;
 const tail=q.slice(end+1).trim();
 if(tail&&(!divider.test(tail)||tail.split(replaceable).map(x=>x.trim()).filter(Boolean).some(x=>!allowedTail.test(x))))return invalid;
 return {command:'edit',ordinal:nums[m[1]]??Number(m[1]),shotOrdinal:nums[m[2]]??Number(m[2]),
  caption:q.slice(offset+1,end),invalid:false,noPublish:true};
}
