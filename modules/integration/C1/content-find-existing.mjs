import {createC1} from './c1-old-video.mjs';

const name='content_find_existing';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u.test(x);
const clipId=x=>id(x)&&!x.includes(':')&&!x.includes('..');
const ver=x=>Number.isSafeInteger(x)&&x>=1&&x<=999999999;
const ident=['shopId','actorId','sessionId'];
const card=['shopId','productId','productVersion'];
const work=['workId','workVersion'];
const same=(a,b,keys)=>!!a&&!!b&&keys.every(k=>a[k]===b[k]);
const pick=(a,keys)=>Object.fromEntries(keys.map(k=>[k,a[k]]));
const plain=x=>!!x&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const closedError=(code='CONTENT_LOOKUP_NOT_AUTHORIZED',httpStatus=403)=>Object.assign(Error(code),{code,httpStatus});

export const contentFindExistingBinding=Object.freeze({
  name,version:'n99.c1.v1',
  description:'只在店主明确要找、看或回看本件已经采用的旧片时使用。可给本话题中提到的对象或所回复的本件；不猜商品。可选作品版本。此工具不读售价、不准备、不制作、不渲染、不发布。仅问价、想新做或归属不明时不要拿旧片代替。',
  parameters:Object.freeze({type:'object',additionalProperties:false,required:['productRef','workVersion'],
    properties:{productRef:{type:['string','null'],description:'店主提到的本件货号、别名或简短文字；本话题有明确引用时可为 null。',minLength:1,maxLength:128},
      workVersion:{type:['integer','null'],minimum:1,maximum:999999999,description:'仅店主指定作品版时填写；否则为 null。'}}})
});

