const ids=['shopId','requestId','messageId','productId'];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const version=x=>Number.isSafeInteger(x)&&x>0;
const keys=[...ids,'productVersion','referenceMessageId'];
const limit=56;
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const counted=new Set(['CAPTION_TOO_LONG','CAPTION_EMPTY','CAPTION_LINE_BREAK','CAPTION_FORMAT_INVALID']);
const fontMessages={
 CAPTION_FONT_CHANGED:'字幕字体或规则已变化，请重新预览并保存后再确认。',
 CAPTION_FONT_MISSING:'本机缺少预览所需的字幕字体，请先恢复字幕字体。'
};
export function scopedD3ContentReceipt(input,raw){
 return ids.every(k=>id(input?.[k]))&&version(input?.productVersion)&&
  (input.referenceMessageId===null||id(input.referenceMessageId)&&input.referenceMessageId!==input.messageId)&&
  raw?.deliveryStatus==='not_submitted'&&keys.every(k=>raw[k]===input[k])&&
  ['draftSetId','draftSetVersion','planId','planVersion','workId','workVersion'].every(k=>input[k]===undefined||raw[k]===input[k]);
}
const captionPolicy=x=>x?.countRule==='utf16_code_units'&&x?.limit===limit?{countRule:'utf16_code_units',limit}:null;
export {captionPolicy as projectD3CaptionPolicy};
export function projectD3CaptionIssue(input,raw){
 if(!scopedD3ContentReceipt(input,raw)||raw.status!=='needs_review'||raw.taskId!=null||raw.workRef!=null)return null;
 const code=raw.code;
 if(typeof code!=='string')return null;
 if(Object.hasOwn(fontMessages,code))return {code,message:fontMessages[code]};
 if(!counted.has(code))return null;
 const c=raw.captionCheck;
 // Content's count is UTF-16; validate the tuple, do not recount private
 // text or pass its diagnostic object through to the ordinary page.
 if(c?.ok!==false||c?.code!==code||!captionPolicy(c)||!integer(c.shotIndex,1,6)||
    !(integer(c.used,0,4096)||(code==='CAPTION_EMPTY'&&c.used===null)))return null;
 const remaining=c.used===null?null:Math.max(0,limit-c.used);
 if(c.remaining!==remaining)return null;
 const common={countRule:'utf16_code_units',limit,used:c.used,remaining,shotIndex:c.shotIndex,ok:false,code};
 const shot='第 '+c.shotIndex+' 镜头';
 if(code==='CAPTION_TOO_LONG'){
  if(c.used<=limit||c.excess!==c.used-limit)return null;
  return {code,message:shot+'字幕超出 '+c.excess+'（'+c.used+'/'+limit+'），请删减或分到其他镜头。',
   captionCheck:{...common,excess:c.excess}};
 }
 if(c.excess!==undefined)return null;
 const text={
  CAPTION_EMPTY:'字幕为空，请补写后预览。',
  CAPTION_LINE_BREAK:'字幕包含手动换行，请去掉换行或分到其他镜头。',
  CAPTION_FORMAT_INVALID:'字幕格式不合要求，请检查首尾空白或无效字符。'
 };
 return {code,message:shot+text[code],captionCheck:common};
}
// Only forward an existing, precise same-origin content route. A missing or
// invalid URL never becomes a guessed preview, and still cannot auto-play.
export function projectD3Preview(input,raw,work){
 if(!scopedD3ContentReceipt(input,raw)||!id(work?.workId)||!version(work?.workVersion))return null;
 const path='/api/n22/content/d3/works/'+encodeURIComponent(work.workId)+'/'+work.workVersion+'/play?'+
  new URLSearchParams({messageId:input.messageId});
 return raw.previewUrl===path?path:null;
}
