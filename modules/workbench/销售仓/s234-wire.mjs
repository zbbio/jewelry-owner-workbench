import {parseS4Text,makeDraftSource} from './s4-source.mjs';
import {createComparison,createStockS3,createReplyDraft,parseComparison} from './s234.mjs';
const rid=v=>typeof v==='string'&&/^[\p{L}\p{N}_.:-]{1,120}$/u.test(v);
const err=(code,httpStatus)=>Object.assign(Error(code),{code,httpStatus});
const confirmIntent=/提醒我|建(?:个|一条)?(?:库存核实)?待办|加到待办|记(?:下|个)库存核实/u;
const wantsStock=/库存|有货|现货|缺货|没货|售罄/u;
const writesStock=/^(?:请)?(?:把|将).{0,25}(?:库存|数量).{0,15}(?:改|调|扣|加|减)|^(?:请)?(?:修改|调整|重设|写回|扣减|更新)(?:.{0,10})(?:库存|数量)/u;
const codeOf=e=>['FORBIDDEN','TASK_PERMISSION_REQUIRED','SESSION_REQUIRED','REQUEST_REUSE_CONFLICT','PRODUCT_SCOPE_OR_VERSION_CHANGED','CONVERSATION_NOT_IN_SCOPE','DRAFT_SOURCE_REQUIRED'].includes(e?.code)?e.code:'LOCAL_SALES_SOURCE_UNAVAILABLE';
export function createS234TurnPort({product,catalog,canUse,stockTaskDb,confirmStockTask,
 readConversation,readStoreRules,readHandoff,readApprovedKnowledge,searchSupplierTier,now,readDraftSource,bindDraftMessage}={}){
  const compare=typeof catalog?.list==='function'&&createComparison({catalog,canUse:c=>canUse(c)===true});
  const stock=typeof catalog?.getSummary==='function'&&createStockS3({catalog,db:stockTaskDb,canUse:c=>canUse(c)===true,
    canCreateTask:()=>true,searchSupplierTier,now});
  const draft=typeof catalog?.get==='function'&&createReplyDraft({catalog,readConversation,readApprovedKnowledge,readStoreRules,readHandoff,now,canUse:c=>canUse(c)===true});
  return async function route(ctx,x){
    const text=x?.text;
    if(typeof text!=='string')return null;
    const draftIntent=parseS4Text(text,{referenced:!!x.replyToMessageId});
    const intent=draftIntent?'reply_draft':writesStock.test(text)?'stock_write_denied':parseComparison(text)?'compare':
      wantsStock.test(text)&&!(/多少钱|售价|价格|旧片|视频/u.test(text))?'stock':null;
    if(!intent)return null;
    if(!rid(ctx?.shopId)||!rid(ctx?.actorId)||!rid(ctx?.sessionId)||!rid(x.requestId)||!rid(x.messageId)||
       (x.replyToMessageId!=null&&!rid(x.replyToMessageId))||text.length>500||
       Object.keys(x).some(k=>!['requestId','messageId','text','replyToMessageId'].includes(k)))throw err('INVALID_REQUEST',400);
    if(await canUse(ctx)!==true)throw err('FORBIDDEN',403);
    const mint={shopId:ctx.shopId,requestId:x.requestId,messageId:x.messageId};
    if(intent==='stock_write_denied')return {...mint,status:'unsupported',code:'STOCK_WRITE_NOT_AVAILABLE',actions:[]};
    const no=(state,code,message)=>({...mint,status:state,code,actions:[],...(message?{message}:{})});
    const part=(status,out,subject)=>({...mint,...subject,status,
      actions:[{...mint,...subject,action:intent,status:out.status??out.inventoryState,result:out}]});
    try{
      let origin;
      if(draftIntent){
        const mid=x.replyToMessageId??null;
        const need=(code,m)=>no('needs_clarification',code,m);
        if(draftIntent.issue)return need(draftIntent.issue,draftIntent.issue==='DRAFT_SEND_NOT_SUPPORTED'?
          '这里只拟给店主核对的回复，不会发给顾客。请单独说明要拟什么。':'请提供一段明确的顾客原话，建议用引号标明。');
        if(mid===x.messageId)return need('DRAFT_REFERENCE_NOT_AVAILABLE','请回复同店同会话中已有的店主原话。');
        if(draftIntent.question&&mid)return need('DRAFT_SOURCE_CONFLICT','本轮新原话与引用不要同时使用，请保留一种资料来源。');
        if(draftIntent.kind==='capture'){
          if(draftIntent.command&&!/^[，。；;！？!?\s]+$/u.test(draftIntent.command))return need('DRAFT_SOURCE_REQUIRED','请单独记录原话，或注明按哪件商品拟回复。');
          return {...mint,status:'draft_source_captured',actions:[],draftSource:makeDraftSource(x.messageId,draftIntent.question),
            message:'已在当前消息登记店主提供的原话；还没有拟回复。'};
        }
        if(mid&&typeof readDraftSource==='function'){
          const r=await readDraftSource(ctx,mid);
          if(r?.status==='canceled')return need('DRAFT_REFERENCE_CANCELED','这份引用资料已取消，请在本轮重新提供顾客原话。');
          if(r?.status!=='available'||!r.source)return need('DRAFT_REFERENCE_NOT_AVAILABLE','这个引用不是本店本会话可用的顾客原话。请在本轮提供原话。');
          origin=r.source;
        }
        if(draftIntent.kind==='cancel'){
          if(!mid||!origin)return need('DRAFT_REFERENCE_NOT_AVAILABLE','请先引用同店同会话中的顾客原话，再取消。');
          return {...mint,status:'draft_source_canceled',actions:[],draftSourceCancellation:{originMessageId:origin.originMessageId},
            message:'已取消这份顾客原话作为草稿资料；它不会再被引用。'};
        }
        if(draftIntent.question)origin=makeDraftSource(x.messageId,draftIntent.question);
        if(!origin&&(!mid||typeof readConversation!=='function'))
          return need('DRAFT_SOURCE_REQUIRED','请写明顾客原话，或回复同店同会话已获准的原话消息。不会查询外部聊天。');
      }
      if(intent==='compare')return compare?part('completed',await compare(ctx,x),{}):no('failed','COMPARISON_NOT_CONNECTED');
      const f=await product.resolve(ctx,{requestId:x.requestId,messageId:x.messageId,text:draftIntent?.command||text,reference:x.replyToMessageId??null,intent:'detail'});
      if(f?.requestId!==x.requestId||f?.messageId!==x.messageId||(f.shopId??f.storeId)!==ctx.shopId)
        return no('failed','PRODUCT_LOOKUP_REJECTED');
      if(['multiple','needs_clarification','not_found'].includes(f.status))return no('needs_clarification','PRODUCT_REQUIRED','请指定要用的本店商品卡或回复本件消息。');
      if(f.status==='version_conflict'&&draftIntent)return no('needs_clarification','DRAFT_REFERENCE_CARD_CHANGED','关联的商品版本已变，请重新提供原话并指定当前卡。');
      if(f.status!=='matched'||f.total!==1||f.cards?.length!==1)return no('failed','PRODUCT_LOOKUP_UNAVAILABLE');
      const {productId,productVersion}=f.cards[0];
      const subject={productId,productVersion};
      const args={...mint,...subject};
      if(intent==='stock'){
        if(!stock)return no('failed','STOCK_NOT_CONNECTED');
        const draft=await stock(ctx,{...args,mode:'read_only',requestAlternatives:/备选|找货|换一/u.test(text)});
        if(!confirmIntent.test(text)||(!['unknown','stale'].includes(draft.inventoryState)))return part('completed',draft,subject);
        // Approval is a server-side per-command gate, not a browser mode field
        // and not inferred merely because the user text contains “确认”.
        const approved=await confirmStockTask?.(ctx,{...args,replyToMessageId:x.replyToMessageId??null});
        if(approved!==true)return part('completed',{...draft,taskStatus:'needs_owner_confirmation'},subject);
        if(!stockTaskDb)return part('completed',{...draft,taskStatus:'not_connected'},subject);
        return part('completed',{...await stock(ctx,{...args,mode:'owner_confirmed_verify_task'}),alternatives:draft.alternatives},subject);
      }
      if(!draft)return no('failed','DRAFT_CONVERSATION_NOT_CONNECTED');
      if(origin?.productId&&(origin.productId!==productId||origin.productVersion!==productVersion))
        return no('needs_clarification','DRAFT_REFERENCE_CARD_CHANGED','引用原话绑定的商品或版本不一致，请重新选定。');
      const ownerQuestion=origin?{shopId:ctx.shopId,actorId:ctx.actorId,sessionId:ctx.sessionId,
        kind:draftIntent.question?'owner_input_current_turn':'owner_input_referenced_message',
        originMessageId:origin.originMessageId,text:origin.text}:undefined;
      const out=await draft(ctx,{...args,conversationId:x.replyToMessageId??x.messageId,...(ownerQuestion?{ownerQuestion}:{})});
      // Do not return a newly generated draft if the reused source was canceled while reading the card.
      if(origin&&!draftIntent.question){
        const recheck=await readDraftSource(ctx,x.replyToMessageId);
        if(recheck?.status!=='available'||recheck.source?.originMessageId!==origin.originMessageId||recheck.source?.text!==origin.text)
          return no('needs_clarification','DRAFT_REFERENCE_CANCELED','引用资料已取消或不可用，请重新提供原话。');
      }
      await bindDraftMessage?.(ctx,x,{shopId:ctx.shopId,...subject});
      return {...part('completed',out,subject),...(origin?{draftSource:makeDraftSource(origin.originMessageId,origin.text,subject)}:{})};
    }catch(e){
       if(e?.httpStatus===403)throw e;
       if(['DRAFT_SOURCE_REQUIRED','CONVERSATION_NOT_IN_SCOPE'].includes(e?.code))
         return no('needs_clarification',e.code,'没有可用的顾客原话，请在本轮提供，或引用同店同会话消息。');
       return no('failed',codeOf(e));
    }
  };
}