function argsOf(o){
  if(!plain(o)||Object.keys(o).some(k=>!['productRef','workVersion'].includes(k))||
     (o.productRef!=null&&(typeof o.productRef!=='string'||!o.productRef.trim()||o.productRef.length>128||/[\u0000-\u001f\u007f]/u.test(o.productRef)))||
     (o.workVersion!=null&&!ver(o.workVersion)))throw closedError('CONTENT_LOOKUP_INVALID_INPUT',400);
  return {productRef:o.productRef?.trim()??null,workVersion:o.workVersion??null};
}
function scopeOf(c,t){
  if(c?.role!=='owner'||!ident.every(k=>id(c[k])))throw closedError();
  if(!['conversationId','messageId','requestId'].every(k=>id(t?.[k]))||
     (t.replyToMessageId!=null&&(!id(t.replyToMessageId)||t.replyToMessageId===t.messageId))||
     (c.conversationId!=null&&c.conversationId!==t.conversationId))throw closedError('CONTENT_TURN_SCOPE_INVALID',400);
  return [Object.freeze({...pick(c,ident),role:'owner'}),Object.freeze({...pick(t,['conversationId','messageId','requestId']),
    ...(t.replyToMessageId!=null?{replyToMessageId:t.replyToMessageId}:{})})];
}
function pinnedUrl(b,w){
  const base='/api/n22/content/works/'+w.workId+'/'+w.workVersion+'/play?';
  const q=new URLSearchParams({messageId:b.messageId,productId:b.productId,productVersion:String(b.productVersion)});
  return base+q.toString();
}
export function createContentFindExistingTool({studio,canUse,resolveProduct,commitPlayback,authorizePlayback,deadlineMs=4200}={}){
  if(typeof studio?.listWorks!=='function'||typeof studio?.openOldVideo!=='function'||
     ![canUse,resolveProduct,commitPlayback,authorizePlayback].every(f=>typeof f==='function')||
     !Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>30000)throw TypeError('C1 read and owner message ports required');
  // Only capture the original adopted-work authority, never production ports.
  const readStudio=Object.freeze({listWorks:studio.listWorks.bind(studio),openOldVideo:studio.openOldVideo.bind(studio)});
  async function execute(ctx,turn,input={}){
    const [c,t]=scopeOf(ctx,turn), a=argsOf(input);
    if(await canUse(c,t)!==true)throw closedError();
    let key=null;
    const out=(outcome,code,extras={},ui={})=>{
      const publicFacts={outcome,deliveryStatus:'not_submitted',...(code?{code}:{}),
        ...(key?pick(key,['productId','productVersion']):{}),...extras};
      return {modelResult:{...publicFacts},receipt:{...t,shopId:c.shopId,...publicFacts,
        action:'old_video',status:outcome,source:'studio.approved_works',writesPerformed:false,...ui}};
    };
    let p;
    try{p=await resolveProduct(c,{...t,productRef:a.productRef});}
    catch{return out('source_unavailable','PRODUCT_SOURCE_UNAVAILABLE');}
    if(p?.status==='source_unavailable')return out('source_unavailable','PRODUCT_SOURCE_UNAVAILABLE');
    if(!['matched','resolved'].includes(p?.status)||p.shopId!==c.shopId||!id(p.productId)||!ver(p.productVersion))
      return out('needs_clarification','CONTENT_PRODUCT_REFERENCE_REQUIRED');
    key=Object.freeze(pick(p,card));
    const q=Object.freeze({...t,...key});
    try{
      const previous=await authorizePlayback(c,q);
      if(previous!=null&&(!same(previous,key,card)||previous.allowOldVideo!==true))
        return out('needs_review','MESSAGE_PRODUCT_NOT_AVAILABLE');
      // A read-only scoped lease is consumed only by C1.lookup on this call.
      // It never enables the HTTP route. A prior host pin cannot silently change.
      const c1=createC1({studio:readStudio,deadlineMs,authorizeMessage:(candidate,x)=>
        same(candidate,c,ident)&&x.messageId===t.messageId?
          {...key,allowOldVideo:true,...(previous?.pinnedWorkRef?{pinnedWorkRef:previous.pinnedWorkRef}:{})}:null});
      const b=await c1.lookup(c,q);
      if(!same(b,{...t,...key},[...card,'messageId','requestId']))
        return out('source_unavailable','OLD_VIDEO_SOURCE_UNAVAILABLE');
      if(b.outcome==='source_timeout')return out('source_timeout','OLD_VIDEO_TIMEOUT',{retryable:true});
      if(b.outcome==='no_verified_old_clip')return out(b.outcome);
      if(b.outcome==='needs_review')return out(b.outcome,'OLD_VIDEO_APPROVAL_OR_FILE_NEEDS_REVIEW');
      if(b.outcome!=='existing_available'||!clipId(b.workRef?.workId)||!ver(b.workRef?.workVersion)||
         b.retrievalStatus!=='playable'||b.mime!=='video/mp4'||!Number.isSafeInteger(b.fileBytes)||b.fileBytes<1||
         !/^[a-f0-9]{64}$/u.test(b.sha256)||!Number.isFinite(b.durationSeconds)||b.durationSeconds<=0)
        return out('source_unavailable','OLD_VIDEO_SOURCE_UNAVAILABLE');
      const w=Object.freeze(pick(b.workRef,work));
      if(a.workVersion!=null&&a.workVersion!==w.workVersion)
        return out('needs_review','REQUESTED_WORK_VERSION_NOT_ADOPTED');
      const url=pinnedUrl(q,w);
      if(b.pinnedPlayUrl!==url)return out('source_unavailable','OLD_VIDEO_SOURCE_UNAVAILABLE');
      if(await canUse(c,t)!==true)return out('needs_review','CONTENT_LOOKUP_NOT_AUTHORIZED');
      // Host only: verify/snapshot the same live ordinary turn; persist its
      // playback capability + exact version pin together, with no business writes.
      if(await commitPlayback(c,Object.freeze({...q,workRef:w}))!==true)
        return out('needs_review','CONTENT_PLAYBACK_NOT_AUTHORIZED');
      const live=await authorizePlayback(c,q);
      if(!same(live,key,card)||live.allowOldVideo!==true||!same(live.pinnedWorkRef,w,work)||await canUse(c,t)!==true)
        return out('needs_review','CONTENT_PLAYBACK_NOT_AUTHORIZED');
      return out('existing_available',null,{workRef:w,retrievalStatus:'playable'},
        {pinnedPlayUrl:url,mime:b.mime,fileBytes:b.fileBytes,durationSeconds:b.durationSeconds,sha256:b.sha256});
    }catch(e){
      if(e.code==='OLD_VIDEO_TIMEOUT')return out('source_timeout','OLD_VIDEO_TIMEOUT',{retryable:true});
      if(['PRODUCT_VERSION_CONFLICT','MESSAGE_SCOPE_CONFLICT','MESSAGE_WORK_CONFLICT','MESSAGE_PRODUCT_NOT_AVAILABLE'].includes(e.code))
        return out('needs_review',e.code);
      return out('source_unavailable','OLD_VIDEO_SOURCE_UNAVAILABLE');
    }
  }
  return Object.freeze({...contentFindExistingBinding,execute});
}
