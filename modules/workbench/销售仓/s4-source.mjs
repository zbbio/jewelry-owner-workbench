const id=x=>typeof x==='string'&&/^[\p{L}\p{N}_.:-]{1,120}$/u.test(x);
const goodVersion=x=>Number.isSafeInteger(x)&&x>0;
const DRAFT=/(?:拟|起草|写|生成)(?:一(?:段|条|下|句|份)|两句|个)?(?:给)?(?:客人|顾客|客户)?(?:的)?回复|回复草稿|(?:把|整理).{0,20}(?:客人|顾客|客户).{0,20}(?:两句|草稿)|准备.{0,12}怎么回复/u;
const label=/(?:^|[\s，。；;！!?？,])((?:有\s*(?:位|个)?\s*)?(?:顾客|客人|客户)\s*(?:原话|问题|问(?:的是|了)?|说(?:的是|了)?)\s*[:：]?\s*)/gu;
const cancel=/^(?:请\s*)?(?:取消|撤回)(?:这条|本条|刚才的?)?(?:(?:客人|顾客|客户)(?:原话|问题)|草稿资料|引用(?:的)?原话|引用|原话)[。！!]?$/u;
const closer={'“':'”','‘':'’','「':'」','『':'』','"':'"',"\'":"\'"};
const leadingQuotes=new Set(Object.keys(closer));
const sends=/(?:^|[\s，。；;！!?？,])(?:请)?(?:现在|直接|立即|帮我|并)?(?:发给(?:顾客|客人|客户)|发送给(?:顾客|客人|客户)|发送出去|发出去|外发|代发|群发|自动发)/u;
export const cleanCustomerQuote=x=>typeof x==='string'?x.trim()
 .replace(/(?:sk-[a-z0-9_-]{10,}|https?:\/\/\S+|\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/giu,'[已隐去]')
 .replace(/[\u0000-\u001f\u007f]+/gu,' ').trim():null;

export function parseS4Text(t){
 if(typeof t!=='string'||t.length>500)return null;
 const text=t.trim();
 if(cancel.test(text))return {kind:'cancel'};
 const quotes=[];
 let sawLabel=false;
 for(const m of text.matchAll(label)){
  const offset=m.index+m[0].length, first=text[offset];
  if(quotes.some(q=>offset<q.end))continue;
  sawLabel=true;
  if(leadingQuotes.has(first)){
   const end=text.indexOf(closer[first],offset+1);
   if(end<0)continue;
   quotes.push({start:m.index,end:end+1,raw:text.slice(offset+1,end)});
  }else{
   // A colon makes unquoted text acceptable only as a whole line. Same-
   // line instructions require quotes so their boundaries are unambiguous.
   if(!/[:：]\s*$/u.test(m[1]))continue;
   const end=text.indexOf('\n',offset),raw=text.slice(offset,end<0?text.length:end);
   if(DRAFT.test(raw))continue;
   quotes.push({start:m.index,end:end<0?text.length:end,raw});
  }
 }
 let command='',pos=0;
 for(const q of quotes){command+=text.slice(pos,q.start)+' ';pos=q.end;}
 command=(command+text.slice(pos)).trim();
 if(!DRAFT.test(command)&&!(sawLabel&&DRAFT.test(text)&&!quotes.length)&&!quotes.length)return null;
 const kind=DRAFT.test(command)||!quotes.length?'draft':'capture';
 const question=quotes.length===1?cleanCustomerQuote(quotes[0].raw):null;
 return {kind,command,question,
  issue:quotes.length>1?'DRAFT_SOURCE_AMBIGUOUS':
   sawLabel&&(!question||question.length>220||quotes.length===0)?'DRAFT_SOURCE_REQUIRED':
   sends.test(command)?'DRAFT_SEND_NOT_SUPPORTED':null};
}

const validateSource=(v,selector)=>v?.kind==='owner_provided_quote'&&id(v.originMessageId)&&
 !!cleanCustomerQuote(v.text)&&v.text.length<=220&&
 (v.productId==null&&v.productVersion==null||id(v.productId)&&goodVersion(v.productVersion))&&
 (selector===undefined||v.originMessageId===selector);
export function makeDraftSource(originMessageId,text,pin={}){
 return {kind:'owner_provided_quote',originMessageId,text,...(pin.productId?{productId:pin.productId,productVersion:pin.productVersion}:{})};
}
// Uses the product-owned ledger's shop/actor/session scoped restore and
// durable cancellation index. No browsing of transcripts or external chats.
export function createS4MessageSource({restore,isCanceled}={}){
 if(typeof restore!=='function'||typeof isCanceled!=='function')return null;
 return async(ctx,id0)=>{
  if(!id(id0))return {status:'not_available'};
  const hit=await restore(ctx,id0);
  if(!hit||hit.shopId!==ctx.shopId||hit.messageId!==id0||!['completed','draft_source_captured'].includes(hit.status)||
     !validateSource(hit.draftSource))return {status:'not_available'};
  const source=hit.draftSource;
  const origin=source.originMessageId;
  if(origin!==id0){
   const first=await restore(ctx,origin);
   if(!first||first.shopId!==ctx.shopId||first.messageId!==origin||!['completed','draft_source_captured'].includes(first.status)||
      !validateSource(first.draftSource,origin)||first.draftSource.text!==source.text)return {status:'not_available'};
  }
  const [voidThis,voidFirst]=await Promise.all([isCanceled(ctx,id0),origin===id0?false:isCanceled(ctx,origin)]);
  if(voidThis===true||voidFirst===true)return {status:'canceled'};
  if(voidThis!==false||voidFirst!==false)return {status:'not_available'};
  return {status:'available',source:{...source,text:cleanCustomerQuote(source.text)}};
 };
}
