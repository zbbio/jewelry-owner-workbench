    // Isolated fixture overlay. Added to the ordinary composer; no writes outside /turn.
    const change=r?.actions?.find?.(a=>a?.action==='catalog_write')?.result;
    if(change&&change.fixtureOnly===true){
      const sec=n('section',undefined,'subreply');sec.dataset.action='catalog_write';sec.dataset.writeStatus=change.status;
      const view=change.preview??{},receipt=change.receipt;
      const state={prepared:'待确认：尚未修改商品',committed:'已提交',cancelled:'已取消：未修改商品',
        conflict:'版本或归属冲突：未覆盖，请重读再发起',expired:'确认已过期',committing:'正在确认'};
      sec.append(n('h3',state[change.status]??'隔离商品操作'),n('p','隔离测试店，不是正式商品。'));
      const operation={create:'建档',attach:'补图',update:'改资料'}[change.operation]??'资料';
      addTrace(sec,operation+' · 确认号 '+change.intentId);
      if(view.productId)addTrace(sec,'对象 '+view.productId+' · 预期版本 v'+view.expectedVersion);
      else if(view.groupId)addTrace(sec,'将新建一张隔离卡。');
      if(view.groupId){
        addTrace(sec,'组 '+view.groupId+' · 组 v'+view.groupVersion+' · 批次 '+view.batchId);
        addTrace(sec,'本次素材：'+(view.assetIds??[]).join('、'));
        addTrace(sec,'拟新增关联：'+(view.willAttach??[]).length+' 张');
      }
      if(view.difference){
        const diff=view.difference,val=q=>q?q.value+' '+(q.unit??''):'未填';
        const label=diff.field==='price'?'售价':'尺寸';
        sec.append(n('p',label+'：'+val(diff.before)+' → '+val(diff.after)));
      }
      if(receipt)addTrace(sec,'商品 '+receipt.productId+' · 卡 v'+receipt.productVersion+' · '+receipt.outcome);
      if(change.code)addTrace(sec,change.code+(change.currentVersion?' · 当前 v'+change.currentVersion:''));
      if(change.status==='prepared'&&id(change.intentId)){
        const fill=(verb)=>{reference=slot.messageId;photoContinuation=false;prompt.value=verb+' '+change.intentId;
          note('请核对上面的对象与差异，再点发送。');prompt.focus();};
        sec.append(act('确认这项',()=>fill('确认')),act('取消这项',()=>fill('取消')));
      }
      h.append(sec);
      if(slot.requestId)addTrace(h,'消息 '+slot.messageId+' · 请求 '+slot.requestId);
      return;
    }
