// N99 A1, album-owned server adapter. Does not choose a tool from text.
export const VERSION='n99-a1.album-classify-batch/1.0.0';
const NAME='album_classify_batch';
const DESCRIPTION='只读地按品类整理当前店主消息已获准的照片。不找同一件、不建档、不挂图。店主要求按类分照片时可调用；参数固定为 {}。没有本条已选的照片则返回 needs_photos，请让店主为本条选图，不要改用旧批次。';
export const albumClassifyBatchToolDefinition=Object.freeze({
  name:NAME,description:DESCRIPTION,strict:true,
  parameters:Object.freeze({type:'object',properties:Object.freeze({}),required:Object.freeze([]),additionalProperties:false})
});

const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const batchIdOK=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(x);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const emptyArgs=x=>isObject(x)&&[null,Object.prototype].includes(Object.getPrototypeOf(x))&&Reflect.ownKeys(x).length===0;
const scoped=(r,c,t)=>r?.storeId===c.shopId&&(!Object.hasOwn(r,'shopId')||r.shopId===c.shopId)&&
  r.requestId===t.requestId&&r.messageId===t.messageId&&r.batchId===t.batchId;
const same=(r,c,t)=>r?.shopId===c.shopId&&r?.batchId===t.batchId&&r?.messageId===t.messageId;
const effectFields=['catalogCreated','catalogUpdated','cardAssetLinksAdded'];
const readEffect=r=>isObject(r?.effects)&&effectFields.every(k=>r.effects[k]===0)&&
  !['productId','productVersion','linkedAssetIds','addedAssetIds','receipt'].some(k=>Object.hasOwn(r,k));
const batchBad='BATCH_NOT_IN_SESSION';
const sourceBad='ALBUM_CLASSIFICATION_UNAVAILABLE';
const unavailable=(base,code)=>({...base,status:'failed',code,actions:[]});
const imageLimit=12; // existing r2 HTTP organize-only intake limit
const evidenceName={pixel_rule:'pixelRule',image_inference:'imageInference',original_label:'originalLabel',human:'humanCorrection'};
const photoStatuses=new Set(['classified','suggested','pending','duplicate','unreadable','not_authorized']);
const rejectArg=()=>Object.assign(Error('ALBUM_TOOL_ARGUMENTS_NOT_EMPTY'),{code:'ALBUM_TOOL_ARGUMENTS_NOT_EMPTY',httpStatus:400});
const hostError=code=>Object.assign(Error(code),{code,httpStatus:403});

function complete(result, batch, ctx, turn){
  if(!scoped(result,ctx,turn)||result.status!=='classified_read_only'||!readEffect(result)||
    result.batchOriginMessageId!==batch.messageId||!Array.isArray(result.items)||
    result.items.length!==batch.assets.length||!isObject(result.counts))return false;
  const seen=new Set(),counts=Object.fromEntries([...photoStatuses].map(k=>[k,0]));
  for(let j=0;j<batch.assets.length;j++){
    const original=batch.assets[j],row=result.items[j],key=original?.itemId??original?.assetId;
    if(!id(key)||seen.has(key)||row?.itemId!==key||!photoStatuses.has(row.status))return false;
    seen.add(key);counts[row.status]++;
    if(row.status==='not_authorized'){
      if(row.assetId!==null||row.category!==null||row.source!==null||row.thumbnailRef!=null||
         row.evidenceRef!=null||row.evidence!=null||row.duplicateOf!=null)return false;
      continue;
    }
    if(row.assetId!==(original.assetId??null))return false;
    if(row.status==='duplicate'&&(original.status!=='duplicate'||row.duplicateOf!==original.duplicateOf))return false;
    if(row.status==='unreadable'&&original.status!=='unreadable')return false;
    if(row.status==='classified'||row.status==='suggested'){
      if(original.status!=='kept'||!id(row.category)||!Object.hasOwn(evidenceName,row.source)||!id(row.evidenceRef))return false;
      const ev=row.evidence?.[evidenceName[row.source]];
      if(ev?.source!==row.source||ev?.category!==row.category||ev?.evidenceRef!==row.evidenceRef||
         ((row.source==='pixel_rule'||row.source==='image_inference')!==(row.status==='suggested')))return false;
    }else if(row.category!==null||row.source!==null)return false;
    if(row.thumbnailRef!==undefined&&row.thumbnailRef!==
        '/api/n22/album/batches/'+turn.batchId+'/assets/'+row.assetId)return false;
  }
  return Object.entries(counts).every(([k,v])=>result.counts[k]===v);
}

