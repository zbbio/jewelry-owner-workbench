(() => {
 const $=id=>document.getElementById(id);
 const dialog=$('anran-sales-dialog'),title=$('anran-sales-title'),owner=$('anran-owner-frame'),guest=$('anran-shop-frame');
 const status=$('anran-watch-state'),shopLink=$('anran-shop-link'),ownerLink=$('anran-owner-link');
 let seen=null, launched=false, launching=false, activeCheck=null;
 document.querySelectorAll('[data-preset="sales"]').forEach(button=>button.onclick=async()=>{
   if(!dialog.open)dialog.showModal();
   if(launched||launching)return;
   launching=true;
   status.textContent="正在检查已有销售接待…";
   try{
    if(await probeActive()||!dialog.open)return;
    const r=await fetch('/demo/api/start',{method:'POST'});
    if(!r.ok)throw Error('start failed');
    const {shop,owner:ownerPage}=await r.json();
    if(typeof shop!=='string'||!shop.startsWith('/demo/shop?')||ownerPage!=='/demo/owner')throw Error('invalid routes');
    shopLink.href=shop;shopLink.hidden=false;ownerLink.href=ownerPage;
    seen=null;guest.hidden=true;delete guest.dataset.store;owner.src=ownerPage;
    $('anran-links').hidden=false;status.textContent='在示例店铺点「客服」发问；店主端自动同步。请使用测试问题。';
    launched=true;
   }catch{status.textContent='销售接待暂未连上；请关闭后重试。';}
   finally{launching=false;}
 });
 shopLink.onclick=e=>{
   // Android's shell has no multi-window; keep a usable same-origin view.
   if(e.ctrlKey||e.metaKey||e.shiftKey)return;
   e.preventDefault();
   if(!guest.dataset.store){guest.src=shopLink.href;guest.dataset.store='1';}
   guest.hidden=false;
 };
 ownerLink.onclick=e=>{
   if(e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
   e.preventDefault();
   owner.scrollIntoView({block:'start',inline:'nearest'});
   owner.focus({preventScroll:true});
 };
 window.addEventListener('message',({origin,source,data})=>{
  if(origin!==location.origin||source!==owner.contentWindow||data?.type!=='anran-sales-feed')return;
  const r=data.reply,seq=r?.seq||0;
  if(seen===null){seen=seq;return;}
  if(!r||!Number.isSafeInteger(seq)||seq<=seen||typeof r.threadId!=='string'||typeof r.messageId!=='string')return;
  seen=seq;
  title.textContent='示例店铺 · 自动回复已送达';
  dialog.dataset.threadId=r.threadId;
  dialog.dataset.messageId=r.messageId;
  if(!guest.dataset.store){
    const query=new URLSearchParams({thread:r.threadId,message:r.messageId});
    guest.src='/demo/owner-shop?'+query;guest.hidden=false;
  }
  owner.contentWindow.postMessage({type:'anran-sales-focus',threadId:r.threadId,messageId:r.messageId},location.origin);
  if(!dialog.open)dialog.showModal();
 });
 // Share the initial check with the button; only an explicit no-pair response may start a new one.
 function probeActive(){
  if(activeCheck)return activeCheck;
  activeCheck=fetch('/demo/api/active',{cache:'no-store',redirect:'error'}).then(async r=>{
   if(r.status===403)return false;
   if(!r.ok||(await r.json())?.active!==true)throw Error('active check failed');
   owner.src='/demo/owner';
   $('anran-links').hidden=false;shopLink.hidden=true;
   status.textContent='店主同步已恢复。请使用已打开的顾客店铺。';
   launched=true;
   return true;
  }).finally(()=>{activeCheck=null;});
  return activeCheck;
 }
 probeActive().catch(()=>{});
})();
