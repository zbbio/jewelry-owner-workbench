import {createS4MessagePresenter} from './s4-message-view.mjs';
import {createS4EvidenceTurn} from './s4-evidence.mjs';
export {createLocalS4EvidenceIndex,parseS4EvidenceIntent} from './s4-evidence.mjs';
import {createS3StockTasks,stockReminderIntent} from './s3-stock-tasks.mjs';
export {createS3StockTasks,stockReminderIntent} from './s3-stock-tasks.mjs';
import {createS4MessageSource,parseS4Text} from './s4-source.mjs';
export {parseS4Text} from './s4-source.mjs';
import {getG2Runtime} from './g2-provider.mjs';
export {createG2ProviderMount} from './g2-provider.mjs';
import {parseD3CaptionCommand} from './d3-caption-command.mjs';
import {createD3TurnPort} from './d3-turn.mjs';
import {createS234TurnPort} from './s234-wire.mjs';
import {parseComparison} from './s2-conditions.mjs';
export {parseComparison} from './s2-conditions.mjs';
import { createSalesS1, createSdkQuote } from './s1.mjs';
const key=(ctx,m)=>JSON.stringify([ctx.shopId,ctx.actorId,ctx.sessionId,m]);
import {readRecordedPrice} from './price-source.mjs';
export {readRecordedPrice} from './price-source.mjs';
const roles=c=>c?.role==='owner'&&typeof c?.sessionId==='string'&&c.sessionId.length>0;
export function createSalesMessageLedger({limit=256}={}) {
  const rows=new Map();
  const verifyBase=c=>typeof c?.sessionId==='string'&&c.sessionId.length>0;
  return Object.freeze({
    bind(ctx,x,pin,acts){
      if(!verifyBase(ctx)||pin.shopId!==ctx.shopId||rows.size>=limit)throw Object.assign(Error('MESSAGE_LEDGER_UNAVAILABLE'),{httpStatus:503});
      const n=key(ctx,x.messageId);if(rows.has(n))throw Object.assign(Error('MESSAGE_REUSE_CONFLICT'),{httpStatus:409});
      rows.set(n,{shopId:pin.shopId,productId:pin.productId,productVersion:pin.productVersion,allowOldVideo:acts.includes('old_video')});
    },
    read(ctx,messageId){const r=verifyBase(ctx)?rows.get(key(ctx,messageId)):null;return r?structuredClone(r):null;},
    pin(ctx,x,work){
      const row=rows.get(key(ctx,x.messageId));
      if(!row||row.pinnedWorkRef&&(row.pinnedWorkRef.workId!==work.workId||row.pinnedWorkRef.workVersion!==work.workVersion))
        throw Object.assign(Error('WORK_PIN_CONFLICT'),{httpStatus:409});
      row.pinnedWorkRef=structuredClone(work);
    },
    // Once real persistence is supplied by the conversation owner, keep this scope and the same work pin on restart.
    authorize(ctx,{messageId,signal}){signal?.throwIfAborted();return this.read(ctx,messageId);}
  });
}
export function createN22SalesAdapter({product,catalog,findExisting,c1,networkPolicy='disabled',messageLedger=createSalesMessageLedger(),
  releaseGate,quote,canUse=roles,supplemental,d3,g2Provider,stockReminders,evidenceIndex}={}) {
  if(typeof product?.resolve!=='function'||typeof catalog?.get!=='function')throw new TypeError('P1 catalog ports required');
  // The third argument is a server-only authorization callback; the content
  // factory can wire it into C1. Never pass identity/permissions via body.
  const lookup=c1?.lookup?.bind(c1)??findExisting;
  const g2=networkPolicy==='approved_backend_only'?getG2Runtime(g2Provider):null;
  const s=createSalesS1({
    catalog:{
      async resolve(ctx,input){
        const r=await product.resolve(ctx,{requestId:input.requestId,messageId:input.messageId,text:input.text,
          reference:input.replyToMessageId,intent:'detail'});
        if(!r||(r.shopId??r.storeId)!==ctx.shopId||r.requestId!==input.requestId||r.messageId!==input.messageId)return null;
        const row=r.cards?.[0];
        if(r.status==='matched'&&r.cards?.length===1&&r.total===1)return {status:'resolved',shopId:ctx.shopId,...row};
        return {status:({multiple:'ambiguous',needs_clarification:'unspecified',not_found:'not_found'})[r.status]??r.status};
      },
      get(ctx,id){
        const c=catalog.get(ctx,id);
        return c&&(c.shopId===undefined||c.shopId===ctx.shopId)?{shopId:ctx.shopId,productId:c.productId,productVersion:c.productVersion,quote:readRecordedPrice(c)}:null;
      }
    },
    content:typeof lookup!=='function'?null:{async lookupOldVideo(ctx,m){
      const input={requestId:m.requestId,messageId:m.messageId,productId:m.productId,productVersion:m.productVersion};
      const r=await lookup(ctx,input,(c,x)=>messageLedger.authorize(c,x));
      if(!r)throw Object.assign(Error('CONTENT_NOT_CONNECTED'),{code:'CONTENT_NOT_CONNECTED'});
      if(r.action!=='content.find_old_video'||r.source!=='studio.approved_works'||r.messageId!==m.messageId||r.taskId!=null||
          r.writesPerformed===true||(r.shopId!==undefined&&r.shopId!==ctx.shopId))return null;
      // C1 returns no shopId/writesPerformed on its wire shape. The same-store
      // scoped helper proved identity internally; this adaptor classifies the
      // known read-only C1 operation, not a creation receipt.
      return {...r,shopId:ctx.shopId,writesPerformed:false};
    }},
    quote:g2?.quote??(networkPolicy==='disabled'?quote:undefined)??createSdkQuote({getApiKey:()=>null}),
    releaseGate:g2?.releaseGate??releaseGate,canUse,bindMessage:(...v)=>messageLedger.bind(...v),storeWorkPin:(...v)=>messageLedger.pin(...v)
  });
  const stockTasks=stockReminders?createS3StockTasks({...stockReminders,product,catalog,canUse,messageLedger}):null;
  // The old test-only confirm callback no longer grants writes to the mounted
  // ordinary sales factory; all writes must use the persistent S3 service.
  const next=createS234TurnPort({product,catalog,canUse,...(supplemental??{}),stockTaskDb:null,confirmStockTask:undefined,
    readDraftSource:createS4MessageSource({restore:messageLedger.restore,isCanceled:messageLedger.isDraftSourceCanceled}),
    bindDraftMessage:typeof messageLedger.bind==='function'?(c,x,p)=>messageLedger.bind(c,x,p,[]):undefined});
  const evidenceTurn=createS4EvidenceTurn({index:evidenceIndex,product,catalog,canUse});
  const contentTurn=createD3TurnPort({...d3,product,catalog,canUse,messageLedger});
  const presentMessage=createS4MessagePresenter({index:evidenceIndex,catalog,canUse,restore:messageLedger.restore});
  return {readReference:(ctx,messageId)=>messageLedger.read(ctx,messageId),presentMessage,
    // Older local callers: accept only a selector, never their receipt fields.
    refreshEvidenceReceipt:(ctx,r)=>r==null?r:presentMessage(ctx,{messageId:r.messageId,requestId:r.requestId,replay:r.replay}),
    ...(stockTasks?{listTasks:stockTasks.listTasks,assertStockAccess:stockTasks.assertAccess}:{}),async executeTurn(ctx,input) {
    try{
      // Caption is literal data, even if it mentions price, care or sending.
      if(typeof input?.text==='string'&&parseD3CaptionCommand(input.text))return await contentTurn(ctx,input);
      if(parseS4Text(input?.text,{referenced:!!input?.replyToMessageId}))return await evidenceTurn.draft(ctx,await next(ctx,input));
      // Explicit comparison remains a single local read—even if there
      // is an unrecognized condition or the text mentions another ability.
      if(parseComparison(input?.text))return await next(ctx,input);
      const known=await evidenceTurn.turn(ctx,input,(c,x)=>s.run(c,x));if(known)return known;
      if(stockTasks&&stockReminderIntent(input?.text))return await stockTasks.executeTurn(ctx,input);
      if(!stockTasks&&['confirm','cancel'].includes(stockReminderIntent(input?.text))){
        return {shopId:ctx.shopId,requestId:input.requestId,messageId:input.messageId,status:'unsupported',
          code:'STOCK_REMINDER_NOT_MOUNTED',message:'本店尚未接通可确认的库存核实待办；没有建立待办。',actions:[]};
      }
      return await contentTurn(ctx,input)??await next(ctx,input)??await s.run(ctx,input);
    }catch(e){if(Number.isInteger(e?.status))e.httpStatus=e.status;throw e;}
  }};
}