// A small model output, distinct from the actual business receipt. No paths,
// image bytes, host identity, tokens, or per-photo opaque IDs are sent here.
function modelResult(receipt){
  const category=receipt.actions.find(x=>x.action==='classify')?.result;
  if(!category)return {status:receipt.status,...(receipt.code?{code:receipt.code}:{})};
  return {status:category.status,
    items:category.items.map((item,i)=>({ordinal:i+1,status:item.status,category:item.category,source:item.source})),
    counts:category.counts,effects:category.effects};
}

/**
 * album: the live r2 createAlbumRoute result.
 * classify: the product-owned r2 createProductRead(...).classify continuation.
 * authorizeTurn(ctx, pin, {signal}): host authority, not checked client fields.
 *   Must verify live owner/installation, same shop & actor, the conversation
 *   and executing run/message+request, and the admitted batch on that message.
 *   Callers must never grant via opaque IDs alone. This port has no default.
 */
export function createAlbumClassifyBatch({album,classify,authorizeTurn}={}){
  const read=album?.readAuthorizedBatch?.bind(album);
  if(typeof read!=='function'||typeof classify!=='function'||typeof authorizeTurn!=='function')
    throw new TypeError('A1 requires the deployed album, real product classifier and host turn authorization');

  function forTurn(ctx,serverTurn){
    if(ctx?.role!=='owner'||![ctx?.shopId,ctx?.actorId,ctx?.sessionId].every(id))
      throw hostError('SESSION_REQUIRED');
    if(![serverTurn?.requestId,serverTurn?.messageId,serverTurn?.conversationId,serverTurn?.runId].every(id)||
       serverTurn?.batchId!=null&&!batchIdOK(serverTurn.batchId))
      throw hostError('ALBUM_TURN_CONTEXT_REQUIRED');
    // Immutable, whitelisted copies. Never read prompt data here.
    const c=Object.freeze({shopId:ctx.shopId,actorId:ctx.actorId,sessionId:ctx.sessionId,role:'owner'});
    const t=Object.freeze({requestId:serverTurn.requestId,messageId:serverTurn.messageId,conversationId:serverTurn.conversationId,
      runId:serverTurn.runId,batchId:serverTurn.batchId??null});
    const base=Object.freeze({shopId:c.shopId,requestId:t.requestId,messageId:t.messageId,conversationId:t.conversationId,runId:t.runId});
    async function run(args={}, {signal}={}){
      if(!emptyArgs(args))throw rejectArg();
      signal?.throwIfAborted();
      try {
        const permit=async()=>{
          const ok=await authorizeTurn(c,t,{signal});
          signal?.throwIfAborted();
          return ok===true;
        };
        if(!await permit())return unavailable(base,batchBad);
        if(t.batchId===null)return {...base,status:'needs_photos',actions:[]};
        const b=await read(c,t.batchId);
        if(!same(b,c,t)||!id(b.requestId)||!Array.isArray(b.assets)||!b.assets.length||b.assets.length>imageLimit)
          return unavailable(base,batchBad);
        // Read-only category handler, never the HTTP route's import / review / handoff entry.
        const r=await classify(c,{requestId:t.requestId,messageId:t.messageId,batchId:t.batchId});
        if(!await permit())return unavailable(base,batchBad);
        if(!scoped(r,c,t))return unavailable(base,sourceBad);
        if(r.status==='not_found')return unavailable(base,batchBad);
        if(!complete(r,b,c,t))return unavailable(base,sourceBad);
        return {...base,status:'completed',actions:[{shopId:c.shopId,requestId:t.requestId,messageId:t.messageId,
          action:'classify',batchId:t.batchId,status:r.status,result:r}]};
      }catch(e){
        if(signal?.aborted)signal.throwIfAborted();
        return unavailable(base,sourceBad);
      }
    }
    return Object.freeze({invoke:run});
  }

  // Sales supplies the already installed SDK's tool() and records the real
  // receipt in its server-side run ledger before returning the short tool text.
  function sdkTool({tool,ctx,turn,onReceipt,signal}={}){
    if(typeof tool!=='function'||typeof onReceipt!=='function')throw new TypeError('A1 SDK tool and receipt sink required');
    const call=forTurn(ctx,turn);
    return tool({
      ...albumClassifyBatchToolDefinition,
      parameters:{type:'object',properties:{},required:[],additionalProperties:false},
      errorFunction:()=>JSON.stringify({status:'failed',code:'ALBUM_TOOL_CALL_REJECTED'}),
      async execute(args,_runtime,details){
        const receipt=await call.invoke(args,{signal});
        signal?.throwIfAborted();
        // ToolCallDetails can be omitted in direct SDK dispatch. Sales' real Runner supplies the actual call ID.
        await onReceipt(receipt,details);
        return JSON.stringify(modelResult(receipt));
      }
    });
  }
  return Object.freeze({definition:albumClassifyBatchToolDefinition,version:VERSION,forTurn,sdkTool});
}
