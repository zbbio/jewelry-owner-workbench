(() => {
  const script=document.currentScript;
  const $=id=>document.getElementById(id);
  let previous="";
  const api=async(path,body)=>{
    const r=await fetch("/demo/api/"+path,body ? {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)} : {cache:"no-store"});
    const data=await r.json();if(!r.ok)throw Error(data.error||"连接暂不可用");return data;
  };
  function show(node,messages,owner=false) {
    const stamp=JSON.stringify(messages);if(stamp===previous)return;previous=stamp;
    node.replaceChildren(...messages.map(m=>{
      const el=document.createElement("div"),label=document.createElement("small");
      el.className="ar-message";el.dataset.role=m.role;el.dataset.messageId=m.id;
      label.textContent=m.role==="customer"?"顾客":m.status==="failed"?"系统提示":"销售助理 · 已回复";
      el.append(label,document.createTextNode(m.text));
      if (m.role==="assistant" && m.mediaUrl?.startsWith("https://")) {
        const link=document.createElement("a");link.href=m.mediaUrl;link.target="_blank";link.rel="noopener noreferrer";
        link.textContent="查看这款上手实拍";el.append(document.createElement("br"),link);
      }
      if(owner && m.sources?.length){const source=document.createElement("code");source.textContent="资料："+m.sources.join("；");el.append(source);}
      return el;
    }));
    node.scrollTop=node.scrollHeight;
  }
  function focusMessage(node,id) {
    const message=Array.from(node.children).find(el=>el.dataset.messageId===id);
    if(message) {message.style.outline="2px solid #9b5775";message.style.outlineOffset="-2px";const top=message.getBoundingClientRect().top-node.getBoundingClientRect().top;if(top<0||top+message.offsetHeight>node.clientHeight)node.scrollTop+=top;}
  }
  if(script.dataset.view==="owner"){
    const allowedParents=[location.origin];
    const referrer=document.referrer?new URL(document.referrer).origin:"";
    const parentOrigin=parent!==window && allowedParents.includes(referrer)?referrer:null;
    let selected=null,threads=[],threadListStamp="",followLatest=true;
    window.addEventListener("message",({origin,source,data})=>{
      if(!parentOrigin||origin!==parentOrigin||source!==parent||data?.type!=="anran-sales-focus")return;
      if(!threads.some(t=>t.id===data.threadId))return;
      selected=data.threadId;followLatest=false;render();
      focusMessage($("ar-owner-messages"),data.messageId);
    });
    function render(){
      if(followLatest || !selected || !threads.some(t=>t.id===selected)) selected=threads[0]?.id||null;
      const list=threads.map(t=>t.id).join(",")+"|"+selected;
      if(list!==threadListStamp){
        threadListStamp=list;
        $("ar-threads").replaceChildren(...threads.map(t=>{
          const button=document.createElement("button");button.type="button";
          button.textContent="顾客 "+t.id.slice(0,8);button.setAttribute("aria-pressed",String(t.id===selected));
          button.onclick=()=>{selected=t.id;followLatest=false;render();};return button;
        }));
      }
      const current=threads.find(t=>t.id===selected);
      $("ar-owner").dataset.threadId=current?.id||"";
      $("ar-thread-title").textContent=current?"顾客 "+current.id.slice(0,8):"等待顾客来信";
      show($("ar-owner-messages"),current?.messages||[],true);
    }
    (async function poll(){
      try{
        if(parentOrigin){
          const data=await api("owner?"+new URLSearchParams({watch:"1",focus:selected||""}));
          threads=data.threads;
          parent.postMessage({type:"anran-sales-feed",reply:data.latestReply},parentOrigin);
        }else{threads=await api("owner");}
        render();$("ar-connection").textContent="已连接 · 自动同步";
      }
      catch{$("ar-connection").textContent="正在重新连接…";}
      setTimeout(poll,850);
    })();
    return;
  }
  const sku=script.dataset.sku||null;
  const root=document.createElement("div");root.className="ar-demo";
  root.innerHTML=`<section class="ar-panel" id="ar-panel" aria-label="客服会话" hidden>
  <div class="ar-head"><strong>示例店铺 · 客服</strong><button class="ar-close" id="ar-close" type="button" aria-label="收起客服">×</button></div>
  <div class="ar-context" id="ar-context"></div>
  <div id="ar-guest-messages" class="ar-log" role="log" aria-label="聊天消息"></div>
  <div class="ar-state" id="ar-state" role="status"></div>
  <form id="ar-compose" class="ar-compose"><textarea id="ar-question" class="ar-input" rows="1" maxlength="350" aria-label="输入问题" placeholder="想了解这件珠宝？"></textarea><button class="ar-submit" id="ar-submit" type="submit">发送</button></form>
  </section><button class="ar-launch" id="ar-open" type="button" aria-expanded="false" aria-controls="ar-panel">客服</button>`;
  document.querySelector(".storefront-only .phone").append(root);
  const transcript=$("ar-guest-messages");
  let followLatest=true;
  transcript.addEventListener("scroll",()=>{
    followLatest=transcript.scrollHeight-transcript.clientHeight-transcript.scrollTop<=3;
  },{passive:true});
  // A shorter viewport must keep a transcript already at the bottom pinned there.
  if(typeof ResizeObserver==="function") new ResizeObserver(()=>{
    if(!transcript.clientHeight)return;
    if(followLatest)transcript.scrollTop=transcript.scrollHeight;
  }).observe(transcript);
  if(sku){
    const image=document.createElement("img");image.src="/demo/product-image?sku="+encodeURIComponent(sku);image.alt="";
    const title=document.createElement("span");title.textContent=script.dataset.name+" · "+sku;
    $("ar-context").classList.add("ar-product");$("ar-context").append(image,title);
  }
  else if(script.dataset.view==="mirror") {
    $("ar-context").textContent="本轮未绑定商品";
  }
  else {
    $("ar-context").append("未选商品 · ");
    const a=document.createElement("a");a.href="/demo/shop?sku=DEMO105";a.textContent="查看 105 号演示商品";$("ar-context").append(a);
  }
  let opening=false,sending=false,lastFailed=null;
  const status=value=>{$("ar-state").textContent=value;};
  if(script.dataset.view==="mirror"){
    $("ar-compose").remove();$("ar-open").remove();$("ar-close").remove();
    $("ar-panel").hidden=false;
    status("同一顾客会话 · 只读");
    const {thread,message}=script.dataset;
    api("owner-shop?"+new URLSearchParams({thread,message})).then(data=>{
      $("ar-panel").dataset.threadId=data.id;
      show($("ar-guest-messages"),data.messages);
      focusMessage($("ar-guest-messages"),message);
    }).catch(e=>status(e.message));
    return;
  }
  const display=thread=>{
    $("ar-panel").dataset.threadId=thread.id;
    show($("ar-guest-messages"),thread.messages);
    status(thread.messages.some(m=>m.status==="pending")?"助理正在查资料…":"在线 · 自动回复");
  };
  const close=()=>{
    $("ar-panel").hidden=true;$("ar-open").setAttribute("aria-expanded","false");$("ar-open").focus();
  };
  $("ar-close").onclick=close;
  $("ar-panel").addEventListener("keydown",e=>{if(e.key==="Escape")close();});
  $("ar-open").onclick=async()=>{
    if(!$("ar-panel").hidden){close();return;}
    if(opening)return;
    opening=true;$("ar-panel").hidden=false;$("ar-open").setAttribute("aria-expanded","true");status("连接中…");$("ar-submit").disabled=true;
    try{display(await api("guest",{sku}));$("ar-submit").disabled=false;$("ar-question").focus();}
    catch(e){status(e.message);}
    finally{opening=false;}
  };
  $("ar-compose").onsubmit=async e=>{
    e.preventDefault();
    const input=$("ar-question"),text=input.value.trim();if(!text||sending)return;
    const pending=lastFailed?.text===text?lastFailed:{id:(crypto.randomUUID?.() ?? ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16))),text,sku};
    sending=true;$("ar-submit").disabled=true;status("发送中…");
    try{await api("message",pending);input.value="";lastFailed=null;display(await api("guest"));}
    catch(e){lastFailed=pending;status(e.message);}
    finally{sending=false;$("ar-submit").disabled=false;}
  };
  (async function poll(){
    if(!$("ar-panel").hidden && !opening && !sending&&!lastFailed){
      try{display(await api("guest"));}catch{status("连接暂不可用");}
    }
    setTimeout(poll,850);
  })();
})();
