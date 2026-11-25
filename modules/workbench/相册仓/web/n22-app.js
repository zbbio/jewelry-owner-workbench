(function(){
  'use strict';
  const ROOT='/api/n22/album/batches', DRAFTS='/api/n22/album/drafts', TURN='/api/n22/turn', MSG='/api/n22/messages/',
    CHECK_CARD='/api/n22/product/resolve', CHECK_CLIP='/api/n22/content/old-video', D3_PICK='/api/n22/content/d3/selection',
    RECOVER='n22.lastOrganizedBatch', RESUME='n22.checkedMessageInThisEntry.v1';
  const id=x=>typeof x==='string'&&/^[\p{L}\p{N}_.:-]{1,180}$/u.test(x);
  const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
  const version=x=>Number.isSafeInteger(x)&&x>0;
  const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  const byteLimit=[12,8*1024*1024,36*1024*1024], validItem=['kept','duplicate','failed'];
  const categories={bracelet:'手串',bangle:'手镯',pendant:'吊坠',necklace:'项链',hand_chain:'手链',ring:'戒指',earring:'耳环'};
  const sourceLabel={original_label:'已对齐的原表标签',image_inference:'看图建议',pixel_rule:'本机像素规则建议',human:'人工确认'};
  const evidenceSlot={original_label:'originalLabel',image_inference:'imageInference',pixel_rule:'pixelRule',human:'humanCorrection'};
  const statusLabel={session_required:'请从本机配对页重新进入。',invalid_file_count:'本次请选择 1–12 张。',
    file_too_large:'单张原图不能超过 8 MiB。',batch_too_large:'本批总大小不能超过 36 MiB。',
    idempotency_conflict:'原请求已用在另一批内容上，未重复写入。',
    SALES_ADAPTER_NOT_MOUNTED:'本机文字处理尚未接通。',
    N22_AUTHORIZED_BATCH_NOT_MOUNTED:'相册批次和分类服务尚未接通。'};
  const groupErrors={
    BATCH_REFERENCE_NOT_VERIFIED:'这批照片与当前消息对不上，未修改任何商品。',
    BATCH_NOT_IN_SESSION:'本次会话找不到这条选图记录，未修改任何商品。',
    DRAFT_REFERENCE_NOT_IN_SCOPE:'本次会话找不到引用的分组消息，未改商品。',
    DRAFT_GROUP_NOT_IN_MESSAGE:'所引用的消息里没有这一组，未改商品。',
    STALE_DRAFT_REFERENCE:'这条分组已过期。请回到最新分组，而不是确认旧版本。',
    DRAFT_VERSION_CONFLICT:'分组版本已更新；请查看最新分组。未改商品。',
    GROUP_VERSION_CONFLICT:'所见分组版本已变化。这次没有写入，请按新版本重新准备。',
    STALE_OR_UNPINNED_GROUP:'原组或版本已经变了，请按最新分组重新准备。',
    DRAFT_ALREADY_SUBMITTED:'这一组已经提交或正在提交，不能通过纠正替换原图。',
    GROUP_NOT_IN_SESSION:'收到的组不在本次会话；没有从别处找组。',
    D2_GROUP_REFERENCE_REQUIRED:'请先回复显示这组照片的分组消息。',
    D2_DISPLAYED_GROUP_REQUIRED:'请回复你看到的那条分组消息，并选明哪一组。没有建档或补图。',
    D2_GROUP_MOVED:'这组照片已经整理成新版本，请引用新版。',
    D2_CONFIRM_REFERENCE_REQUIRED:'请回复待确认的商品操作消息，再输入确认或取消。',
    INTENT_NOT_IN_SESSION:'找不到本次会话里这条操作预览；未提交。',
    ASSET_CHANGED:'原图或摘要未核对；本次未写。',
    BATCH_NOT_IN_SCOPE:'这批照片不属于所引用消息；未写。',
    ASSET_OUT_OF_SCOPE_OR_REUSED:'照片不在本组的批次，或在多个组中重复。没有保存。',
    VERSION_CONFLICT:'目标商品卡版本已变。这次没有补图或覆盖原卡，请重新准备。',
    D2_TARGET_STALE:'目标卡已变更，按新版本重新准备。没有补图。',
    OWNER_CONFIRMATION_REQUIRED:'还未收到对这一项的有效确认；没有建档或补图。',
    PRODUCT_REFERENCE_REQUIRED:'请从对应的已提交商品回执点「改这件资料」，再写要改的内容。未修改商品。',
    PRODUCT_LOOKUP_REJECTED:'这条商品引用未核实或卡版已变。请从本件新版回执重新回复；本次没有取其他商品的价格。'
  };
  function thumbnail(batch,a){
    if(!id(batch)||!id(a.assetId??a.duplicateOf))return null;
    const p=ROOT+'/'+batch+'/assets/'+(a.assetId??a.duplicateOf);
    return a.thumbnailRef===p?p:null;
  }
  function batchMatches(x,p){
    if(!x||!id(x.batchId)||x.mode!=='organize_only'||!id(x.messageId)||!id(x.requestId)||
      (p.requestId!==undefined&&x.requestId!==p.requestId)||(p.messageId!==undefined&&x.messageId!==p.messageId)||
      (p.batchId!==undefined&&x.batchId!==p.batchId)||!Array.isArray(x.receipts)||x.receipts.length||
      !Array.isArray(x.items)||!x.items.length||x.items.length>byteLimit[0])return false;
    const nn={selected:x.items.length,kept:0,duplicate:0,failed:0}, seen=new Set(), assets=new Set();
    for(let i=0;i<x.items.length;i++){
      const a=x.items[i];
      if(!a||!id(a.itemId)||seen.has(a.itemId)||a.ordinal!==i||a.source!=='selected_upload'||!validItem.includes(a.status))return false;
      seen.add(a.itemId);nn[a.status]++;
      if(a.status==='kept'){
        if(!id(a.assetId)||assets.has(a.assetId)||!hex(a.sha256)||!thumbnail(x.batchId,a)||a.categoryStatus!=='pending_confirmation')return false;
        assets.add(a.assetId);
      }else if(a.status==='duplicate'){
        if(a.assetId!==undefined||a.duplicateReason!=='exact_sha256_match'||!thumbnail(x.batchId,a)||!hex(a.sha256))return false;
      }else if(a.assetId!==undefined||a.thumbnailRef!==undefined)return false;
    }
    return Object.keys(nn).every(k=>x.counts?.[k]===nn[k])&&Array.isArray(x.pendingAssetIds)&&
      x.pendingAssetIds.length===assets.size&&new Set(x.pendingAssetIds).size===assets.size&&x.pendingAssetIds.every(a=>assets.has(a));
  }
  function turnMatches(x,p){
    return x&&x.requestId===p.requestId&&x.messageId===p.messageId&&
      id(x.shopId??x.storeId)&&!(x.shopId!==undefined&&x.storeId!==undefined&&x.shopId!==x.storeId);
  }
  function matchingAction(a,r,s){
    return a?.requestId===s.requestId&&a.messageId===s.messageId&&a.shopId===(r.shopId??r.storeId)&&
      id(a.productId)&&a.productId===r.productId&&version(a.productVersion)&&a.productVersion===r.productVersion;
  }
  function clipPath(a,origin){
    const w=a?.workRef;
    if(a?.status!=='existing_available'||a.retrievalStatus!=='playable'||a.deliveryStatus!=='not_submitted'||
      !id(w?.workId)||!version(w?.workVersion)||typeof a.pinnedPlayUrl!=='string'||
      !a.pinnedPlayUrl.startsWith('/api/')||a.pinnedPlayUrl.includes('\\'))return null;
    const allowed={messageId:a.messageId,productId:a.productId,productVersion:String(a.productVersion)};
    const expected='/api/n22/content/works/'+w.workId+'/'+w.workVersion+'/play';
    try{
      const u=new URL(a.pinnedPlayUrl,origin);
      if(u.origin!==origin||u.pathname!==expected||u.hash||u.username||u.password||
        [...u.searchParams.keys()].length!==Object.keys(allowed).length||
        !Object.entries(allowed).every(([k,v])=>u.searchParams.getAll(k).length===1&&u.searchParams.get(k)===v))return null;
      return a.pinnedPlayUrl;
    }catch{return null;}
  }
  function classificationScope(p2,b,r){
    if(!p2||!b||!r)return false;
    const store=r.shopId??r.storeId;
    return id(store)&&p2.status==='classified_read_only'&&p2.batchId===b.batchId&&
      p2.messageId===r.messageId&&b.messageId===r.messageId&&p2.requestId===r.requestId&&
      (p2.shopId??p2.storeId)===store&&!(own(p2,'shopId')&&own(p2,'storeId')&&p2.shopId!==p2.storeId)&&
      Array.isArray(p2.items)&&p2.items.length<=b.items.length&&
      ['catalogCreated','catalogUpdated','cardAssetLinksAdded'].every(k=>p2.effects?.[k]===0);
  }
  function classificationReceipt(r,b,slot){
    if(!b||!turnMatches(r,slot)||!Array.isArray(r.actions))return null;
    const actions=r.actions.filter(a=>a?.action==='classify');
    if(actions.length!==1)return null;
    const a=actions[0],store=r.shopId??r.storeId;
    if([['requestId',r.requestId],['messageId',r.messageId],['batchId',b.batchId],['shopId',store],['storeId',store]]
      .some(([k,v])=>own(a,k)&&a[k]!==v))return null;
    // An explicit classify action owns the payload. A wrapper is accepted only
    // via its own result field; a present flat payload is never shadowed by it.
    const receipt=own(a,'items')?a:own(a,'result')?a.result:null;
    if(!classificationScope(receipt,b,r)||(own(a,'status')&&a.status!==receipt.status))return null;
    return receipt;
  }
  function classification(p2,b,r){
    const map=new Map();
    if(!classificationScope(p2,b,r))return map;
    const allowed=new Map(b.items.filter(x=>x.status==='kept').map(x=>[x.assetId,x.itemId]));
    const seen=new Set();
    for(const x of p2.items){
      if(!x||!allowed.has(x.assetId))continue; // duplicate/failed can have itemId and no assetId
      const asset=x.assetId;
      if(seen.has(asset)){map.delete(asset);continue;}
      seen.add(asset);
      if(own(x,'itemId')&&x.itemId!==allowed.get(asset))continue;
      if(!own(categories,x.category)||!own(evidenceSlot,x.source)||!id(x.evidenceRef))continue;
      const suggested=x.source==='image_inference'||x.source==='pixel_rule';
      const ev=x.evidence?.[evidenceSlot[x.source]];
      if(x.status!==(suggested?'suggested':'classified')||!ev||
         ev.source!==x.source||ev.category!==x.category||ev.evidenceRef!==x.evidenceRef)continue;
      if(x.source==='image_inference'&&(!id(ev.modelId)||!id(ev.modelVersion)))continue;
      if(x.source==='pixel_rule'&&(ev.decoded!==true||ev.confidence!=='heuristic_strong'||
         !id(ev.ruleId)||!id(ev.ruleVersion)||!/^PIXEL_[A-Z_]{1,64}$/.test(ev.reason??'')))continue;
      map.set(asset,x);
    }
    return map;
  }
  const salesKinds=['compare','stock','reply_draft'];
  const salesNames={compare:'按预算选货',stock:'本件库存',reply_draft:'客人回复草稿'};
  const prices=['retailPrice','salePrice','price'];
  const factLabels={material:'材质',color:'颜色',size:'尺寸',beadDiameter:'珠径'};
  const factSource={manual:'店主登记',imported:'已导入卡片资料'};
  const taskText={not_requested:'本次只查库存，未建待办。',needs_owner_confirmation:'待店主确认是否建立核实待办；尚未建立。',
    not_connected:'核实待办尚未接通，未建立。',not_needed_current_stock_verified:'已有有效库存记录，无需建立待办。',
    created:'已建立库存核实待办。',existing_open_task:'沿用已有的库存核实待办。',replayed:'回读原库存核实待办。'};
  const saleErrors={DRAFT_CONVERSATION_NOT_CONNECTED:'尚无可用的会话资料入口，未生成、未发送回复。',
    CONVERSATION_REFERENCE_REQUIRED:'请先引用本次获准的客人会话，再起草回复。没有发送任何内容。',
    CONVERSATION_NOT_IN_SCOPE:'没有可访问的本件会话资料；未生成、未发送回复。',
    PRODUCT_REQUIRED:'请说货号或引用核实过的商品消息，再继续。',
    LOCAL_SALES_SOURCE_UNAVAILABLE:'本机销售资料暂不可用；没有可核实的结果。',
    STOCK_NOT_CONNECTED:'库存来源尚未接通，库存待核实。',
    STOCK_WRITE_NOT_AVAILABLE:'这里仅查库存或准备核实，不修改库存数量。',
    COMPARISON_NOT_CONNECTED:'本店目录尚未接通，无法核实候选。'};
  const money=v=>v!==null&&v!==undefined&&/^(?:0|[1-9][0-9]{0,10})(?:[.][0-9]{1,2})?$/.test(String(v));
  const bounded=(v,n=260)=>typeof v==='string'&&v.trim()&&v.length<=n;
  const knownPrice=p=>p?.state==='known'&&p.currency==='CNY'&&money(p.amount)&&prices.includes(p.field)&&own(factSource,p.source);
  function salesResult(action,r,s){
    if(!salesKinds.includes(action?.action)||!turnMatches(r,s))return null;
    const store=r.shopId??r.storeId, a=action, v=a.result;
    if(!v||a.requestId!==s.requestId||a.messageId!==s.messageId||a.shopId!==store||
      v.requestId!==s.requestId||v.messageId!==s.messageId||(v.shopId??v.storeId)!==store||
      (own(v,'shopId')&&own(v,'storeId')&&v.shopId!==v.storeId))return null;
    if(a.action==='compare'){
      if(!['completed','no_confirmed_match','catalog_unavailable','needs_clarification'].includes(v.status)||
        a.status!==v.status||!Array.isArray(v.items)||v.items.length>3)return null;
      if(v.status==='completed'){
        if(!v.items.length||!money(v.criteria?.budgetYuan)||
          v.items.some(x=>!id(x?.productId)||!version(x.productVersion)||!knownPrice(x.price)||
           (own(x,'shopId')&&x.shopId!==store)||Number(x.price.amount)>Number(v.criteria.budgetYuan))||
          new Set(v.items.map(x=>x.productId)).size!==v.items.length)return null;
      }else if(v.items.length)return null;
    }else{
      if(!matchingAction(a,r,s)||v.productId!==a.productId||v.productVersion!==a.productVersion)return null;
      if(a.action==='stock'){
        if(a.status!==v.inventoryState||!['unknown','stale','in_stock','out_of_stock'].includes(v.inventoryState)||
          !own(taskText,v.taskStatus)||v.notified!==false)return null;
        const ev=v.inventoryEvidence;
        if(v.inventoryState!=='unknown'&&(!ev||!['in_stock','out_of_stock'].includes(ev.status)||
          (v.inventoryState!=='stale'&&ev.status!==v.inventoryState)||!bounded(ev.verifiedAt,48)||
          !bounded(ev.verifiedBy,120)||!bounded(ev.evidenceRef,128)))return null;
        if(['created','existing_open_task','replayed'].includes(v.taskStatus)!==id(v.taskId))return null;
      }else if(a.status!=='owner_draft_only'||v.status!==a.status||v.deliveryStatus!=='not_submitted'||
        v.sent!==false||v.orderOrPurchaseInferred!==false||!Array.isArray(v.suggestions)||
        !v.suggestions.length||v.suggestions.length>12||v.suggestions.some(x=>!bounded(x))||
        !Array.isArray(v.customerSaid)||v.customerSaid.length>5||
        v.customerSaid.some(x=>!id(x?.messageId)||!bounded(x.text))||
        !Array.isArray(v.unanswered)||v.unanswered.length>12||v.unanswered.some(x=>!bounded(x)))return null;
    }
    return v;
  }
  const messageIdOK=x=>typeof x==='string'&&/^[\w.:-]{1,128}$/u.test(x);
  const p1Fields={title:'名称',category:'品类',material:'材质',color:'颜色',size:'尺寸',beadDiameter:'珠径'};
  const p1Root={matched:'completed',multiple:'needs_clarification',not_found:'completed',
    needs_clarification:'needs_clarification',source_unavailable:'failed',version_conflict:'failed'};
  const p1Unsafe=/(?:[<>\u0000-\u001f\u007f]|https?:|[A-Za-z]:[\\/]|@|\b1[3-9]\d{9}\b|\bsk[-_]\w+|￥|¥|\d\s*元|[万千百]元|人民币|\bCNY\b|\bRMB\b|报价|售价|价格|成本|视频|短片|旧片|原片)/iu;
  const p1Safe=v=>bounded(v,96)&&!p1Unsafe.test(v);
  const p1Unit=/^(?:mm|cm|m|毫米|厘米|米|公分|英寸|in)$/iu;
  const p1Dimension=x=>typeof x==='number'&&Number.isFinite(x)&&x>0||
    typeof x==='string'&&/^\d{1,6}(?:\.\d{1,4})?(?:\s*[x×]\s*\d{1,6}(?:\.\d{1,4})?){0,2}$/iu.test(x)&&
      Number(x.split(/[x×]/iu)[0])>0;
  const hasP1=r=>Array.isArray(r?.actions)&&r.actions.some(a=>a?.action==='product_read');
  function p1Card(card,shop){
    const {productId,productVersion,source,materialStatus}=card??{};
    if(!messageIdOK(productId)||!version(productVersion)||source?.system!=='catalog'||
      source.productId!==productId||source.productVersion!==productVersion||
      (own(card,'shopId')&&card.shopId!==shop)||(own(source,'shopId')&&source.shopId!==shop)||
      !card.fields||typeof card.fields!=='object'||Array.isArray(card.fields)||
      !Array.isArray(card.missingFields)||new Set(card.missingFields).size!==card.missingFields.length||
      card.missingFields.some(k=>!own(p1Fields,k)||own(card.fields,k))||
      !['recorded','pending_verification'].includes(materialStatus))return null;
    const facts={},missing=new Set(card.missingFields);
    for(const k of Object.keys(p1Fields)){
      if(!own(card.fields,k))continue;
      const v=card.fields[k], measure=k==='size'||k==='beadDiameter';
      if(!v||!own(factSource,v.source)||(v.field!==k&&!(k==='category'&&v.field==='productType'))||
        (measure?typeof v.unit!=='string'||!p1Unit.test(v.unit)||!p1Dimension(v.value):!p1Safe(v.value))||
        k==='material'&&/待核|待确认|未核|未填|未录|疑似|未知|不详|未提供|^n\/?a$/iu.test(v.value)){
        missing.add(k);continue;
      }
      if(k==='material'&&materialStatus!=='recorded')continue;
      const evidenceRef=messageIdOK(v.evidenceRef)&&p1Safe(v.evidenceRef)?v.evidenceRef:null;
      facts[k]={value:k==='category'&&own(categories,v.value)?categories[v.value]:String(v.value),
        source:v.source,...(measure?{unit:v.unit}:{}),...(evidenceRef?{evidenceRef}:{})};
    }
    return {productId,productVersion,alias:p1Safe(card.alias)&&/^[\p{L}\p{N}_.:-]{1,36}$/u.test(card.alias)?card.alias:null,
      source:'catalog',facts,missing:[...missing].filter(k=>k!=='material'),materialPending:!facts.material};
  }
  function productReadReceipt(r,slot){
    if(!turnMatches(r,slot)||!hasP1(r)||r.actions.length!==1)return null;
    const a=r.actions[0],v=a.result,shop=r.shopId??r.storeId;
    if(!v||a.shopId!==shop||v.shopId!==shop||
      (own(a,'storeId')&&a.storeId!==shop)||(own(v,'storeId')&&v.storeId!==shop)||
      a.requestId!==r.requestId||v.requestId!==r.requestId||a.messageId!==r.messageId||v.messageId!==r.messageId||
      !own(p1Root,v.status)||a.status!==v.status||r.status!==p1Root[v.status]||
      !['search','detail'].includes(v.mode)||v.readOnly!==true||v.deliveryStatus!=='not_submitted'||
      !Array.isArray(v.cards)||v.cards.length>20||!Number.isSafeInteger(v.total))return null;
    const matched=v.status==='matched',multi=v.status==='multiple';
    if(v.bound!==matched||(matched?v.total!==1||v.cards.length!==1:
      [r,a,v].some(x=>own(x,'productId')||own(x,'productVersion'))||
      (multi?!v.cards.length||v.total<2||v.total<v.cards.length:v.total!==0||v.cards.length!==0)))return null;
    const cards=v.cards.map(c=>p1Card(c,shop));
    if(cards.some(x=>!x)||new Set(cards.map(k=>k.productId)).size!==cards.length||
      matched&&[r,a,v].some(x=>x.productId!==cards[0].productId||x.productVersion!==cards[0].productVersion))return null;
    return {status:v.status,mode:v.mode,cards,total:v.total,reason:messageIdOK(v.reason)?v.reason:null,shopId:shop};
  }
  function p1ListReply(text,prior){
    if(prior?.p1?.status!=='multiple'||prior.busy||!messageIdOK(prior.messageId)||typeof text!=='string')return null;
    // Only a deliberate reference to the immediately preceding *displayed*
    // list. The server owns ordinal parsing, scope and card-version checks.
    const pattern=/^(?:(?:请|帮我|我想|想)\s*)?(?:(?:查(?:看|询)?|看(?:看)?|选|要)\s*)?(?:(?:上一条|上条|上一次|上次)(?:搜索|查询|查找|商品资料)?(?:结果|列表|清单)|刚才(?:那条|的)?(?:结果|列表|清单))(?:里|中|内)?的?\s*第\s*([一二两三四五六七八九十]{1,3}|[1-9][0-9]?)\s*(?:件|条|个|款)(?:的?\s*(?:商品资料|资料|商品详情|详情))?\s*[。！？!?]?$/u;
    return pattern.test(text.normalize('NFKC'))?prior.messageId:null;
  }
  function messageLocator(p){
    if(!p||!id(p.shopId)||!messageIdOK(p.messageId)||!messageIdOK(p.requestId))return null;
    if(p.kind==='album_draft'&&messageIdOK(p.batchId)&&version(p.draftVersion))
      return {kind:'album_draft',shopId:p.shopId,batchId:p.batchId,draftVersion:p.draftVersion,messageId:p.messageId,requestId:p.requestId};
    if(p.kind==='product_read'&&own(p1Root,p.outcome)&&p.outcome!=='matched')
      return {kind:'product_read',outcome:p.outcome,shopId:p.shopId,messageId:p.messageId,requestId:p.requestId};
    return id(p.productId)&&version(p.productVersion)?
      {shopId:p.shopId,productId:p.productId,productVersion:p.productVersion,messageId:p.messageId,requestId:p.requestId}:null;
  }
  function sameLocator(left,right){
    const a=messageLocator(left),b=messageLocator(right);
    return !!a&&!!b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
  }
  function bodyInScope(x,requestId,p){
    return x?.requestId===requestId&&x.messageId===p.messageId&&(x.shopId??x.storeId)===p.shopId&&
      !(own(x,'shopId')&&own(x,'storeId')&&x.shopId!==x.storeId);
  }
  function restoredCard(x,requestId,p) {
    return bodyInScope(x,requestId,p)&&x.status==='matched'&&x.reason==='SESSION_REFERENCE'&&x.total===1&&Array.isArray(x.cards)&&x.cards.length===1&&
      x.cards[0]?.productId===p.productId&&x.cards[0].productVersion===p.productVersion;
  }
  function restoredClip(checked,queryId,p,original,origin){
    if(!bodyInScope(checked,queryId,p)||checked.productId!==p.productId||checked.productVersion!==p.productVersion||
      checked.source!=='studio.approved_works'||checked.action!=='content.find_old_video'||
      checked.writesPerformed!==false||checked.deliveryStatus!=='not_submitted')return null;
    if(original.status==='no_verified_old_clip'){
      return checked.outcome==='no_verified_old_clip'&&!checked.workRef&&!checked.pinnedPlayUrl?original:null;
    }
    if(original.status!=='existing_available'||checked.outcome!=='existing_available'||checked.mime!=='video/mp4'||
      !original.workRef||checked.workRef?.workId!==original.workRef.workId||
      checked.workRef.workVersion!==original.workRef.workVersion||!hex(checked.sha256)||
      original.sha256!==checked.sha256)return null;
    const a={...original,retrievalStatus:checked.retrievalStatus,workRef:checked.workRef,pinnedPlayUrl:checked.pinnedPlayUrl,sha256:checked.sha256};
    return clipPath(a,origin)?a:null;
  }
  const d3Kinds={content_prepare:'本件新片分镜',content_cancel:'取消分镜',content_confirm:'确认制作',content_adopt:'采用本件作品'};
  const d3NoWork={
    needs_source:'缺少本件已获准的素材或文案。这次未进入制作。',
    needs_review:'本件素材或分镜需要重新核对。这次未继续制作或采用。',
    stale_version:'商品或分镜版本已变，请用最新资料重新准备。这次未继续执行。',
    canceled:'这套分镜已取消。这次没有继续制作或采用。',
    confirmation_required:'请先完成这套分镜或这个版本的明确确认。这次未继续执行。'
  };
  const d3Errors={
    D3_COMMAND_AMBIGUOUS:'请分开说准备、取消、确认制作或采用；没有执行额外动作。',
    D3_NOT_CONNECTED:'本机还未接通内容服务。这次没有制作或采用。',
    D3_STORE_NOT_ENABLED:'此店未开启本轮内容操作。',
    D3_CONSENT_NOT_CONNECTED:'店主确认入口未接通；没有提交制作或采用。',
    D3_PRODUCT_REQUIRED:'请说货号，或回复这件商品的消息。',
    D3_PRODUCT_LOOKUP_REJECTED:'本件商品回执未核实；没有提交。',
    D3_PRODUCT_SOURCE_UNAVAILABLE:'本件商品暂时读不到；请稍后再核对。',
    D3_REFERENCE_CARD_CONFLICT:'所指商品和你回复的那条不一致；没有提交。',
    D3_REPLY_REQUIRED:'请回复具体分镜或作品的消息。',
    D3_REPLY_NOT_AVAILABLE:'本次会话找不到有效的分镜或作品消息。',
    D3_REPLY_KIND_MISMATCH:'请回复对应的分镜消息，或回复待采用的作品消息。',
    D3_SELECTION_NOT_IN_SESSION:'找不到本次会话中的分镜选项；请重新准备。',
    D3_SELECTION_STALE:'这项分镜、资料或版本已变；请重新准备，未提交制作。',
    D3_EXACT_PLAN_REQUIRED:'请选定第一套或第二套分镜再发送确认。',
    D3_PLAN_REFERENCE_INVALID:'这套分镜的版本未核实；请重新准备。',
    D3_EXACT_WORK_REQUIRED:'请直接回复要采用的那一版作品。',
    D3_WORK_REFERENCE_INVALID:'作品版本未核实；没有采用。',
    D3_CONFIRMATION_EXPIRED:'确认已过期；请重新核对分镜或作品并确认。没有继续执行。',
    D3_CONFIRMATION_REVOKED:'确认已撤回；没有继续执行。',
    D3_CONFIRMATION_REQUIRED:'还缺有效的店主确认；未提交制作或采用。',
    D3_STALE_OR_WRONG_CARD:'商品卡版本已变或不可用；请按新版本重新准备。',
    STALE_VERSION:'版本已变；未继续提交。',
    CANCELED:'分镜或确认已取消；未继续提交。',
    NEEDS_SOURCE:'缺少已获准的素材；未继续提交。',
    NEEDS_REVIEW:'素材或分镜待核对；未继续提交。',
    CONFIRMATION_REQUIRED:'还缺有效确认；未继续提交。',
    D3_CONTENT_RECEIPT_REJECTED:'内容回执未核实；请核对原消息，不要重复提交。',
    D3_INTERRUPTED:'暂未取得这条制作的完成回执；没有自动重做。',
    D3_SOURCE_UNAVAILABLE:'内容操作未返回完成回执；请核对原消息，不要重复提交。'
  };
  const d3MediaRoot='/api/n22/content/d3/works/';
  const draftPair=v=>messageIdOK(v?.draftSetId)&&version(v.draftSetVersion);
  const planPair=v=>messageIdOK(v?.planId)&&version(v.planVersion);
  const workPair=v=>messageIdOK(v?.workId)&&version(v.workVersion)&&v.workVersion<=999999999;
  function d3PlayPath(v,messageId,origin){
    if(!v||!workPair(v.workRef)||!messageIdOK(messageId)||!hex(v.sha256)||typeof v.previewUrl!=='string'||
      !v.previewUrl.startsWith(d3MediaRoot)||/[\\\\#\s]/u.test(v.previewUrl))return null;
    try{
      const u=new URL(v.previewUrl,origin),w=v.workRef;
      const wanted=d3MediaRoot+encodeURIComponent(w.workId)+'/'+w.workVersion+'/play';
      if(u.origin!==origin||u.pathname!==wanted||u.username||u.password||u.hash||
         [...u.searchParams.keys()].length!==1||u.searchParams.get('messageId')!==messageId)return null;
      return v.previewUrl;
    }catch{return null;}
  }
  function d3Result(a,r,slot,origin){
    if(!own(d3Kinds,a?.action)||!turnMatches(r,slot)||!matchingAction(a,r,slot)||
       !Array.isArray(r.actions)||r.actions.filter(x=>x?.action===a.action).length!==1)return null;
    const v=a.result,state=a.status,kind=a.action;
    if(!v||typeof v!=='object'||Array.isArray(v)||v.deliveryStatus!=='not_submitted'||
      ['confirmationId','active','expiresAt','revokedAt','canceledAt'].some(k=>own(v,k)||own(a,k))||
      (own(v,'status')&&v.status!==state))return null;
    for(const k of ['shopId','productId','productVersion','requestId','messageId'])
      if(own(v,k)&&v[k]!==a[k])return null;
    if((own(a,'storeId')&&a.storeId!==a.shopId)||(own(v,'storeId')&&v.storeId!==a.shopId))return null;
    const refs=[a,v].filter(x=>own(x,'referenceMessageId')).map(x=>x.referenceMessageId);
    if(refs.some(m=>m!==null&&!messageIdOK(m)||m!==refs[0]||
      (own(slot,'replyToMessageId')&&m!==(slot.replyToMessageId??null))))return null;
    if(own(d3NoWork,state)){
      return ['completed','failed'].includes(r.status)&&v.taskId==null&&v.workRef==null&&v.previewUrl==null?
        {kind,state,detail:v}:null;
    }
    if(r.status!=='completed')return null;
    const noOutput=v.taskId==null&&v.workRef==null&&v.previewUrl==null;
    if(kind==='content_prepare'&&state==='drafts_ready'&&noOutput&&draftPair(v)&&Array.isArray(v.plans)&&
       v.plans.length>=1&&v.plans.length<=2&&v.plans.every(planPair)&&new Set(v.plans.map(x=>x.planId)).size===v.plans.length)
      return {kind,state,detail:v};
    if(kind==='content_cancel'&&state==='cancelled'&&noOutput&&draftPair(v)&&
       version(v.cancelledVersion)&&v.cancelledVersion>v.draftSetVersion)return {kind,state,detail:v};
    if(kind==='content_confirm'&&draftPair(v)&&planPair(v)&&messageIdOK(v.taskId)&&
      (state==='queued'?v.workRef==null&&v.previewUrl==null:state==='awaiting_approval'&&workPair(v.workRef)))
      return {kind,state,detail:v,path:d3PlayPath(v,slot.messageId,origin)};
    if(kind==='content_adopt'&&state==='adopted'&&workPair(v.workRef)&&v.taskId==null)
      return {kind,state,detail:v,path:d3PlayPath(v,slot.messageId,origin)};
    return null;
  }
  function d3Choice(a,detail,plan){
    return {referenceMessageId:a.messageId,productId:a.productId,productVersion:a.productVersion,draftSetId:detail.draftSetId,
      draftSetVersion:detail.draftSetVersion,planId:plan.planId,planVersion:plan.planVersion};
  }
  function acceptedChoice(r,expected,shop){
    return r?.status==='selected'&&r.shopId===shop&&Object.keys(expected).every(k=>r[k]===expected[k]);
  }
  function checkedShots(plan){
    const shots=plan.shots;
    if(!Array.isArray(shots)||!shots.length||shots.length>6||shots.some(s=>!messageIdOK(s?.assetId)||
      !Number.isSafeInteger(s.durationMs)||s.durationMs<1000||s.durationMs>7000||
      typeof s.caption!=='string'||s.caption.length>400))return null;
    return shots;
  }
  function groupDraftView(a,r,slot){
    const v=a?.result,fx=v?.effects;
    if(a?.action!=='album_draft'||!turnMatches(r,slot)||!v||v.status!=='draft_only'||
      (own(a,'status')&&a.status!==v.status)||v.shopId!==(r.shopId??r.storeId)||!turnMatches(v,slot)||
      !id(v.batchId)||!version(v.draftVersion)||!Array.isArray(v.groups)||!Array.isArray(v.pendingAssetIds)||
      !['catalogCreated','catalogUpdated','cardAssetLinksAdded'].every(k=>fx?.[k]===0))return null;
    const all=new Set(),groups=new Set();
    for(const [i,g] of v.groups.entries()){
      if(!messageIdOK(g?.groupId)||groups.has(g.groupId)||g.ordinal!==i+1||!version(g.draftGroupVersion)||
        !['system_checked','owner_confirmed'].includes(g.decisionSource)||!id(g.evidenceRef)||
        !Array.isArray(g.keptAssetIds)||!g.keptAssetIds.length||
        (g.suggestedTarget!==undefined&&(g.decisionSource!=='system_checked'||!messageIdOK(g.suggestedTarget?.productId)||
          !version(g.suggestedTarget?.productVersion))))return null;
      groups.add(g.groupId);
      for(const asset of g.keptAssetIds){if(!id(asset)||all.has(asset))return null;all.add(asset);}
    }
    for(const asset of v.pendingAssetIds){if(!id(asset)||all.has(asset))return null;all.add(asset);}
    return v;
  }
  function draftAssets(v,b){
    if(!batchMatches(b,{batchId:v.batchId}))return null;
    const rows=b.items.filter(x=>x.status==='kept'), keys=new Set(rows.map(x=>x.assetId));
    const want=[...v.groups.flatMap(g=>g.keptAssetIds),...v.pendingAssetIds];
    return want.length===keys.size&&new Set(want).size===keys.size&&want.every(k=>keys.has(k))?
       new Map(rows.map(x=>[x.assetId,x])):null;
  }
  function d2Prepared(v) {
    const x=v?.preview;
    if(!x||!['create','attach'].includes(v.operation))return null;
    const source=x.sourceMessageId??x.draftMessageId??x.replyToMessageId??v.sourceMessageId;
    if(!messageIdOK(source)||!messageIdOK(x.groupId)||!id(x.batchId)||!version(x.draftGroupVersion)||
      !Array.isArray(x.assetIds)||!x.assetIds.length||x.assetIds.some(y=>!id(y))||
      new Set(x.assetIds).size!==x.assetIds.length)return null;
    if(v.operation==='attach'&&(!id(x.productId)||!version(x.expectedVersion)))return null;
    return {sourceMessageId:source,groupId:x.groupId,draftGroupVersion:x.draftGroupVersion,
      batchId:x.batchId,assetIds:x.assetIds,productId:x.productId??null,expectedVersion:x.expectedVersion??null};
  }
  function groupWording(ordinal,target=null){
    if(!version(ordinal)||ordinal>12)return null;
    if(!target)return '把第'+ordinal+'组建档';
    if(!messageIdOK(target.productId)||!version(target.productVersion))return null;
    return '把第'+ordinal+'组补到卡号 '+target.productId+' v'+target.productVersion;
  }
  const catalogStates={prepared:'待确认：尚未修改商品',committed:'已提交商品变更',cancelled:'已取消：未修改商品',
    conflict:'商品或组版本冲突：未覆盖',expired:'确认已过期：未修改商品',committing:'等待商品实际提交回执'};
  function catalogFixtureView(a,r,slot){
    const v=a?.result;
    if(a?.action!=='catalog_write'||!turnMatches(r,slot)||!v||v.fixtureOnly!==true||!own(catalogStates,v.status)||
      r.status!=='catalog_write_'+v.status||!messageIdOK(v.intentId)||!messageIdOK(v.preparedMessageId)||
      !['create','attach','update'].includes(v.operation)||!v.preview||typeof v.preview!=='object')return null;
    const d=d2Prepared(v);
    if(v.status==='prepared'){
      if(v.preparedMessageId!==slot.messageId)return null;
      if(d&&slot.replyToMessageId!==d.sourceMessageId)return null;
      if(!d&&slot.replyToMessageId&&slot.replyToMessageId!==v.preparedMessageId){
        // An edit may have come from a different (committed) message, while
        // the confirmation must cite this new preview. Keep the two apart.
        const p=slot.commitReference;
        if(v.operation!=='update'||!p||p.messageId!==slot.replyToMessageId||
          p.shopId!==(r.shopId??r.storeId)||p.productId!==v.preview.productId||
          p.productVersion!==v.preview.expectedVersion)return null;
      }
    }else if(slot.replyToMessageId&&slot.replyToMessageId!==v.preparedMessageId)return null;
    if(v.status==='committed'){
      const x=v.receipt;
      if(!id(r.productId)||r.productId!==x?.productId||!version(r.productVersion)||r.productVersion!==x.productVersion)return null;
      if(d&&(x.status!=='committed'||x.taskId!==d.batchId||x.groupId!==d.groupId||x.groupVersion!==1||
        !messageIdOK(x.requestId)||!Array.isArray(x.linkedAssetIds)||!Array.isArray(x.addedAssetIds)||
        !d.assetIds.every(i=>x.linkedAssetIds.includes(i))||!x.addedAssetIds.every(i=>d.assetIds.includes(i))||
        (v.operation==='attach'?(x.productId!==d.productId||!['images_added','unchanged'].includes(x.outcome)):x.outcome!=='created')))
        return null;
    }
    return v;
  }
  function catalogReplyLocator(a,r,slot){
    const v=catalogFixtureView(a,r,slot),rec=v?.receipt,preview=v?.preview;
    if(v?.status!=='committed'||rec?.status!=='committed'||!messageIdOK(rec.requestId))return null;
    const shopId=r.shopId??r.storeId, meta={shopId,requestId:slot.requestId,messageId:slot.messageId};
    if([a,v].some(x=>Object.entries(meta).some(([k,b])=>own(x,k)&&x[k]!==b))||
      [a,v,rec].some(x=>own(x,'storeId')&&x.storeId!==shopId)||
      (own(rec,'shopId')&&rec.shopId!==shopId))return null;
    if(v.operation==='create'&&preview.productId==null){
      if(rec.outcome!=='created'||rec.productVersion!==1)return null;
    }else{
      const outcomes=v.operation==='attach'?['images_added','unchanged']:
        v.operation==='update'?['updated','unchanged']:['unchanged'];
      if(!outcomes.includes(rec.outcome)||preview.productId!==rec.productId||!version(preview.expectedVersion)||
        rec.productVersion!==preview.expectedVersion+(rec.outcome==='unchanged'?0:1))return null;
    }
    return {...meta,productId:rec.productId,productVersion:rec.productVersion};
  }
  if(typeof module!=='undefined'&&module.exports){
    module.exports={batchMatches,turnMatches,matchingAction,clipPath,thumbnail,classificationReceipt,classification,salesResult,messageLocator,sameLocator,restoredCard,restoredClip,d3Result,d3PlayPath,d3Choice,acceptedChoice,checkedShots,groupDraftView,draftAssets,d2Prepared,groupWording,catalogFixtureView,catalogReplyLocator,productReadReceipt,p1ListReply};return;
  }
  const $=x=>document.getElementById(x), S=new Map();
  const input=$('photos'), prompt=$('prompt'), thread=$('thread'), n=(tag,t,cls)=>{
    const el=document.createElement(tag);if(t!==undefined)el.textContent=t;if(cls)el.className=cls;return el;
  };
  let selected=[], latest=null, player=null, reference=null, photoContinuation=false, currentStore=null;
  let restoreEpoch=0, restoring=false, scopedReply=false, d3Mounted=false;
  const closedDrafts=new Set(), draftControls=new Map();
  const knownDrafts=new Map(), recentCards=new Map(), cardSelects=new Set(), submittedGroups=new Set();
  const origin=location.origin, bind=()=>newRequestId(window.crypto);
  async function api(path,body){
    if(path!==TURN&&path!==CHECK_CARD&&path!==D3_PICK&&path!=='/api/n22/capabilities'&&!path.startsWith(ROOT)&&
      !path.startsWith(CHECK_CLIP+'?')&&path!==DRAFTS+'/correct'&&
      !(path.startsWith(DRAFTS+'/')&&messageIdOK(path.slice(DRAFTS.length+1)))&&
      !(path.startsWith(MSG)&&messageIdOK(path.slice(MSG.length))))throw Error('outside_transport');
    const res=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',...(body?
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    const type=(res.headers.get('Content-Type')||'').split(';')[0];
    let d; if(type==='application/json')d=await res.json();
    if(!res.ok)throw Error(d?.error?.code??'HTTP_'+res.status);
    if(!d)throw Error('invalid_receipt');
    return {body:d,receiptHeader:res.headers.get('X-N22-Request-Id')};
  }
  function saveLast(x){try{localStorage.setItem(RECOVER,x)}catch{};$('recover').hidden=false;}
  function last(){try{return localStorage.getItem(RECOVER)}catch{return null;}}
  function messagePin(){
    // Entry state survives F5/new Document in this conversation. A new blank entry
    // has no matching marker even when a new tab inherits sessionStorage via an opener.
    // It is an opaque locator, not authorization or cached content.
    try{
      const entry=messageLocator(history.state?.[RESUME]);
      const tab=JSON.parse(sessionStorage.getItem(RESUME)||'null');
      if(!sameLocator(entry,tab))return null;
      // Local display only. Never use the saved wording as a selector or resend it.
      return {...entry,question:bounded(tab.question,500)?tab.question:null};
    }catch{return null;}
  }
  function clearMessagePin(){
    try{sessionStorage.removeItem(RESUME);}catch{}
    try{const state={...history.state};delete state[RESUME];history.replaceState(state,'');}catch{}
    $('resume').hidden=true;
  }
  function resumeFor(r,slot){
    const shopId=r.shopId??r.storeId, draft=groupDraftView(r.actions?.find?.(x=>x?.action==='album_draft'),r,slot);
    if(hasP1(r)){
      const p=productReadReceipt(r,slot);
      if(!p)return null;
      if(p.status!=='matched')return messageLocator({kind:'product_read',outcome:p.status,shopId,messageId:slot.messageId,requestId:slot.requestId});
    }
    return messageLocator({shopId,messageId:slot.messageId,requestId:slot.requestId,
      ...(draft?{kind:'album_draft',batchId:draft.batchId,draftVersion:draft.draftVersion}:
        {productId:r.productId,productVersion:r.productVersion})});
  }
  function storeMessage(slot,r){
    if(latest!==slot.messageId)return;
    const p=resumeFor(r,slot);
    if(!p)return;
    try{
      history.replaceState({...history.state,[RESUME]:p},'');
      sessionStorage.setItem(RESUME,JSON.stringify({...p,question:slot.text}));
    }catch{clearMessagePin();}
  }
  function clearPlayer(){
    if(!player)return;const {v,b,button,departed}=player;player=null;
    v.pause();v.removeAttribute('src');v.load();v.remove();
    button.disabled=true; b.querySelector('.progress').textContent=departed;
  }
  function alignLatest(slot){if(latest!==slot.messageId){clearPlayer();latest=slot.messageId;}}
  function startLatestTurn(slot){++restoreEpoch;clearMessagePin();alignLatest(slot);}
  function addSlot(p){
    const el=n('article',undefined,'turn'),question=n('p',p.text,'sent'), reply=n('div',undefined,'replied');
    el.dataset.messageId=p.messageId;el.dataset.requestId=p.requestId;reply.append(n('p','正在读取这条消息…'));
    el.append(question,reply);thread.append(el);p.reply=reply;S.set(p.messageId,p);return p;
  }
  function addTrace(dst,caption){dst.append(n('p',caption,'trace-id'));}
  function act(text,cb){
    const b=n('button',text);b.type='button';b.addEventListener('click',cb);return b;
  }
  function note(text){$('attachment').textContent=text;$('clearPhotos').hidden=!selected.length;}
  function gallery(slot,matches){
    const b=slot.batch, el=n('section',undefined,'albums');
    el.dataset.batchId=b.batchId;
    el.append(n('h3','本次照片整理'),n('p','已选 '+b.counts.selected+' 张 · 保留 '+b.counts.kept+' · 精确重复 '+b.counts.duplicate+
      ' · 读取失败 '+b.counts.failed+'。未建档、未删除原照片。'));
    addTrace(el,'批次 '+b.batchId+' · 导入请求 '+b.requestId);
    const seen=new Map();
    for(const a of b.items){
      const ev=matches.get(a.assetId);
      const g=ev?.category??(a.status==='kept'?'pending':a.status);
      if(!seen.has(g))seen.set(g,[]);
      seen.get(g).push([a,ev]);
    }
    for(const [g,rows] of seen){
      const label=categories[g]??({pending:'待确认品类',duplicate:'完全重复，不重复保留',failed:'本次未读入'}[g]);
      el.append(n('h4',label+'（'+rows.length+' 张）'));
      for(const [a,ev] of rows){
        const row=n('div',undefined,'photo-row'),desc=n('div');
        row.dataset.itemId=a.itemId;row.dataset.status=a.status;row.dataset.ordinal=String(a.ordinal);
        if(a.assetId)row.dataset.assetId=a.assetId;
        if(a.duplicateOf)row.dataset.duplicateOf=a.duplicateOf;
        if(ev){row.dataset.category=ev.category;row.dataset.classificationSource=ev.source;}
        if(a.status==='kept'){
          const img=n('img');img.alt='本次选图第 '+(a.ordinal+1)+' 张';img.decoding='async';img.referrerPolicy='no-referrer';
          img.src=thumbnail(b.batchId,a);
          img.addEventListener('error',()=>{if(img.isConnected){img.remove();desc.append(n('small','原图暂不可读取，未替换为其他图。'));}});
          row.append(img);
        }
        const status=ev?categories[ev.category]+(ev.status==='suggested'?'（建议）':''):
          a.status==='kept'?'品类待确认':a.status==='duplicate'?'字节完全相同':'读取失败';
        desc.append(n('strong','第 '+(a.ordinal+1)+' 张 · '+status),n('small','来源：本次选图'+(ev?' · '+sourceLabel[ev.source]:'')));
        if(a.assetId)desc.append(n('small','素材 '+a.assetId));
        if(a.duplicateOf)desc.append(n('small','与保留素材 '+a.duplicateOf+' 的原始字节相同'));
        if(ev)desc.append(n('small','依据 '+ev.evidenceRef));
        if(a.status==='failed')desc.append(n('small',a.reason==='intake_decoder_unavailable'?'本机解码器暂不可用，可稍后重新选图。':'文件损坏或图像格式不支持。'));
        row.append(desc);el.append(row);
      }
    }
    return el;
  }
  function messagePlayer(dst,slot,a,path,copy){
    if(latest!==slot.messageId){dst.append(n('p',copy.inactive));return;}
    const box=n('div',undefined,'msg-player'), info=n('p','待播放','progress');
    const button=act(copy.button,()=>{
      if(latest!==slot.messageId||S.get(slot.messageId)!==slot)return;
      clearPlayer();
      const v=n('video');v.controls=true;v.playsInline=true;v.preload='none';
      v.setAttribute('playsinline','');v.setAttribute('controlslist','nodownload noremoteplayback');
      v.dataset.messageId=slot.messageId;v.dataset.productId=a.productId;v.dataset.workVersion=String(a.workRef.workVersion);
      player={v,b:box,button,departed:copy.departed}; box.append(v);v.src=path;
      for(const e of ['playing','timeupdate','ended','loadedmetadata'])v.addEventListener(e,()=>{
        if(player?.v!==v||latest!==slot.messageId)return;
        v.dataset.currentTime=v.currentTime.toFixed(3);
        info.textContent='播放 '+v.currentTime.toFixed(2)+' 秒';
      });
      v.addEventListener('error',()=>{if(player?.v===v)info.textContent=copy.error;});
      button.disabled=true;
      v.play()?.catch(()=>{if(player?.v===v)info.textContent='请点击播放器的播放控件。';});
    });
    box.append(button,info);dst.append(box);
  }
  function showClip(dst,slot,a){
    const path=clipPath(a,origin);
    if(!path){dst.append(n('p','旧片引用未核实，未打开播放器。','warn'));return;}
    addTrace(dst,'原作品 '+a.workRef.workId+' · v'+a.workRef.workVersion);
    messagePlayer(dst,slot,a,path,{button:'播放本件旧片',error:'本件旧片暂不可播；请重查本件。',
      inactive:'这条旧片回执已保留；当前消息不切换播放器。',departed:'已离开此条播放；如需重看，请重新查本件旧片。'});
  }
  function stageMessageCommand(slot,text,description){
    if(S.get(slot.messageId)!==slot)return;
    if(selected.length){note('本条操作只引用消息；请先移除草稿里已选的照片。');return;}
    reference=slot.messageId;photoContinuation=false;scopedReply=true;
    if(text!==null)prompt.value=text;
    note(description+(text===null?'；请输入内容，点发送才提交。':'；这里只填入指令，点发送才提交。'));prompt.focus();
  }
  const draftKey=(a,v)=>JSON.stringify([a.shopId,a.productId,a.productVersion,v.draftSetId,v.draftSetVersion]);
  function closeD3Controls(a,v){
    const k=draftKey(a,v);closedDrafts.add(k);
    for(const b of draftControls.get(k)??[])b.disabled=true;
    draftControls.delete(k);
  }
  function d3Section(slot,r,a){
    const section=n('section',undefined,'subreply d3-result');
    section.dataset.action=a.action;section.append(n('h3',d3Kinds[a.action]));
    const got=d3Result(a,r,slot,origin);
    if(!got){section.append(n('p','内容回执或归属未核实，请先查看原消息。','warn'));return section;}
    const {kind,state,detail:v,path}=got;
    section.dataset.status=state;section.dataset.productId=a.productId;section.dataset.productVersion=String(a.productVersion);
    addTrace(section,'本店 '+a.shopId+' · 商品 '+a.productId+' · 卡 v'+a.productVersion+' · 请求 '+a.requestId);
    if(own(d3NoWork,state)){
      section.append(n('p',d3NoWork[state],'warn'));
      if(v.code==='CAPTION_TOO_LONG'&&Number.isInteger(v.captionCheck?.used)&&v.captionCheck.limit===56)
        section.append(n('p','字幕用了 '+v.captionCheck.used+' 个 UTF-16 单元，本段上限 56；请缩短后重新核对。'));
      if(v.code==='CAPTION_LINE_BREAK')section.append(n('p','字幕请不要手动换行；系统会自动排版。'));
      return section;
    }
    if(kind==='content_prepare'){
      section.append(n('p','分镜已准备，等你选定并明确确认。没有开始制作。'));
      addTrace(section,'分镜组 '+v.draftSetId+' · v'+v.draftSetVersion);
      const k=draftKey(a,v),buttons=[],usable=latest===slot.messageId&&!closedDrafts.has(k);
      const pickState=n('p',undefined,'hint');pickState.setAttribute('role','status');
      let choosing=false;
      async function choose(p,i){
        if(choosing||closedDrafts.has(k)||S.get(slot.messageId)!==slot)return;
        if(selected.length){note('请先移除此条草稿中另外选的照片，再确认这组分镜。');return;}
        const ordinal='确认按'+(i===0?'第一':'第二')+'版做';
        const description='将引用这条消息的第 '+(i+1)+' 套分镜（v'+p.planVersion+'）';
        // The ordinal is in the explicitly sent text even when a persisted
        // selection exists; a second tab cannot silently change its meaning.
        if(!d3Mounted){stageMessageCommand(slot,ordinal,description);return;}
        const request=d3Choice(a,v,p),atStart=latest,epoch=restoreEpoch,oldText=prompt.value,oldRef=reference;
        choosing=true;buttons.forEach(b=>{b.disabled=true;});
        pickState.textContent='正在核对分镜和版本…';
        const active=()=>atStart===latest&&epoch===restoreEpoch&&S.get(slot.messageId)===slot&&!closedDrafts.has(k);
        try{
          const {body}=await api(D3_PICK,request);
          if(!active())return;
          if(!acceptedChoice(body,request,a.shopId))throw Error('D3_SELECTION_STALE');
          pickState.textContent='已选定第 '+(i+1)+' 套分镜，尚未提交制作。';
          if(oldText===prompt.value&&oldRef===reference)stageMessageCommand(slot,ordinal,description);
        }catch(e){
          if(active())pickState.textContent=d3Errors[e?.message]??'分镜选择暂未核实，未提交制作。';
        }finally{choosing=false;if(!closedDrafts.has(k))buttons.forEach(b=>{b.disabled=false;});}
      }
      v.plans.forEach((p,i)=>{
        const opt=n('div',undefined,'d3-plan');opt.dataset.planId=p.planId;opt.dataset.planVersion=String(p.planVersion);
        opt.append(n('h4','第 '+(i+1)+' 套'+(bounded(p.label,120)?' · '+p.label:'')));
        const shots=checkedShots(p);
        if(shots){
          const list=n('ol');
          shots.forEach(x=>{
            const row=n('li');row.append(n('p',(x.caption||'无字幕')+' · '+(x.durationMs/1000).toLocaleString('zh-CN')+' 秒'));
            addTrace(row,'素材 '+x.assetId);list.append(row);
          });
          opt.append(list);
        }else opt.append(n('p','镜头明细还未核实，请先检查分镜。','warn'));
        addTrace(opt,'分镜 '+p.planId+' · v'+p.planVersion);
        if(shots&&usable){
          const btn=act('选第 '+(i+1)+' 套并填写确认',()=>void choose(p,i));
          opt.append(btn);buttons.push(btn);
        }
        section.append(opt);
      });
      if(usable){
        const cancel=act('取消这组分镜',()=>{if(!closedDrafts.has(k))stageMessageCommand(slot,'取消这套分镜','将取消这条消息的分镜组 v'+v.draftSetVersion);});
        section.append(cancel,pickState);buttons.push(cancel);
        draftControls.set(k,new Set([...(draftControls.get(k)??[]),...buttons]));
      }else section.append(n('p','这是本条分镜的记录，未切换下一条消息的引用。'));
    }else if(kind==='content_cancel'){
      closeD3Controls(a,v);
      section.append(n('p','分镜已取消。此操作未制作新片。'));
      addTrace(section,'分镜组 '+v.draftSetId+' · 原 v'+v.draftSetVersion+' · 取消后 v'+v.cancelledVersion);
      if(latest===slot.messageId)section.append(act('重新准备两套',()=>stageMessageCommand(slot,
        '准备两种风格，先别制作','按这条消息所属商品，另行准备分镜')));
    }else{
      if(kind==='content_confirm'){
        closeD3Controls(a,v);
        addTrace(section,'分镜组 '+v.draftSetId+' · v'+v.draftSetVersion+' · 所选分镜 '+v.planId+' · v'+v.planVersion+' · 任务 '+v.taskId);
      }
      if(state==='queued'){
        section.append(n('p','制作已确认、正在处理。还没有可预览作品；刷新只读原消息。'));
        return section;
      }
      const adopted=state==='adopted';
      section.append(n('p',adopted?'已采用这一版，已挂回本件。未发布。':'这一版已生成，待你预览和决定是否采用。未发布。'));
      addTrace(section,'本件作品 '+v.workRef.workId+' · v'+v.workRef.workVersion+(hex(v.sha256)?' · SHA-256 '+v.sha256:''));
      if(path)messagePlayer(section,slot,{...a,workRef:v.workRef},path,{button:'播放这版预览',
        inactive:'本条作品回执已保留，未切换当前消息的播放器。',
        departed:'已离开此条预览。',error:'这版预览暂不可用；请核实本条作品的当前权限。'});
      else section.append(n('p','未收到可核验的本版预览地址；不会借用旧片或其他版本。','warn'));
      if(!adopted&&path&&latest===slot.messageId)section.append(act('填写采用这版',()=>stageMessageCommand(slot,
        '采用这版，不要发布','将引用这条作品 v'+v.workRef.workVersion+'；采用不发布')));
    }
    return section;
  }
  const targetKey=(x)=>x.productId+'@'+x.productVersion;
  function knownTarget(x){return [...recentCards.values()].find(p=>targetKey(p)===x)??null;}
  function showTargets(sel){
    const chosen=sel.value, empty=n('option','选择这次要补图的原卡（不默认选）');
    empty.value='';sel.replaceChildren(empty);
    for(const p of recentCards.values()){
      const op=n('option','商品 '+p.order+' · 卡 v'+p.productVersion);op.value=targetKey(p);sel.append(op);
    }
    sel.value=Array.from(sel.options).some(o=>o.value===chosen)?chosen:'';
  }
  function rememberCard(r,receipt){
    const existing=recentCards.get(receipt.productId);
    if(existing&&existing.productVersion>=receipt.productVersion)return;
    recentCards.set(receipt.productId,{shopId:r.shopId??r.storeId,productId:receipt.productId,
      productVersion:receipt.productVersion,order:existing?.order??recentCards.size+1});
    for(const sel of cardSelects){if(sel.isConnected)showTargets(sel);else cardSelects.delete(sel);}
  }
  function noteDraft(v){
    const old=knownDrafts.get(v.batchId)??0;
    if(v.draftVersion<=old)return;
    knownDrafts.set(v.batchId,v.draftVersion);
    for(const el of thread.querySelectorAll('[data-action=album_draft]')){
      if(el.dataset.batchId===v.batchId&&Number(el.dataset.draftVersion)<v.draftVersion){
        el.dataset.stale='true';
        for(const ct of el.querySelectorAll('button,select'))ct.disabled=true;
        const note=n('p','已有更新的草稿。这条旧版不能再确认。','warn');el.append(note);
      }
    }
  }
  function draftCurrent(v,g){
    return knownDrafts.get(v.batchId)===v.draftVersion&&(!g||(!submittedGroups.has(g.groupId)&&
      (!g.deliveryStatus||g.deliveryStatus==='not_requested')));
  }
  function stageGroup(slot,v,g,target){
    if(!draftCurrent(v,g)){note('请回到最新且未提交的分组，未继续确认。');return;}
    const text=groupWording(g.ordinal,target);
    if(!text)return;
    stageMessageCommand(slot,text,target?'只准备将第 '+g.ordinal+' 组补到所选原卡 v'+target.productVersion:
        '只准备将第 '+g.ordinal+' 组建档');
  }
  function thumbFigure(v,row){
    const figure=n('figure',undefined,'group-photo'),image=n('img');image.loading='lazy';image.decoding='async';
    image.alt='本批第 '+(row.ordinal+1)+' 张原图'; image.src=thumbnail(v.batchId,row);image.referrerPolicy='no-referrer';
    image.addEventListener('error',()=>{image.remove();});
    figure.dataset.assetId=row.assetId;figure.append(image,n('figcaption','第 '+(row.ordinal+1)+' 张'));
    return figure;
  }
  function groupEditor(slot,v,rows){
    const box=n('details',undefined,'group-editor'), controls=[];
    box.append(n('summary','人工纠正分组（只存草稿）'),n('p','为各原图选组。留待认的照片不会建档；不要用颜色、背景或序号猜同件。'));
    const assigned=new Map(v.groups.flatMap(g=>g.keptAssetIds.map(id=>[id,g.groupId])));
    for(const row of [...rows.values()].sort((a,b)=>a.ordinal-b.ordinal)){
      const line=n('label',undefined,'group-edit-row'), sel=n('select');sel.dataset.editAsset=row.assetId;
      sel.setAttribute('aria-label','第 '+(row.ordinal+1)+' 张归组');
      const option=(value,label)=>{const op=n('option',label);op.value=value;sel.append(op);};
      option('','留待认');
      v.groups.forEach(g=>option('g:'+g.groupId,'第 '+g.ordinal+' 组'));
      for(let i=1;i<=rows.size;i++)option('n:'+i,'新组 '+i);
      sel.value=assigned.has(row.assetId)?'g:'+assigned.get(row.assetId):'';
      controls.push([row,sel]);line.append(thumbFigure(v,row),sel);box.append(line);
    }
    const save=act('保存分组纠正（不建档）',()=>{
      if(!draftCurrent(v)||S.get(slot.messageId)!==slot){note('这条草稿已过期，请查看新版。');return;}
      if(save.disabled)return;
      const bins=new Map(v.groups.map(g=>['g:'+g.groupId,[]]));
      for(let i=1;i<=rows.size;i++)bins.set('n:'+i,[]);
      for(const [r,ct] of controls)if(bins.has(ct.value))bins.get(ct.value).push(r.assetId);
      const groups=[...bins].filter(([,items])=>items.length).map(([key,keptAssetIds])=>({
        ...(key.startsWith('g:')?{groupId:key.slice(2)}:{}),keptAssetIds}));
      let next;
      try{next=addSlot({messageId:bind(),requestId:bind(),text:'人工纠正这批照片的分组（只存草稿）',
        files:[],replyToMessageId:slot.messageId,batch:slot.batch,suppressGallery:true,
        correction:{expectedDraftVersion:v.draftVersion,groups}});}
      catch{note('当前浏览器无法生成独立请求号，未保存。');return;}
      save.disabled=true;startLatestTurn(next);void run(next).finally(()=>{
        if(draftCurrent(v))save.disabled=false;
      });
    });
    box.append(save);return box;
  }
  function groupSection(slot,r,a){
    const section=n('section',undefined,'subreply');section.dataset.action='album_draft';section.append(n('h3','相册归组草稿'));
    const v=groupDraftView(a,r,slot);
    if(!v){section.append(n('p','归组草稿或归属未核对。','warn'));return section;}
    noteDraft(v);section.dataset.batchId=v.batchId;section.dataset.draftVersion=String(v.draftVersion);
    section.append(n('p','这条消息只整理：'+v.groups.length+' 组，'+v.pendingAssetIds.length+' 张待认；没有提交商品变更。'));
    addTrace(section,'批次 '+v.batchId+' · 草稿 v'+v.draftVersion);
    const make=()=>{
      const rows=draftAssets(v,slot.batch);
      if(!rows){section.append(n('p','批次和素材未核对，暂不开放操作。','warn'));return;}
      const allow=draftCurrent(v);
      if(!allow){section.dataset.stale='true';section.append(n('p','这是旧分组，只能查看；请回到最新分组。','warn'));}
      for(const g of v.groups){
        const box=n('div',undefined,'draft-visible-group');
        box.dataset.groupId=g.groupId;box.dataset.groupVersion=String(g.draftGroupVersion);box.dataset.ordinal=String(g.ordinal);
        box.append(n('h4','第 '+g.ordinal+' 组 · '+g.keptAssetIds.length+' 张 · '+(g.decisionSource==='system_checked'?'本机证据建议':'店主人工作业')));
        const photos=n('div',undefined,'group-pictures');
        g.keptAssetIds.forEach(k=>photos.append(thumbFigure(v,rows.get(k))));
        box.append(photos);addTrace(box,'组 '+g.groupId+' · v'+g.draftGroupVersion+' · 依据 '+g.evidenceRef);
        if(g.suggestedTarget){
          const p=g.suggestedTarget;box.append(n('p','有同件证据的原卡建议（卡 v'+p.productVersion+'）。本次没有自动挂卡。'));
          addTrace(box,'原卡建议 '+p.productId+' · v'+p.productVersion);
          if(allow&&draftCurrent(v,g))box.append(act('只准备补到这张建议卡',()=>stageGroup(slot,v,g,
            {...p,order:'建议卡'})));
        }
        if(allow&&draftCurrent(v,g)){
          const choose=n('select');choose.setAttribute('aria-label','第 '+g.ordinal+' 组补图目标');
          choose.dataset.groupTarget=String(g.ordinal);showTargets(choose);cardSelects.add(choose);
          box.append(act('准备将第 '+g.ordinal+' 组建档',()=>stageGroup(slot,v,g)),choose,
            act('准备补到所选原卡',()=>{
              const target=knownTarget(choose.value);
              if(!target||target.shopId!==v.shopId){note('先明确选这次的目标卡；不会沿用上一次商品。');return;}
              stageGroup(slot,v,g,target);
            }));
        }
        section.append(box);
      }
      if(v.pendingAssetIds.length){
        section.append(n('h4','待认（'+v.pendingAssetIds.length+' 张）'));
        const left=n('div',undefined,'group-pictures');left.dataset.pending='true';
        v.pendingAssetIds.forEach(k=>left.append(thumbFigure(v,rows.get(k))));section.append(left);
      }
      if(allow&&rows.size)section.append(groupEditor(slot,v,rows));
    };
    if(slot.batch){make();return section;}
    const msg=n('p','正在核对这批原图…');section.append(msg);
    void api(ROOT+'/'+v.batchId).then(x=>{
      if(!section.isConnected||S.get(slot.messageId)!==slot)return;
      if(x.receiptHeader!==x.body.requestId||!draftAssets(v,x.body))throw Error('bad_batch_receipt');
      slot.batch=x.body;msg.remove();make();
    }).catch(()=>{if(msg.isConnected)msg.textContent='原图批次暂未核对，不开放建档或补图。';});
    return section;
  }
  function catalogSection(slot,r,a){
    const section=n('section',undefined,'subreply');section.dataset.action='catalog_write';
    const v=catalogFixtureView(a,r,slot);
    if(!v){section.append(n('h3','商品操作'),n('p','商品操作回执未核对。','warn'));return section;}
    section.dataset.writeStatus=v.status;
    const {preview:x,receipt}=v,label={create:'建档',attach:'补图',update:'改资料'}[v.operation];
    const sameGroup=d2Prepared(v);
    if(sameGroup){
      Object.assign(section.dataset,{groupId:sameGroup.groupId,draftGroupVersion:String(sameGroup.draftGroupVersion),
        draftMessageId:sameGroup.sourceMessageId,batchId:sameGroup.batchId});
      addTrace(section,'引用这条相册分组消息 '+sameGroup.sourceMessageId+' · 组 v'+sameGroup.draftGroupVersion);
    }
    section.append(n('h3',catalogStates[v.status]),n('p','隔离测试店 · '+label+'，与制片确认分开。'));
    if(id(x.productId)&&version(x.expectedVersion))addTrace(section,'商品 '+x.productId+' · 预期卡 v'+x.expectedVersion);
    if(id(x.groupId)&&version(x.groupVersion))addTrace(section,'组 '+x.groupId+' · v'+x.groupVersion+
      (id(x.batchId)?' · 批次 '+x.batchId:''));
    if(Array.isArray(x.assetIds)&&x.assetIds.every(id))addTrace(section,'本次素材 '+x.assetIds.join('、'));
    if(sameGroup&&v.status==='committed')section.append(n('p','本次已新增 '+receipt.addedAssetIds.length+
      ' 张关联；本卡 v'+receipt.productVersion+' 共 '+receipt.linkedAssetIds.length+' 张。'));
    else if(Array.isArray(x.willAttach)&&v.status==='prepared')section.append(n('p','拟新增 '+x.willAttach.length+' 张关联。'));
    if(x.difference&&['price','size'].includes(x.difference.field)){
      const text=y=>y&&bounded(y.value,40)&&bounded(y.unit,20)?y.value+' '+y.unit:'未填';
      section.append(n('p',(x.difference.field==='price'?'售价':'尺寸')+'拟改为 '+text(x.difference.after)+
        '（原 '+text(x.difference.before)+'）'+(v.status==='conflict'?'；这次未写入。':'。')));
    }
    if(v.status==='committed'){
      addTrace(section,'商品 '+receipt.productId+' · 卡 v'+receipt.productVersion);
      if(sameGroup)submittedGroups.add(sameGroup.groupId);
      rememberCard(r,receipt);
      const pin=slot.commitPin=catalogReplyLocator(a,r,slot);
      if(pin){
        const follow=n('div',undefined,'actions');
        follow.dataset.catalogReply='true';follow.dataset.productVersion=String(pin.productVersion);
        const stage=description=>{
          if(currentStore!==pin.shopId||S.get(pin.messageId)!==slot)return;
          // The one-shot composer holds the message ID, never the card ID.
          stageMessageCommand(slot,null,'引用这条已提交的'+label+'回执（卡 v'+pin.productVersion+'）'+description);
        };
        follow.append(act('在下一条继续问这件',()=>stage('继续问')),act('改这件资料',()=>stage('准备更改（仍须确认）')));
        section.append(follow);
      }
      if(d3Mounted&&latest===slot.messageId)section.append(act('准备本件两套分镜',()=>stageMessageCommand(slot,
        '准备两种风格，先别制作','将引用这条商品回执的卡 v'+receipt.productVersion)));
    }
    if(v.status==='conflict'&&version(v.currentVersion))addTrace(section,'当前卡 v'+v.currentVersion);
    if(own(groupErrors,v.code))section.append(n('p',groupErrors[v.code],'warn'));
    if(v.status==='prepared'&&(sameGroup||latest===slot.messageId))section.append(
      act('确认这项商品变更',()=>stageMessageCommand(slot,sameGroup?'确认':'确认 '+v.intentId,
        sameGroup?'将确认这条商品预览中的'+label:'将引用这条商品变更预览')),
      act('取消这项商品变更',()=>stageMessageCommand(slot,sameGroup?'取消':'取消 '+v.intentId,'将取消这条商品变更预览')));
    return section;
  }
  function salesSection(slot,r,a){
    const section=n('section',undefined,'subreply'),v=salesResult(a,r,slot);
    section.dataset.action=a.action;section.append(n('h3',salesNames[a.action]));
    if(!v){section.append(n('p','这项回执的归属或来源未核实，未显示业务事实。','warn'));return section;}
    section.dataset.requestId=v.requestId;section.dataset.messageId=v.messageId;
    section.dataset.storeId=v.shopId??v.storeId;
    addTrace(section,'本店 '+section.dataset.storeId+' · 消息 '+v.messageId+' · 请求 '+v.requestId);
    if(a.action==='compare'){
      if(v.status==='catalog_unavailable'){section.append(n('p','本店商品目录暂不可读，尚未核实候选。'));return section;}
      if(v.status==='needs_clarification'){section.append(n('p','请补充预算或挑选要求。'));return section;}
      const c=v.criteria??{};
      if(money(c.budgetYuan))section.append(n('p','预算：'+c.budgetYuan+' 元以内'+(bounded(c.category,40)?' · '+c.category:'')+
        (bounded(c.purpose,40)?' · '+c.purpose:'')));
      if(v.status==='no_confirmed_match')section.append(n('p','没有已核实的本店候选；资料未知的不算符合。'));
      else{
        section.append(n('p','找到 '+v.items.length+' 件符合已登记条件的本店候选。'));
        const list=n('ol');
        for(const x of v.items){
          const li=n('li');
          li.dataset.productId=x.productId;li.dataset.productVersion=String(x.productVersion);
          li.append(n('strong',x.productId+' · '+x.price.amount+' 元'));
          addTrace(li,'卡 v'+x.productVersion+' · 售价来源：本店商品卡／'+factSource[x.price.source]+' · 字段 '+x.price.field);
          for(const [k,label] of Object.entries(factLabels)){
            const f=x.attributes?.[k];
            if(own(factSource,f?.source)&&(bounded(f.value,120)||Number.isFinite(f.value)))
              addTrace(li,label+'：'+f.value+(bounded(f.unit,16)?' '+f.unit:'')+' · '+factSource[f.source]);
          }
          list.append(li);
        }
        section.append(list);
      }
      const missing=[];
      if(Number.isSafeInteger(v.unknownPriceExcluded)&&v.unknownPriceExcluded>0)
        missing.push(v.unknownPriceExcluded+' 件缺已核售价未纳入');
      if(Number.isSafeInteger(v.unknownConditionExcluded)&&v.unknownConditionExcluded>0)
        missing.push(v.unknownConditionExcluded+' 件品类或用途未核实未纳入');
      if(missing.length)section.append(n('p',missing.join('；')+'。'));
      return section;
    }
    section.dataset.productId=v.productId;section.dataset.productVersion=String(v.productVersion);
    addTrace(section,'商品 '+v.productId+' · 卡 v'+v.productVersion);
    if(a.action==='stock'){
      const msg={unknown:'库存待核实，暂不承诺现货。',stale:'上次库存核实已过期，当前待核实。',
        in_stock:'最近的有效记录为有货；不是留货、发货或当前到手承诺。',out_of_stock:'最近的有效记录为无货。'};
      section.append(n('p',msg[v.inventoryState]));
      const e=v.inventoryEvidence;
      if(e&&v.inventoryState!=='unknown')addTrace(section,'本店库存核实记录：'+e.verifiedAt+' · '+e.verifiedBy+' · 依据 '+e.evidenceRef);
      else addTrace(section,'来源：本店商品；缺可靠的库存核实记录。');
      section.append(n('p',taskText[v.taskStatus]+' 未发送通知。'));
      if(id(v.taskId))addTrace(section,'核实待办 '+v.taskId);
      const dir=v.alternatives;
      const alternatives={directory_not_connected:'外部备选目录尚未接通。',directory_unavailable:'外部备选目录暂不可用。',
        no_match:'未找到已核实的外部备选。'};
      if(own(alternatives,dir?.status))section.append(n('p',alternatives[dir.status]));
      if(dir?.status==='matched'&&Array.isArray(dir.items)){
        const valid=dir.items.filter(x=>id(x?.candidateId)&&x.source==='supplier_directory'&&x.availabilityNotPromised===true);
        if(valid.length)addTrace(section,'供应目录候选（不等于本店有货）：'+valid.map(x=>x.candidateId).join('、'));
      }
      return section;
    }
    section.append(n('p','只供店主核对的草稿，未发送给客人，也没有下单。'));
    const price=v.facts?.price;
    addTrace(section,knownPrice(price)?'本店商品卡：售价 '+price.amount+' 元 · '+factSource[price.source]+' · '+price.field:
      '本店商品卡：售价待核实。');
    addTrace(section,v.facts?.dimensions==='confirmed_values_in_product_card'?'本件尺寸：商品卡已登记有效测量。':
      '本件尺寸待核实。');
    section.append(n('h4','客人原话（获准资料）'));
    if(!v.customerSaid.length)section.append(n('p','该会话没有可引用的客人话语。'));
    else for(const x of v.customerSaid){section.append(n('p',x.text));addTrace(section,'客人会话消息 '+x.messageId);}
    section.append(n('h4','给店主的回复草稿'));
    for(const text of v.suggestions)section.append(n('p',text));
    if(v.unanswered.length){section.append(n('h4','仍待核实'));for(const text of v.unanswered)section.append(n('p',text));}
    const ruleStates={not_connected:'店规入口未接通。',unavailable:'店规暂不可读。',none_verified:'无已核实店规。'};
    if(own(ruleStates,v.storeRules?.status))addTrace(section,ruleStates[v.storeRules.status]);
    if(v.storeRules?.status==='confirmed'&&Array.isArray(v.storeRules.items))
      for(const k of v.storeRules.items)if(id(k?.ruleId)&&version(k.version)&&bounded(k.text))addTrace(section,'已生效店规 '+k.ruleId+' v'+k.version+'：'+k.text);
    if(Array.isArray(v.knowledge))for(const k of v.knowledge)if(id(k?.entryId)&&version(k.version)&&id(k.excerptRef))
      addTrace(section,'已审知识 '+k.entryId+' v'+k.version+' · '+k.excerptRef);
    const transfer=v.humanHandoff,tr={requested:'待人工处理',active:'人工处理中',resolved:'已有处理记录'};
    if(transfer?.source==='existing_handoff_record'&&transfer.carriedOut===false&&own(tr,transfer.status)&&id(transfer.receiptId))
      addTrace(section,'既有人工记录：'+tr[transfer.status]+' · '+transfer.receiptId+'；本次未执行转交。');
    return section;
  }
  function productReadSection(slot,r){
    const s=n('section',undefined,'subreply');s.dataset.action='product_read';
    s.append(n('h3','商品资料（只读）'));
    const p=slot.p1=productReadReceipt(r,slot);
    if(!p){s.append(n('p','商品资料回执未核对，未显示资料或选定商品。','warn'));return s;}
    s.dataset.status=p.status;
    addTrace(s,'店 '+p.shopId+' · 本店商品卡 · 消息 '+slot.messageId+' · 请求 '+slot.requestId);
    if(!p.cards.length){
      const messages={
        not_found:'本店已核对的商品资料里没有匹配。这不代表店里没有货。',
        needs_clarification:'还不清楚你指哪件。请描述要找的商品，或回复明确的商品资料消息。',
        source_unavailable:'商品资料暂时读不到，未核实任何候选。请稍后再查。',
        version_conflict:'这条消息对应的商品卡版本已变化，请重新查本件。'
      };
      const copy=p.reason==='P1_CONDITION_UNSUPPORTED'?'查询条件还不明确，请说清品类、颜色或要查的字段。':
        p.reason==='P1_REFERENCE_CONFLICT'?'你说的商品和所回复的消息不一致。请明确要查哪件。':messages[p.status];
      s.append(n('p',copy,['source_unavailable','version_conflict'].includes(p.status)?'warn':undefined));return s;
    }
    if(p.status==='multiple'){
      s.append(n('p',p.total===p.cards.length?'找到 '+p.total+' 件，请明确选哪件；没有默认选第一件。':
        '找到 '+p.total+' 件，这里列出 '+p.cards.length+' 件；没有默认选第一件。'));
      s.append(n('p','指明这条结果和序号，例如「看上条结果里的第二件」。','muted'));
    }
    const list=n('ol',undefined,'product-read-cards');
    list.setAttribute('role','list');
    for(let i=0;i<p.cards.length;i++){
      const card=p.cards[i],box=n('li',undefined,'product-read-card'),order=i+1;
      box.dataset.productId=card.productId;box.dataset.productVersion=String(card.productVersion);
      box.dataset.ordinal=String(order);
      const suffix=card.alias?'货号 '+card.alias:'货号未列出';
      box.append(n('h4',(p.status==='multiple'?'第 '+order+' 件 · ':'本件 · ')+(card.facts.title?.value??suffix)),
        n('p',(card.facts.title?suffix+' · ':'')+'商品卡 v'+card.productVersion+' · 来源：本店商品卡（登记资料）'));
      const facts=n('dl',undefined,'product-read-fields');
      for(const [key,v] of Object.entries(card.facts)){
        const line=n('dd');line.dataset.field=key;line.dataset.source=v.source;
        line.append(n('span',v.value+(v.unit?' '+v.unit:'')),
          n('small',' · '+factSource[v.source]+(v.evidenceRef?' · 依据 '+v.evidenceRef:'')));
        facts.append(n('dt',p1Fields[key]),line);
      }
      if(facts.childNodes.length)box.append(facts);
      if(card.materialPending)box.append(n('p','材质待核实（商品卡没有可核验登记，不作鉴定）。','muted'));
      if(card.missing.length)box.append(n('p','商品卡未提供可核实字段：'+card.missing.map(k=>p1Fields[k]).join('、')+'。','muted'));
      if(p.status==='multiple')box.append(act('查看第 '+order+' 件资料',()=>stageMessageCommand(slot,
        '请查这条结果里的第'+order+'件商品资料。','本次只引用这一条候选列表')));
      list.append(box);
    }
    s.append(list);
    if(p.status==='matched')s.append(act('在下一条继续问这件',()=>{
      if(S.get(slot.messageId)!==slot)return;
      if(selected.length){note('请先移除这条草稿中的照片，再引用这件商品。');return;}
      reference=slot.messageId;photoContinuation=false;scopedReply=true;
      note('下一条将引用这条商品资料；请输入问题。');prompt.focus();
    }));
    return s;
  }
  function render(slot,r,error){
    const h=slot.reply;
    slot.commitPin=null;
    slot.p1=null;
    h.replaceChildren();
    const details=r&&slot.batch?classificationReceipt(r,slot.batch,slot):null;
    if(slot.batch&&!slot.suppressGallery)h.append(gallery(slot,classification(details,slot.batch,r??{})));
    if(error){
      h.append(n('p',groupErrors[error]??statusLabel[error]??'这条消息未取得有效回执，可以按同一请求重试。','warn'));
      if(own(groupErrors,error))h.lastElementChild.dataset.code=error;
      if(slot.text&&!own(groupErrors,error))h.append(act('重试此条',()=>{startLatestTurn(slot);void run(slot)}));
    }else if(hasP1(r)){
      // Product-read cannot add a quote, video, or any actionable second
      // result. A mixed envelope is not a verified product-read receipt.
      h.append(productReadSection(slot,r));
    }else if(r){
      if(r.status==='needs_photos'||r.status==='needs_album'){
        h.append(n('p','请授权本次需要整理的照片。取消或拒绝不会建立批次。'));
        h.append(act('选照片继续此条',()=>{
          reference=slot.messageId;photoContinuation=true;scopedReply=false;prompt.value=slot.text;pick();
        }));
      }else if(!r.actions?.length&&(own(groupErrors,r.code)||own(d3Errors,r.code)||own(saleErrors,r.code))){
        const panel=n('section',undefined,'subreply');
        const copy=groupErrors[r.code]??d3Errors[r.code]??saleErrors[r.code];
        panel.dataset.code=r.code;panel.append(n('p',copy,r.status==='failed'?'warn':undefined));
        addTrace(panel,'本店 '+(r.shopId??r.storeId)+' · 来源：本机处理回执 · 消息 '+r.messageId+' · 请求 '+r.requestId);
        h.append(panel);
      }else if(r.status==='needs_clarification')h.append(n('p',typeof r.message==='string'?r.message:'你指的是哪件？请说货号或回复那一件的消息。'));
      else if(r.status==='unsupported')h.append(n('p',typeof r.message==='string'?r.message:'目前还没有接通这项操作。'));
      else if(r.status==='failed'&&!r.actions?.length)h.append(n('p','这条消息的业务处理未完成。','warn'));
      else if(details?.status==='classified_read_only')addTrace(h,'品类读回请求 '+details.requestId);
      let bound=false;
      for(const a of Array.isArray(r.actions)?r.actions:[]){
        if(salesKinds.includes(a?.action)){h.append(salesSection(slot,r,a));continue;}
        if(own(d3Kinds,a?.action)){h.append(d3Section(slot,r,a));continue;}
        if(a?.action==='album_draft'){h.append(groupSection(slot,r,a));continue;}
        if(a?.action==='catalog_write'){h.append(catalogSection(slot,r,a));continue;}
        if(!['quote','old_video'].includes(a?.action)||!matchingAction(a,r,slot))continue;
        const section=n('section',undefined,'subreply');
        section.dataset.action=a.action;section.dataset.productId=a.productId;
        section.append(n('h3',a.action==='quote'?'售价':'本件旧片'));
        addTrace(section,'商品 '+a.productId+' · 卡 v'+a.productVersion+' · 请求 '+a.requestId);
        bound=true;
        if(a.action==='quote'){
          if(a.status==='known'&&a.price?.currency==='CNY'&&/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,2})?$/.test(a.price.amount)&&
            a.source?.kind==='catalog_sale_price'&&typeof a.price.source==='string'&&a.price.source){
            section.append(n('p','卡上记录的售价为 '+a.price.amount+' 元。'));
            addTrace(section,'依据：本店商品卡 · '+(a.source.recordedSource??a.price.source));
          }else if(a.status==='unknown'&&a.price==null)section.append(n('p','本店卡还未登记售价，待核实。'));
          else section.append(n('p','本件售价暂未取得可核实回执。','warn'));
        }else if(a.status==='no_verified_old_clip')section.append(n('p','本件没有已批准可看的旧片。'));
        else if(a.status==='existing_available')showClip(section,slot,a);
        else if(a.status==='needs_current_media_lookup')section.append(n('p','这是历史回执。请重新查本件以取得当前播放许可。'));
        else section.append(n('p','本件旧片暂未核实，没有制作新片。','warn'));
        h.append(section);
      }
      if(bound)h.append(act('在下一条继续问这件',()=>{
        reference=slot.messageId;photoContinuation=false;scopedReply=false;
        note('下一条将引用此条商品回执；可直接输入问题。');prompt.focus();
      }));
      if(!h.firstChild)h.append(n('p','已收到本机回复，尚无可展示的业务结果。'));
    }
    if(slot.requestId)addTrace(h,'消息 '+slot.messageId+' · 请求 '+slot.requestId);
  }
  function encode(file,index){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>{
        const parts=typeof reader.result==='string'?reader.result.split(','):[];
        if(parts.length!==2||!parts[0].endsWith(';base64')||!parts[1])reject(Error('unread_file_'+(index+1)));
        else resolve(parts[1]);
      };
      reader.onerror=reader.onabort=()=>reject(Error('unread_file_'+(index+1)));
      reader.readAsDataURL(file);
    });
  }
  async function run(slot){
    if(slot.busy)return;
    slot.busy=true;
    if(player?.v?.dataset.messageId===slot.messageId)clearPlayer();
    slot.reply.replaceChildren(n('p','正在处理这条消息…'));
    try{
      if(slot.correction){
        const {body:v,receiptHeader}=await api(DRAFTS+'/correct',{requestId:slot.requestId,messageId:slot.messageId,
          replyToMessageId:slot.replyToMessageId,...slot.correction});
        const a={action:'album_draft',status:v.status,result:v}, r={shopId:v.shopId,status:'draft_only',
          requestId:v.requestId,messageId:v.messageId,actions:[a]};
        if(receiptHeader!==slot.requestId||!groupDraftView(a,r,slot)||!draftAssets(v,slot.batch)||
          v.draftVersion!==slot.correction.expectedDraftVersion+1||currentStore&&v.shopId!==currentStore)
          throw Error('bad_draft_receipt');
        currentStore=v.shopId;storeMessage(slot,r);render(slot,r,null);return;
      }
      if(!slot.batch&&slot.files.length){
        slot.data??=await Promise.all(slot.files.map(encode));
        const u=await api(ROOT,{requestId:slot.batchRequestId,messageId:slot.messageId,files:slot.data});
        if(u.receiptHeader!==slot.batchRequestId||!batchMatches(u.body,{requestId:slot.batchRequestId,messageId:slot.messageId}))throw Error('bad_batch_receipt');
        slot.batch=u.body;slot.files=[];slot.data=undefined;
        saveLast(slot.batch.batchId);
        slot.reply.replaceChildren(gallery(slot,new Map()),n('p','正在等这条消息的分类或其他可用结果…'));
      }
      const {body:r,receiptHeader}=await api(TURN,{requestId:slot.requestId,messageId:slot.messageId,text:slot.text,
        ...(slot.replyToMessageId?{replyToMessageId:slot.replyToMessageId}:{}),...(slot.batch?{batchId:slot.batch.batchId}:{})});
      if(receiptHeader&&receiptHeader!==slot.requestId||!turnMatches(r,slot))throw Error('bad_message_receipt');
      const store=r.shopId??r.storeId;
      if(currentStore&&currentStore!==store)throw Error('store_scope_changed');
      currentStore=store;storeMessage(slot,r);render(slot,r,null);
    }catch(e){
      const code=String(e?.message??'');
      if(/^unread_file_[0-9]+$/.test(code)){
        slot.data=undefined;
        render(slot,null,'unread_file');
        slot.reply.prepend(n('p','第 '+code.slice(12)+' 张暂时读不到，未创建批次。可重新选择后发送。','warn'));
      }else render(slot,null,code);
    }finally{slot.busy=false;}
  }
  function pick(){
    input.value=''; // document picker only; cancellation leaves this draft, never sends a batch
    $('clearPhotos').hidden=!(selected.length||photoContinuation);
    input.click();
  }
  input.addEventListener('change',()=>{
    const f=Array.from(input.files??[]);
    if(!f.length){note('未选择新照片，未建立批次。');return;}
    if(f.length>byteLimit[0]||f.some(x=>!x.size||x.size>byteLimit[1])||f.reduce((n,x)=>n+x.size,0)>byteLimit[2]){
      selected=[];input.value='';
      note('请选择 1–12 张，单张不超过 8 MiB，合计不超过 36 MiB。暂未创建批次。');
      return;
    }
    selected=f;
    note('已选 '+f.length+' 张。点发送才读取这次选图，不扫描相册。');
  });
  input.addEventListener('cancel',()=>{
    if(!selected.length&&photoContinuation){reference=null;photoContinuation=false;}
    note(selected.length?'未改选，仍保留草稿中 '+selected.length+' 张；尚未提交。':'已取消选图，未创建批次。');
  });
  $('choose').addEventListener('click',pick);
  $('clearPhotos').addEventListener('click',()=>{
    selected=[];input.value='';
    if(photoContinuation){reference=null;photoContinuation=false;}
    note('已经移除此消息的选图。手机原照片不变。');
  });
  $('composer').addEventListener('submit',ev=>{
    ev.preventDefault();
    const text=prompt.value.trim();
    if(!text||text.length>500){note('请直接说你要做什么，限 500 字。');return;}
    if(scopedReply&&selected.length){note('这条操作使用已确认来源。请移除草稿选图后再发送。');return;}
    if(photoContinuation&&!selected.length){note('请先选照片，或移除此条选图要求。');$('clearPhotos').hidden=false;return;}
    let slot;
    const reply=reference??(!selected.length&&!photoContinuation?p1ListReply(text,S.get(latest)):null);
    try{slot=addSlot({text,messageId:bind(),requestId:bind(),files:[...selected],replyToMessageId:reply,
      commitReference:reply?S.get(reply)?.commitPin??null:null,
      ...(selected.length?{batchRequestId:bind()}:{})});}
    catch{note('本机浏览器缺少请求号支持，未提交。');return;}
    startLatestTurn(slot);prompt.value='';selected=[];input.value='';reference=null;photoContinuation=false;scopedReply=false;
    note('只读取你为这条消息选的照片。');void run(slot);
  });
  $('recover').hidden=!id(last());
  $('recover').addEventListener('click',async ()=>{
    const key=last(); if(!id(key))return;
    const b=$('recover');b.disabled=true;
    try{
      const x=await api(ROOT+'/'+key);
      if(x.receiptHeader!==x.body.requestId||!batchMatches(x.body,{batchId:key}))throw Error('bad_batch_receipt');
      if([...S.values()].some(m=>m.batch?.batchId===key))return;
      const slot=addSlot({text:'恢复已整理的照片批次',messageId:x.body.messageId,requestId:x.body.requestId,files:[],batch:x.body});
      render(slot,null,null);
    }catch{$('connection').textContent='这里暂时读不到上次的批次。';}
    finally{b.disabled=false;}
  });
  async function restoreMessage(){
    const p=messagePin(),epoch=restoreEpoch,b=$('resume');
    if(!p||latest||restoring)return;
    const live=()=>!latest&&epoch===restoreEpoch&&sameLocator(p,messagePin());
    restoring=true;b.hidden=true;b.disabled=true;
    try{
      const {body:r,receiptHeader}=await api(MSG+p.messageId);
      if(!live())return;
      if((receiptHeader&&receiptHeader!==p.requestId)||!turnMatches(r,p)||!sameLocator(resumeFor(r,p),p)||
        (currentStore&&currentStore!==p.shopId))throw Error('resume_message_scope');
      if(p.kind==='album_draft'){
        const x=await api(DRAFTS+'/'+p.batchId);
        if(!live())return;
        if(x.body?.shopId!==p.shopId||x.body.batchId!==p.batchId||!version(x.body.draftVersion))
          throw Error('resume_message_scope');
        knownDrafts.set(p.batchId,x.body.draftVersion);
        const slot=addSlot({...p,text:p.question??'已恢复本次对话的分组消息',files:[]});
        currentStore=p.shopId;alignLatest(slot);render(slot,r,null);
        slot.reply.prepend(n('p','已读回原分组消息。没有重新整理或写商品。','muted'));return;
      }
      if(p.kind==='product_read'){
        const slot=addSlot({...p,text:p.question??'已恢复本次对话的商品资料消息',files:[]});
        currentStore=p.shopId;alignLatest(slot);render(slot,r,null);
        slot.reply.prepend(n('p','已读回原查询结果；没有重新搜索或选定商品。','muted'));return;
      }
      // Existing read-only P1 lookup rechecks the message-owned card AND current version.
      // This is not /turn and does not use the old message wording, a global card or a model.
      const checkId=bind();
      const card=await api(CHECK_CARD,{requestId:checkId,messageId:p.messageId,text:'复核此条已保存的商品引用',
        reference:p.messageId,intent:'detail'});
      if(!live())return;
      if((card.receiptHeader&&card.receiptHeader!==checkId)||!restoredCard(card.body,checkId,p))throw Error('resume_card_scope');
      const actions=Array.isArray(r.actions)?[...r.actions]:[];
      const indexes=actions.map((a,i)=>a?.action==='old_video'?i:-1).filter(i=>i>=0);
      if(indexes.length>1)throw Error('resume_clip_shape');
      if(indexes.length){
        const i=indexes[0],old=actions[i];
        if(!matchingAction(old,r,p))throw Error('resume_clip_scope');
        if(['existing_available','no_verified_old_clip'].includes(old.status)){
          const readId=bind();
          const query=new URLSearchParams({requestId:readId,messageId:p.messageId,
            productId:p.productId,productVersion:String(p.productVersion)});
          const meta=await api(CHECK_CLIP+'?'+query.toString());
          if(!live())return;
          if(meta.receiptHeader&&meta.receiptHeader!==readId)throw Error('resume_clip_scope');
          const approved=restoredClip(meta.body,readId,p,old,origin);
          if(!approved)throw Error('resume_clip_scope');
          actions[i]=approved;
        }
      }
      if(!live())return;
      currentStore=p.shopId;
      const slot=addSlot({...p,text:p.question??'已恢复本次对话的原商品消息',files:[]});
      alignLatest(slot);render(slot,{...r,actions},null);
      const isContent=actions.some(a=>own(d3Kinds,a?.action));
      slot.reply.prepend(n('p',isContent?'已读回这条内容消息，没有重新制作或采用。':'已恢复本次对话的原商品回执。','muted'));
    }catch(e){
      if(!live())return;
      const retryable=e instanceof TypeError||/^HTTP_5[0-9]{2}$/.test(e?.message)||
        ['OLD_VIDEO_SOURCE_UNAVAILABLE','SERVICE_ERROR'].includes(e?.message);
      if(retryable){b.textContent='重试恢复本次消息';b.hidden=false;}
      else clearMessagePin();
      $('connection').textContent=retryable?'本次原消息暂未读到；没有重新发问。':'原消息、卡片或作品已不可核实；没有重新发问。';
    }finally{restoring=false;b.disabled=false;}
  }
  $('resume').hidden=true;
  $('resume').addEventListener('click',()=>void restoreMessage());
  api('/api/n22/capabilities').then(({body})=>{
    $('connection').textContent='已连接本机助手。';
    if(body.authenticated===true){d3Mounted=body.contentD3==='mounted_in_isolated_write_fixture';void restoreMessage();}
  }).catch(()=>{$('connection').textContent='本机业务接线暂未核实。提交会按真实回执显示。';});
})();
