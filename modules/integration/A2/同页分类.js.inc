  function gallery(slot,matches,view){
    const b=slot.batch, el=n('section',undefined,'albums');
    el.dataset.batchId=b.batchId;
    el.append(n('h3','本次照片整理'),n('p','已选 '+b.counts.selected+' 张 · 保留 '+b.counts.kept+' · 精确重复 '+b.counts.duplicate+
      ' 张 · 读取失败 '+b.counts.failed+' 张。未建档、未挂到商品；原照片不变。'));
    addTrace(el,'批次 '+b.batchId+' · 导入请求 '+b.requestId);
    if(view){
      el.dataset.albumResult=A2_VERSION;el.dataset.messageId=view.messageId;el.dataset.requestId=view.requestId;
      const c=view.counts, marks=n('p','图像首判（像素规则） '+c.pixel_rule+' · 图像首判（视觉模型） '+c.image_inference+
        ' · 原表照录 '+c.original_label+' · 人工确认 '+c.human+' · 待认 '+c.pending+' · 重复 '+c.duplicate+
        (c.not_authorized?' · 已不可读 '+c.not_authorized:''));
      marks.dataset.a2Counts='true';
      el.append(n('p','以下只按品类展示，同品类不代表同一件。'),marks);
      addTrace(el,'分类消息 '+view.messageId+' · 分类请求 '+view.requestId);
    }
    const buckets=new Map();
    for(const a of b.items){
      const item=view?.byItem.get(a.itemId);
      const ev=view?item?.effective:matches.get(a.assetId);
      const g=ev?.category??(item?.status==='not_authorized'?'denied':item?.status==='duplicate_unverified'?'duplicate_unverified':
        a.status==='kept'?'pending':a.status);
      if(!buckets.has(g))buckets.set(g,[]);
      buckets.get(g).push([a,ev,item]);
    }
    for(const [g,rows] of buckets){
      const label=categories[g]??({pending:'待确认品类',duplicate:'完全重复，不重复保留',
        duplicate_unverified:'重复关系待核',failed:'本次未读入',denied:'原图已不可读取'}[g]);
      const group=n('h4',label+'（'+rows.length+' 张）');group.dataset.a2Bucket=g;el.append(group);
      for(const [a,ev,item] of rows){
        const row=n('div',undefined,'photo-row'),desc=n('div');
        const denied=item?.status==='not_authorized', link=thumbnail(b.batchId,a);
        row.dataset.itemId=a.itemId;row.dataset.status=a.status;row.dataset.ordinal=String(a.ordinal);
        if(item)row.dataset.a2Status=item.status;
        if(a.assetId&&!denied)row.dataset.assetId=a.assetId;
        if(a.duplicateOf&&item?.status!=='duplicate_unverified')row.dataset.duplicateOf=a.duplicateOf;
        if(ev){row.dataset.category=ev.category;row.dataset.classificationSource=ev.source;}
        if(a.status==='kept'&&!denied&&link){
          const img=n('img');img.alt='本次选图第 '+(a.ordinal+1)+' 张';img.decoding='async';img.referrerPolicy='no-referrer';
          img.src=scopedPath(link);
          img.addEventListener('error',()=>{if(img.isConnected){img.remove();desc.append(n('small','原图暂不可读取，未替换为其他图。'));}});
          row.append(img);
        }
        const status=ev?categories[ev.category]+(ev.status==='suggested'?'（建议）':''):
          denied?'原图已不可读取':item?.status==='duplicate_unverified'?'重复待核':
          a.status==='kept'?'品类待确认':a.status==='duplicate'?'字节完全相同':'读取失败';
        desc.append(n('strong','第 '+(a.ordinal+1)+' 张 · '+status),n('small','来源：本次选图'+(ev?' · '+sourceLabel[ev.source]:'')));
        if(a.assetId&&!denied)desc.append(n('small','素材 '+a.assetId));
        if(a.duplicateOf&&item?.status!=='duplicate_unverified'){
          const prev=b.items.find(v=>v.status==='kept'&&v.assetId===a.duplicateOf&&v.sha256===a.sha256);
          const pin=prev&&(!view||view.byItem.get(prev.itemId)?.status!=='not_authorized');
          desc.append(n('small',pin?'与本批第 '+(prev.ordinal+1)+' 张的原始字节相同。':'与获准入批时的原字节重复；不另保留。'));
        }
        if(item&&!denied)for(const e of item.evidence){
          const summary=e.category===null?'证据不足（待认）':categories[e.category]+(e.source==='pixel_rule'||e.source==='image_inference'?'（建议）':'');
          const source=n('small',e.name+'：'+summary+' · 版本 '+e.revision+' · 依据 '+e.evidenceRef);
          source.dataset.a2Source=e.source;desc.append(source);
        }
        if(ev&&!item)desc.append(n('small','依据 '+ev.evidenceRef));
        if(a.status==='failed')desc.append(n('small',a.reason==='intake_decoder_unavailable'?'本机解码器暂不可用，可稍后重新选图。':'文件损坏或图像格式不支持。'));
        row.append(desc);el.append(row);
      }
    }
    return el;
  }
  function a2NeedsPick(pickForActive,classify=true){
    const section=n('section',undefined,'subreply');section.dataset.a2Status='needs_photos';
    section.append(n('p',classify?'请为这条消息选择要按品类整理的照片。取消或拒绝不会建立批次，也不会建档。':'请授权本次需要整理的照片。取消或拒绝不会建立批次。'));
    if(typeof pickForActive==='function')section.append(act('选照片继续此条',pickForActive));
    else section.append(n('small','此入口尚未接通本条选图授权；没有创建批次。'));
    return section;
  }
  // Called inside the existing K1 ordinary-message component, not another
  // frontend or route. The host's optional picker callback must use a trusted
  // admission for the active topic/message; absent upstream permission = no button.
  function a2RenderConversationAlbum(row,current,published,options={}){
    const panel=a2ConversationAlbum(row,current,published);
    if(!panel)return null;
    if(panel.status==='needs_photos')return a2NeedsPick(typeof options.choose==='function'&&
      typeof options.isCurrent==='function'?()=>{
        if(options.isCurrent(row)===true)options.choose(row);
      }:null);
    if(panel.status==='classified')return gallery({batch:panel.batch},new Map(),panel.view);
    const section=n('section','这条消息没有可核验的逐图回执；未显示照片或猜测分类。','subreply');
    section.dataset.a2Status='unavailable';return section;
  }
  Object.defineProperty(window,'N99A2AlbumResultView',{value:Object.freeze({
    version:A2_VERSION,renderConversation:a2RenderConversationAlbum
  }),enumerable:false,writable:false,configurable:false});
