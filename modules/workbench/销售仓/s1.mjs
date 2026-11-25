import { createHash } from 'node:crypto';
import { makeTurnService } from './dist/agent.js';

const id = x => typeof x === 'string' && /^[\p{L}\p{N}_.:-]{1,120}$/u.test(x);
const ver = x => Number.isSafeInteger(x) && x > 0;
const sourceName = x => typeof x === 'string' && /^[\p{L}\p{N}_.:/-]{1,80}$/u.test(x);
const digest = x => createHash('sha256').update(x).digest('hex');
const fault = (code, status = 400) => Object.assign(new Error(code), { code, status });
const quoteWords = /多少钱|多少元|怎么卖|什么价|问价|询价|售价|卖价|价格|报价|(?:的价|价和片|价与片|价、片|价和视频)/u;
const prior = /(?:以前|以往|之前|原来|先前|上回|上次)(?:的|那[条段个部]|[这那]次){0,3}/.source;
const video = /(?:视频|短片|片子|实拍)/.source;
const clipWords = new RegExp('旧(?:片|视频)|原(?:片|视频)|已有视频|'+prior+'(?:旧)?'+video+
  '|上次.{0,7}(?:视频|那条|那段)|(?:看看|看|找|给我).{0,14}'+video+'|价[和与、](?:片|视频)|片(?:也|都)?给我','u');
// Scope refusals by their target. A plain “不问” is enough; no creation
// is independent of no lookup.
const no = /(?:先\s*)?(?:不(?:需要|要|用|必|想)?|别|无需|无须)\s*(?:再\s*)?/.source;
const readVerb = /(?:看看|看|寻找|找|调取|调|取|查看|查询|查|问|报|询|拿|要|给(?:我)?|播放)/.source;
const priceTarget = /(?:多少钱|多少元|怎么卖|什么价|售价|卖价|价格|报价|问价|询价|价)/.source;
const videoTarget = /(?:旧(?:片|视频)|原(?:片|视频)|视频|短片|片子|实拍|片)/.source;
const gap = /(?:(?!(?:看看|寻找|找|调取|查看|查询|查|问|不|别|无需|无须|(?:新|重)?做|制作|拍摄)).){0,22}?/.source;
const lead = /(?:先\s*)?/.source+'(?:'+/(?:不要|不用|不必|不需要|不想|无需|无须)\s*(?:再\s*)?/.source+
  '(?:'+readVerb+')?|(?:不|别)\\s*(?:再\\s*)?'+readVerb+')';
const negatedBefore = new RegExp(lead+'\\s*'+gap+'(?:('+priceTarget+')|('+videoTarget+'))','gu');
const negatedAfter = new RegExp(/^(\s|同样|也|都|均|全)*/.source+no+readVerb+
  /(?:了|吧|呢|哈|也|$|(?=[^\p{Script=Han}\w]))/.source,'u');
const mention = new RegExp('('+priceTarget+')|('+videoTarget+')','gu');
const sharedNegative = new RegExp('(?:都|均|全)\\s*'+no+'(?:'+readVerb+')?','u');
const splitClause = /[，,。；;！？!?\n]|(?:但是|但|而是|反而|还是|只(?:想|要|需)?)(?=\s*(?:查询|查|看|找|取|调|问|报|给|播放))|也(?=\s*(?:不|别|无需|无须))/u;
function actionsOf(text) {
  const parts = text.split(splitClause).map(s => s.trim()).filter(Boolean);
  if (parts.some(s => /^(?:请)?(?:确认|批准|同意|发布|发送|改价|修改|去做|建草稿)|(?:把|将).{0,14}(?:价格|售价).{0,6}(?:改|设|调)|^(?!别|不|先别|先不)(?:请)?(?:帮我|给我)?(?:新建|新做|制作|拍摄|重剪)/u.test(s))) return [];
  const yes = new Set(), denied = new Set();
  const deny = m => denied.add(m[1]?'quote':'old_video');
  for (const p of parts) {
    // Earlier positive mentions of an action never override an explicit veto
    // in this turn, in particular a veto of a potentially billed price lookup.
    for (const m of p.matchAll(negatedBefore)) {
      deny(m);
      const joined=p.slice(m.index+m[0].length).match(/^\s*(?:和|与|跟|以及|及|、)\s*(.*)$/u);
      if(joined){
        for(const t of joined[1].matchAll(mention)) {
          if(t.index<=15&&!/找|查|问|看|给/u.test(joined[1].slice(0,t.index)))deny(t);
          break;
        }
      }
    }
    for(const m of p.matchAll(mention)){
      if(negatedAfter.test(p.slice(m.index+m[0].length)))deny(m);
    }
    const all=p.search(sharedNegative);
    if(all>0){
      const objects=p.slice(0,all);
      if(/和|与|跟|以及|及|、/u.test(objects))for(const m of objects.matchAll(mention))deny(m);
    }
    if(quoteWords.test(p))yes.add('quote');
    if(clipWords.test(p)&&!/^(?:先)?(?:不(?:要|用|必|需要|想)?|别|无需)(?:再)?(?:新做|做|制作|新建|重做|重剪|拍摄)/u.test(p))yes.add('old_video');
  }
  return ['quote','old_video'].filter(a=>yes.has(a)&&!denied.has(a));
}

