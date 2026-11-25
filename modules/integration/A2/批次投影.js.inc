  // A2 owns only the album projection, never the topic navigation or model selector.
  const A2_VERSION='n99-a2.album-classify-view/1.0.0';
  const A2_TOOL='album_classify_batch', A2_TOOL_VERSION='n99-a1.album-classify-batch/1.0.0';
  const A2_SCOPE=['conversationId','messageId','runId','requestId'];
  const a2Same=(x,y)=>A2_SCOPE.every(k=>id(x?.[k])&&x[k]===y?.[k]);
  const a2Kinds=[
    ['pixel_rule','pixelRule','图像首判（像素规则）'],
    ['image_inference','imageInference','图像首判（视觉模型）'],
    ['original_label','originalLabel','原表照录'],
    ['human','humanCorrection','人工确认']
  ];
  function a2Evidence(item){
    const values=[];
    for(const [source,k,name] of a2Kinds){
      const v=item?.evidence?.[k];
      if(v?.source!==source||!id(v.evidenceRef)||!(v.category===null||own(categories,v.category)))continue;
      if(source==='pixel_rule'&&(typeof v.decoded!=='boolean'||!id(v.ruleId)||!id(v.ruleVersion)||
        !/^PIXEL_[A-Z_]{1,64}$/u.test(v.reason??'')||v.category!==null&&(v.decoded!==true||v.confidence!=='heuristic_strong')))continue;
      if(source==='image_inference'&&(!id(v.modelId)||!id(v.modelVersion)))continue;
      if(source==='original_label'&&(!id(v.sourceVersion)||v.category===null))continue;
      if(source==='human'&&(!version(v.reviewVersion)||v.category===null))continue;
      values.push({source,name,category:v.category,evidenceRef:v.evidenceRef,
        revision:source==='pixel_rule'?v.ruleVersion:source==='image_inference'?v.modelVersion:
          source==='original_label'?v.sourceVersion:String(v.reviewVersion)});
    }
    return values;
  }
  function a2View(b,p2,raw){
    if(!p2||!batchMatches(b,{messageId:raw?.messageId})||!classificationScope(p2,b,raw)||
        p2.items.length!==b.items.length||own(p2,'productId')||own(p2,'productVersion')||
        (p2.batchOriginMessageId!==undefined&&p2.batchOriginMessageId!==b.messageId))return null;
    const matches=classification(p2,b,raw); // existing provenance gate
    const found=new Map();
    for(const x of p2.items){
      if(!id(x?.itemId)||found.has(x.itemId))return null;
      found.set(x.itemId,x);
    }
    const byItem=new Map(), counts={pixel_rule:0,image_inference:0,original_label:0,human:0,pending:0,duplicate:0,not_authorized:0,unreadable:0};
    for(const a of b.items){
      const x=found.get(a.itemId);
      if(!x)return null;
      if(a.status==='duplicate'){
        const exact=x.status==='duplicate'&&x.duplicateOf===a.duplicateOf&&x.reason==='EXACT_BYTES';
        byItem.set(a.itemId,{status:exact?'duplicate':'duplicate_unverified',evidence:[]});
        if(exact)counts.duplicate++;else counts.pending++;
        continue;
      }
      if(a.status==='failed'){
        if(x.status!=='unreadable')return null;
        counts.unreadable++;byItem.set(a.itemId,{status:'unreadable',evidence:[]});continue;
      }
      if(x.status==='not_authorized'){
        if(x.assetId!==null||x.category!==null||x.source!==null||x.thumbnailRef!=null||x.evidence!=null)return null;
        counts.not_authorized++;byItem.set(a.itemId,{status:x.status,evidence:[]});continue;
      }
      if(!['suggested','classified','pending'].includes(x.status)||x.assetId!==a.assetId||
         (x.assetSha256!==undefined&&x.assetSha256!==a.sha256)||x.thumbnailRef!==undefined&&x.thumbnailRef!==thumbnail(b.batchId,a))
        return null;
      const evidence=a2Evidence(x);
      for(const e of evidence)if(e.category!==null)counts[e.source]++;
      const m=matches.get(a.assetId);
      const effective=m&&evidence.some(e=>e.source===m.source&&e.evidenceRef===m.evidenceRef&&e.category===m.category)?m:null;
      if(!effective)counts.pending++;
      byItem.set(a.itemId,{status:effective?.status??'pending',effective,evidence});
    }
    return {byItem,counts,messageId:raw.messageId,requestId:raw.requestId};
  }
  // No network client here. P/S supply the live, authorized full receipt separately
  // from the S1 assistant summary. K1 supplies the current message and topic.
  function a2ConversationAlbum(row,current,published){
    const summary=row?.assistant;
    if(!id(current?.conversationId)||row?.conversationId!==current.conversationId||!a2Same(summary,row)||
       !Array.isArray(summary.actions))return null;
    const hints=summary.actions.filter(a=>a?.tool===A2_TOOL);
    if(hints.length!==1)return null;
    const hint=hints[0];
    if(hint.toolVersion!==A2_TOOL_VERSION||!id(hint.callId)||!id(hint.receiptId))return null;
    if(hint.status==='needs_photos'&&row.code==='NEEDS_PHOTOS')return {status:'needs_photos'};
    if(hint.status!=='classified')return {status:'unavailable'};
    const b=published?.batch,r=published?.result;
    if(published?.receiptId!==hint.receiptId||published?.callId!==hint.callId||published?.toolName!==A2_TOOL||
       !id(current.shopId)||r?.shopId!==current.shopId||!a2Same(r,row)||r?.status!=='completed'||
       !batchMatches(b,{messageId:row.messageId}))return {status:'unavailable'};
    const p2=classificationReceipt(r,b,row);
    const v=a2View(b,p2,r);
    return v?{status:'classified',receiptId:hint.receiptId,batch:b,view:v}:{status:'unavailable'};
  }
