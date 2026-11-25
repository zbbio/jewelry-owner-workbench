import {createHash} from 'node:crypto';
import {actionsOf} from './local-read-intent.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const id=x=>typeof x==='string'&&/^[\w.:-]{1,128}$/u.test(x);
const workId=x=>id(x)&&/^[\w][\w.-]*$/u.test(x)&&!x.includes('..');
const ver=x=>Number.isSafeInteger(x)&&x>0;
const same=(x,y)=>x?.shopId===y.shopId&&x.productId===y.productId&&x.productVersion===y.productVersion;
const fail=(code)=>({status:'failed',code});
const priceOff=()=>({...fail('SALES_ADAPTER_NOT_MOUNTED'),text:'本件报价暂不可用：销售处理未启用。'});

function pinUrl(u,ref,p,msg){
  if(typeof u!=='string'||!u.startsWith('/')||u.startsWith('//')||u.includes('\\')||u.includes('#'))return false;
  const want='/api/n22/content/works/'+ref.workId+'/'+ref.workVersion+'/play';
  const expected=new URLSearchParams({messageId:msg,productId:p.productId,productVersion:String(p.productVersion)});
  const parsed=new URL(u,'http://127.0.0.1');
  return parsed.origin==='http://127.0.0.1'&&u.split('?')[0]===want&&parsed.pathname===want&&
    [...parsed.searchParams].length===3&&[...expected].every(([k,v])=>parsed.searchParams.getAll(k).length===1&&parsed.searchParams.get(k)===v);
}
export function projectC1Receipt(r,p,child,mid){
  if(!same(r,p)||r.requestId!==child||r.messageId!==mid||r.action!=='content.find_old_video'||
     r.source!=='studio.approved_works'||r.deliveryStatus!=='not_submitted'||r.writesPerformed!==false||r.taskId!=null)
    return fail('INVALID_CONTENT_RECEIPT');
  const ref=r.workRef;
  if(!ref&&!r.pinnedPlayUrl){
    if(r.outcome==='source_timeout')return {...fail('OLD_VIDEO_TIMEOUT'),retryable:true};
    if(['no_verified_old_clip','needs_review'].includes(r.outcome))
      return {status:r.outcome,deliveryStatus:'not_submitted',writesPerformed:false,contentRequestId:child};
  }
  if(r.outcome!=='existing_available'||r.retrievalStatus!=='playable'||r.mime!=='video/mp4'||
    !workId(ref?.workId)||!ver(ref.workVersion)||!/^[a-f0-9]{64}$/u.test(r.sha256??'')||
    !ver(r.fileBytes)||!Number.isFinite(r.durationSeconds)||r.durationSeconds<=0)return fail('INVALID_CONTENT_RECEIPT');
  if(!pinUrl(r.pinnedPlayUrl,ref,p,mid))return fail('PLAYBACK_REF_UNPINNED');
  return {status:'existing_available',retrievalStatus:'playable',deliveryStatus:'not_submitted',writesPerformed:false,
    workRef:{workId:ref.workId,workVersion:ref.workVersion},pinnedPlayUrl:r.pinnedPlayUrl,
    sha256:r.sha256,fileBytes:r.fileBytes,durationSeconds:r.durationSeconds,contentRequestId:child};
}

export function createC1SoloTurn({catalog,product,c1,messages}){
  const lookup=c1?.lookup?.bind(c1)??c1?.findExisting?.bind(c1);
  const current=(c,p)=>{
    const x=catalog.get(c,p.productId);
    return x?.productId===p.productId&&x.productVersion===p.productVersion&&(!x.shopId||x.shopId===p.shopId);
  };
  return async function route(c,x){
    const {messageId,requestId}=x;
    const meta={shopId:c.shopId,requestId,messageId};
    const stop=(status,code,message)=>({...meta,status,...(code?{code}:{}),actions:[],...(message?{message}:{})});
    const clarify=()=>stop('needs_clarification',null,'你指的是哪件？请说货号、明确名称，或回复那件商品的消息。');
    const text=x.text.normalize('NFKC').trim();
    if(text.split(/[，,。；;！？!?\n]/u).some(p=>/^\s*(?:(?:请|帮我|给我)\s*)*(?:重做|重制|重新(?:做|剪|制作)|新剪|渲染)/u.test(p)))
      return stop('unsupported',null,'这条指令没有可用的本机处理器。');
    const ask=actionsOf(text);
    if(!ask.length)return stop('unsupported',null,'这条指令没有可用的本机处理器。');
    let pin;
    try{
      const reply=x.replyToMessageId?messages.reference(c,x.replyToMessageId):null;
      if(x.replyToMessageId&&!reply)return clarify();
      const q=await product.resolve(c,{requestId,messageId,text,reference:x.replyToMessageId??null,intent:'detail'});
      if(q?.storeId!==c.shopId||q.requestId!==requestId||q.messageId!==messageId)return stop('failed','PRODUCT_LOOKUP_REJECTED');
      if(q.status==='version_conflict')return stop('failed','PRODUCT_SCOPE_OR_VERSION_CHANGED');
      if(q.status==='source_unavailable')return stop('failed','PRODUCT_LOOKUP_UNAVAILABLE');
      if(q.status!=='matched'||q.total!==1||q.cards?.length!==1)return clarify();
      // "这件手串" by itself does not select an item even when only one card
      // meets the category. A verified reply or an explicit identifier still works.
      if(!reply&&q.reason==='VERIFIED_FIELDS'&&/(?:这(?:一)?[件个条款]|本[件条款])/u.test(text))return clarify();
      const p=q.cards[0];if(!id(p.productId)||!ver(p.productVersion))return stop('failed','PRODUCT_LOOKUP_REJECTED');
      pin={shopId:c.shopId,productId:p.productId,productVersion:p.productVersion};
      if(reply&&!same(reply,pin))return clarify();
      if(!current(c,pin))return stop('failed','PRODUCT_SCOPE_OR_VERSION_CHANGED');
    }catch{return stop('failed','PRODUCT_LOOKUP_UNAVAILABLE');}
    const wantsClip=ask.includes('old_video');
    messages.setProduct(c,messageId,pin,wantsClip&&!!lookup);
    const expand=(action,part)=>({...meta,...pin,action,...part});
    const actions=[];
    if(ask.includes('quote'))actions.push(expand('quote',priceOff()));
    if(wantsClip){
      let part=fail('CONTENT_NOT_CONNECTED');
      if(lookup){
        const sub=sha(JSON.stringify([c.shopId,c.actorId,c.sessionId,requestId,messageId,'old_video'])).slice(0,32);
        try{
          const r=await lookup(c,{...pin,requestId:sub,messageId});
          if(!current(c,pin))part=fail('PRODUCT_SCOPE_OR_VERSION_CHANGED');
          else {
            part=projectC1Receipt(r,pin,sub,messageId);
            if(part.workRef)messages.setWork(c,messageId,part.workRef);
          }
        }catch(e){
          part=e?.code==='OLD_VIDEO_TIMEOUT'?{...fail('OLD_VIDEO_TIMEOUT'),retryable:true}:fail('OLD_VIDEO_TEMPORARILY_UNAVAILABLE');
        }
      }
      actions.push(expand('old_video',part));
    }
    const count=actions.filter(a=>a.status==='failed').length;
    return {...meta,...pin,status:count===actions.length?'failed':count?'partial':'completed',actions};
  };
}