function scopeFor(ctx) {
  if (!ctx || !id(ctx.shopId) || !id(ctx.actorId) || !id(ctx.sessionId)) throw fault('UNAUTHENTICATED', 401);
  return Object.freeze({shopId:ctx.shopId, actorId:ctx.actorId, sessionId:ctx.sessionId,...(id(ctx.role)?{role:ctx.role}:{})});
}
function parseInput(x) {
  if (!x || Object.keys(x).some(k=>!['requestId','messageId','text','replyToMessageId'].includes(k)) ||
      !id(x.requestId) || !id(x.messageId) || x.replyToMessageId != null && !id(x.replyToMessageId) ||
      typeof x.text !== 'string' || !x.text.trim() || [...x.text.trim()].length>500 ||
      /(?:sk-[a-z0-9_-]{12,}|-----BEGIN [^-]*PRIVATE KEY|data:|https?:\/\/)/i.test(x.text)) throw fault('INVALID_INPUT');
  return Object.freeze({requestId:x.requestId,messageId:x.messageId,text:x.text.trim(),replyToMessageId:x.replyToMessageId??null});
}
function normalizedQuote(card) {
  const r=card.quote;
  if (!r || r.state==='unknown') return null;
  if (r.state!=='known' || r.currency!=='CNY' || !sourceName(r.source) || !id(r.field) ||
      !['string','number'].includes(typeof r.amount) || !/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(String(r.amount)) ||
      !Number.isSafeInteger(Math.round(Number(r.amount)*100))) throw fault('INVALID_QUOTE_SOURCE',502);
  return {amount:Number(r.amount).toFixed(2),currency:'CNY',field:r.field,source:r.source};
}
function checkProduct(card,ctx,want) {
  if (!card || card.shopId!==ctx.shopId || card.productId!==want.productId || card.productVersion!==want.productVersion ||
      !id(card.productId) || !ver(card.productVersion)) throw fault('PRODUCT_SCOPE_OR_VERSION_CHANGED',409);
  return Object.freeze({shopId:card.shopId,productId:card.productId,productVersion:card.productVersion,price:normalizedQuote(card)});
}
function runtimeFor(r) {
  return {source:'agents_sdk_selected_fact', sdk:r.sdk, sdkVersion:r.version, providerModel:r.model,
    providerHttpAttempts:r.httpAttempts, modelTurns:r.modelTurns,
    providerResponseHashes:(Array.isArray(r.responseIds)?r.responseIds:[]).filter(v=>typeof v==='string').map(digest)};
}
// All callers get only the same canonical field-selection utterance. Raw chat,
// actual product ID, private trace, media URL and secrets never reach the model.
export function createSdkQuote({getApiKey, modelId='deepseek-flash', transport, authorizeProvider=()=>false, authorizeAttempt, requireFixtureAuthorization=false}={}) {
  if(typeof getApiKey!=='function') throw new TypeError('server-side getApiKey required');
  if(transport!==undefined && typeof transport!=='function') throw new TypeError('invalid transport');
  const mode=transport ? 'fixture_transport' : 'deepseek';
  return Object.freeze({mode, async run(pin,ctx,meta){
    if((!transport||requireFixtureAuthorization) && await authorizeProvider(ctx,meta,pin)!==true)throw fault('PROVIDER_NOT_RELEASED',403);
    const boundedTransport=authorizeAttempt?async (url,init)=>{
      const deadline=await authorizeAttempt(ctx,meta,pin);
      if(!(deadline instanceof AbortSignal)||deadline.aborted||init?.signal?.aborted)throw fault('PROVIDER_ATTEMPT_NOT_RELEASED',403);
      const signal=init?.signal?AbortSignal.any([deadline,init.signal]):deadline;
      return (transport??globalThis.fetch)(url,{...init,signal});
    }:transport;
    let read=0;
    const perform=makeTurnService({read(token){
      if(token!=='ITEM'||++read!==1) throw fault('SDK_SCOPE_INVALID',502);
      return {productId:'ITEM',cardId:pin.productId,version:pin.productVersion,priceText:pin.price?.amount??null,size:null};
    }},{getApiKey,modelId,...(boundedTransport?{transport:boundedTransport}:{})});
    let got;
    try { got=await perform({productId:'ITEM',text:'请只查这件商品卡上登记的售价。'}); }
    catch(e) {
      if(e?.code==='MODEL_NOT_CONFIGURED')throw fault('MODEL_NOT_CONFIGURED',503);
      throw Object.assign(fault('QUOTE_TEMPORARILY_UNAVAILABLE',502),{runtime:e?.runtime ? {...runtimeFor(e.runtime),mode} : {mode, providerHttpAttempts:null}});
    }
    const r=got.runtime,t=r.toolReceipts;
    if(read!==1 || !r.live || r.sdk!=='@openai/agents' || r.httpAttempts!==2 || r.modelTurns!==2 ||
        new Set(r.responseIds).size!==2 || t.length!==1 || t[0].cardId!==pin.productId ||
        t[0].productId!=='ITEM' || t[0].version!==pin.productVersion ||
        got.evidence.length!==1 || got.evidence[0].label!=='售价' ||
        got.evidence[0].productId!=='ITEM' || got.evidence[0].value!==(pin.price ? pin.price.amount+' 元' : '待核实'))
      throw Object.assign(fault('QUOTE_TOOL_EVIDENCE_REJECTED',502),{runtime:{...runtimeFor(r),mode}});
    return {state:pin.price?'known':'unknown',price:pin.price,receipt:{...runtimeFor(r),mode,
      tool:{name:t[0].name,productId:pin.productId,productVersion:pin.productVersion}}};
  }});
}
function receipt(pin, base, action, body) {
  return {action,requestId:base.requestId,messageId:base.messageId,shopId:pin.shopId,
    productId:pin.productId,productVersion:pin.productVersion,...body};
}
function clipProject(r,p,sub,msg) {
  if (!r || r.shopId!==p.shopId || r.productId!==p.productId || r.productVersion!==p.productVersion ||
      r.requestId!==sub || (r.messageId!==undefined&&r.messageId!==msg) || r.deliveryStatus!=='not_submitted' || r.taskId!=null || r.writesPerformed!==false)
    throw fault('INVALID_CONTENT_RECEIPT',502);
  if (r.outcome==='no_verified_old_clip' && r.workRef==null && r.pinnedPlayUrl==null) {
    return {status:'no_verified_old_clip',deliveryStatus:r.deliveryStatus};
  }
  if (r.outcome==='needs_review' && r.workRef==null && r.pinnedPlayUrl==null) return {status:'needs_review'};
  const w=r.workRef;
  if(r.outcome!=='existing_available' || r.retrievalStatus!=='playable' || !id(w?.workId) || !ver(w?.workVersion) ||
      typeof r.pinnedPlayUrl!=='string' || !/^\/api\/[A-Za-z0-9_.%/-]+(?:\?[A-Za-z0-9%=&_.-]+)?$/u.test(r.pinnedPlayUrl) ||
      /(?:token|secret|credential|signature|auth)=|%2f|%5c|\.\./i.test(r.pinnedPlayUrl))
    throw fault('INVALID_CONTENT_RECEIPT',502);
  const u = new URL(r.pinnedPlayUrl,'http://127.0.0.1');
  const bind={messageId:msg,productId:p.productId,productVersion:String(p.productVersion),workId:w.workId,workVersion:String(w.workVersion)};
  const exactC1=u.pathname==='/api/content/old-video/play' && [...u.searchParams.keys()].length===5 &&
    Object.entries(bind).every(([k,v])=>u.searchParams.getAll(k).length===1&&u.searchParams.get(k)===v);
  if (u.origin!=='http://127.0.0.1'|| !(exactC1||u.pathname.includes('/'+w.workId+'/'+w.workVersion+'/'))) throw fault('PLAYBACK_REF_UNPINNED',502);
  return {status:'existing_available',retrievalStatus:'playable',deliveryStatus:r.deliveryStatus,
    workRef:{workId:w.workId,workVersion:w.workVersion},pinnedPlayUrl:r.pinnedPlayUrl,
    ...(typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256)&&ver(r.fileBytes)&&Number.isFinite(r.durationSeconds)&&r.durationSeconds>0
      ?{sha256:r.sha256,fileBytes:r.fileBytes,durationSeconds:r.durationSeconds}:{})};
}
// No implicit current/previous product. resolve() must resolve the request's
// explicit name or an authorized specific reply; a bare demonstrative cannot be resolved from a last-selected global.
const bare = /^(?:(?:请问|请|帮我|给我|我想知道)\s*)?(?:这(?:个|条|件|款|一件)|本(?:件|条|款))(?:商品|手串|珠宝)?(?:的)?(?:多少钱|什么价|什么价格|售价|价格|报价|旧片|视频|价和片)(?:[\s，。！!,?？、；]*(?:(?:也)?(?:给我|看看|给我看看|找一下|看一下|多少|呢|吧|吗))?)*$/u;
export function createSalesS1({catalog,content,quote,canUse=()=>false,releaseGate,bindMessage,storeWorkPin,maxRequests=256}={}) {
  if(typeof catalog?.resolve!=='function'||typeof catalog?.get!=='function'||typeof quote?.run!=='function'||
      !Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>8192) throw new TypeError('S1 ports required');
  const requests=new Map(), messages=new Map();
  async function execute(ctx, x) {
    const actions=actionsOf(x.text), envelope={shopId:ctx.shopId, requestId:x.requestId,messageId:x.messageId};
    if (!actions.length) return {...envelope,status:'unsupported',actions:[],message:'当前只支持只读查价或查本件旧片。'};
    const clarify=()=>({...envelope,status:'needs_clarification',actions:[],message:'你指的是哪件？请说货号、明确名称，或回复那件商品的消息。'});
    if(x.replyToMessageId==null && bare.test(x.text))return clarify();
    let pick;
    try { pick=await catalog.resolve(ctx,x); } catch { return {...envelope,status:'failed',actions:[],code:'PRODUCT_LOOKUP_UNAVAILABLE'}; }
    if (!pick || ['ambiguous','not_found','unspecified'].includes(pick.status)) return clarify();
    if(pick.status!=='resolved'||pick.shopId!==ctx.shopId||!id(pick.productId)||!ver(pick.productVersion))
      return {...envelope,status:'failed',actions:[],code:'PRODUCT_LOOKUP_REJECTED'};
    let pin;
    try { pin=checkProduct(await catalog.get(ctx,pick.productId),ctx,pick); }
    catch { return {...envelope,status:'failed',actions:[],code:'PRODUCT_SCOPE_OR_VERSION_CHANGED'}; }
    if(bindMessage) await bindMessage(ctx,x,pin,actions);
    const results=await Promise.all(actions.map(async action=>{
      try {
        if(action==='quote') {
          const q=await quote.run(pin,ctx,{requestId:x.requestId,messageId:x.messageId,inputTextSha256:digest(x.text)});
          return receipt(pin,x,action,{status:q.state,price:q.price,
            text:q.state==='known'?'卡上记录的售价是 '+q.price.amount+' 元。':'卡上没有填写售价，价格待店主核实。',
            source:{kind:'catalog_sale_price',field:q.price?.field??null,recordedSource:q.price?.source??null},
            modelReceipt:q.receipt});
        }
        if(typeof content?.lookupOldVideo!=='function')throw fault('CONTENT_NOT_CONNECTED',503);
        const sub=digest(JSON.stringify([ctx.shopId,ctx.actorId,ctx.sessionId,x.requestId,x.messageId,'old_video'])).slice(0,32);
        const r=await content.lookupOldVideo(ctx,{requestId:sub,parentRequestId:x.requestId,messageId:x.messageId,
          productId:pin.productId,productVersion:pin.productVersion});
        if(r?.outcome==='source_timeout' && r?.requestId===sub && r?.productId===pin.productId && r?.productVersion===pin.productVersion && r?.shopId===pin.shopId)
          return receipt(pin,x,action,{status:'failed',code:'OLD_VIDEO_TIMEOUT',retryable:true});
        const part=clipProject(r,pin,sub,x.messageId);
        if(part.workRef&&storeWorkPin) await storeWorkPin(ctx,x,part.workRef);
        return receipt(pin,x,action,{contentRequestId:sub,...part});
      } catch(e){
        const code=['INVALID_CONTENT_RECEIPT','CONTENT_NOT_CONNECTED','PLAYBACK_REF_UNPINNED','QUOTE_TOOL_EVIDENCE_REJECTED','QUOTE_TEMPORARILY_UNAVAILABLE','PROVIDER_NOT_RELEASED','MODEL_NOT_CONFIGURED'].includes(e?.code)
          ?e.code:action==='old_video'?'OLD_VIDEO_TEMPORARILY_UNAVAILABLE':'QUOTE_TEMPORARILY_UNAVAILABLE';
        return receipt(pin,x,action,{status:'failed',code,...(action==='quote'&&e?.runtime?{modelReceipt:e.runtime}:{})});
      }
    }));
    const failed=results.filter(r=>r.status==='failed').length;
    const result={...envelope,productId:pin.productId,productVersion:pin.productVersion,
      status:failed===results.length?'failed':failed?'partial':'completed',actions:results};
    if (releaseGate) await releaseGate.holdSuccessful(ctx,result);
    return result;
  }
  async function run(serverCtx,input) {
    const ctx=scopeFor(serverCtx),x=parseInput(input);
    if(await canUse(ctx)!==true)throw fault('FORBIDDEN',403);
    const prefix=JSON.stringify([ctx.shopId,ctx.actorId,ctx.sessionId]);
    const rk=prefix+'\0'+x.requestId,mk=prefix+'\0'+x.messageId;
    const old=requests.get(rk),fingerprint=digest(JSON.stringify(x));
    if(old) {
      if(old.fingerprint!==fingerprint)throw fault('REQUEST_REUSE_CONFLICT',409);
      const result=structuredClone(await old.promise);
      // Playback grants are not cached user-facing capabilities. Re-reading a
      // historical message needs a separately authorized C1 read, not a model retry.
      for(const act of result.actions) if(act.pinnedPlayUrl) {
        delete act.pinnedPlayUrl;delete act.workRef;delete act.retrievalStatus;act.status='needs_current_media_lookup';
      }
      return {...result,replay:true};
    }
    if(messages.has(mk))throw fault('MESSAGE_REUSE_CONFLICT',409);
    if(requests.size>=maxRequests)throw fault('REQUEST_LEDGER_FULL',503);
    const promise=execute(ctx,x);
    requests.set(rk,{fingerprint,promise});messages.set(mk,rk);
    return structuredClone(await promise);
  }
  return {run};
}
// The message reducer routes by independent message slots, NEVER currently active card.
export function applyS1Receipt(messages, reply) {
  if(!reply||!Array.isArray(reply.actions)||reply.actions.some(a=>!a||
    a.shopId!==reply.shopId||a.messageId!==reply.messageId||a.requestId!==reply.requestId||
    a.productId!==reply.productId||a.productVersion!==reply.productVersion))return false;
  const slot=messages.get(reply.messageId);
  if(!slot || slot.shopId!==reply.shopId || slot.requestId!==reply.requestId ||
      (slot.productId!=null && (slot.productId!==reply.productId || slot.productVersion!==reply.productVersion))) return false;
  messages.set(reply.messageId,{...slot, productId:reply.productId??null,productVersion:reply.productVersion??null,receipt:structuredClone(reply)});
  return true;
}
export { actionsOf };
