/* K2. Installed INSIDE the verified K1 view closure. No exported global, credentials,
 * client authority, storage or model. Endpoints belong to their producer. */
let k2DropSensitive=()=>{}; // K1 and K2 share invalidation, never authorization.
;(()=>{
  'use strict';
  /*K2_GROUP_TASKS*/
  const ports = /*K2_BIND_READERS*/Object.freeze({});
  const box=document.getElementById('k2-panel'), by=k=>document.getElementById('k2-'+k);
  const opener=by('open'), okId=x=>typeof x==='string' && /^[\w.:-]{1,128}$/u.test(x);
  const safeText=x=>typeof x==='string' && x.trim().length>0 && x.length<=1000;
  const source=!!(ports.listPending && ports.readPending), snapshots=new WeakMap();
  let session=0, turn=0, lookup=0, cardEpoch=0, sourceEpoch=0, ticketCache=[], busy=new Set();
  const area=by('status'), names={album:'相册',catalog:'商品',sales:'销售',content:'内容'};
  const text=(node,s)=>{node.textContent=s;}; const msg=s=>text(area,s);
  const hide=()=>box.hidden;
  const deny=e=>[401,403].includes(e?.status);
  const bad=(message,status)=>Object.assign(new Error(message),{status});
  const err=e=>deny(e)?'授权已失效，请重新核实身份或预览。':
    e?.status===409?'对象或确认票已变化，请重新预览。':
    e?.status===410?'确认票已过期，请重新预览。':
    e?.status===404?'原票或消息已不可见，请重新预览。':'服务或回执尚未核实，请刷新后重试。';
  function notify(s){msg(s);if(panel.open)note(s);}
  function detach(){for(const n of messages.querySelectorAll('.k2-ticket'))n.remove();}
  function reset(){
    ++session;++turn;++lookup;++sourceEpoch;++cardEpoch;ticketCache=[];busy=new Set();detach();
    for(const id of ['pending','ready','recent'])by(id).replaceChildren();msg('');
  }
  function revoked(){
    reset();clearAll('本店授权已失效，原消息和待确认内容已清除。');
    notify('本店授权已失效，请重新核实身份或预览。');
  }
  k2DropSensitive=()=>{reset();msg('本店授权已失效；列表已清除。');};
  function ticket(t){
    if(!t || !okId(t.confirmationId)||!uuid(t.conversationId)||!uuid(t.messageId)||!uuid(t.runId)||
       !okId(t.objectId)||!Number.isSafeInteger(t.objectVersion)||t.objectVersion<=0||
       !safeText(t.summary)||typeof t.expiresAt!=='string'||!Number.isFinite(Date.parse(t.expiresAt))||
       !['pending','confirmed','cancelled','expired','revoked','superseded'].includes(t.status))throw bad('DTO',422);
    return Object.freeze({confirmationId:t.confirmationId,conversationId:t.conversationId,messageId:t.messageId,runId:t.runId,
      objectId:t.objectId,objectVersion:t.objectVersion,summary:t.summary,status:t.status,expiresAt:t.expiresAt});
  }
  const keys=['confirmationId','conversationId','messageId','runId','objectId','objectVersion','expiresAt','summary'];
  const same=(a,b)=>keys.every(k=>a[k]===b[k]);
  function validPending(t){
    if(t.status==='revoked')throw bad('revoked',403);
    if(t.status==='expired'||Date.parse(t.expiresAt)<=Date.now())throw bad('expired',410);
    if(t.status!=='pending')throw bad('closed',409);
  }
  async function current(old){
    const t=ticket(await ports.readPending(old.confirmationId));validPending(t);
    if(!same(old,t))throw bad('changed',409);return t;
  }
  function ingest(data){
    if(!Array.isArray(data))throw bad('list',422);
    const a=data.map(ticket), unique=new Set(a.map(t=>t.confirmationId));
    if(a.length!==unique.size)throw bad('duplicate',422);
    return a.filter(t=>t.status==='pending');
  }
  const topicTask=t=>({conversation:t.conversationId,task_id:t.confirmationId,status:'waiting_for_answer',ticket:t});
  const button=(s,action)=>{const b=elem('button',s);b.type='button';b.onclick=action;return b;};
  function stamp(t){return t.summary+' · '+t.objectId+' / v'+t.objectVersion;}
  function renderQueue(){
    const dest=by('pending');dest.replaceChildren();
    if(!source){text(dest,'确认票服务未接入，当前没有可操作的确认入口。');return;}
    if(!ticketCache.length){text(dest,'当前没有待确认项。');return;}
    for(const g of groupTasks(ticketCache.map(topicTask))){
      const div=elem('div','');
      for(const x of g.turns){const t=x.ticket, b=button(stamp(t)+' → 原消息',()=>openTicket(t));b.dataset.confirmationId=t.confirmationId;div.append(b);}
      dest.append(div);
    }
  }
  async function loadQueue(g){
    if(!source){renderQueue();return;}
    const q=++sourceEpoch;
    try{const a=ingest(await ports.listPending());
      if(g!==session||q!==sourceEpoch||hide())return;
      ticketCache=a;renderQueue();paintCards();
    }catch(e){if(g!==session||q!==sourceEpoch||hide())return;if(deny(e))return revoked();
      ticketCache=[];detach();text(by('pending'),'确认票列表读取失败；未开放操作。');msg(err(e));}
  }
  async function readP1(path){
    const r=await fetch(root+path,{cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error'});
    if(!r.ok)throw bad('P1',r.status);return r.json();
  }
  async function recent(g){
    const dest=by('recent');
    try{
      const page=await readP1('?limit=5');
      if(!Array.isArray(page.items)||page.items.length>5)throw bad('list',422);
      const items=await Promise.all(page.items.map(async t=>{
        if(!isTopic(t))throw bad('topic',422);if(t.lastMessageId===null)return null;
        if(!uuid(t.lastMessageId))throw bad('mid',422);
        const r=await readP1('/'+t.conversationId+'/messages/'+t.lastMessageId);checkRow(r,t.conversationId);
        if(r.messageId!==t.lastMessageId)throw bad('mid',422);
        const status=r.status==='running'?'running':r.status==='needs_clarification'?'waiting_for_answer':r.status==='failed'?'failed':'done';
        return {task_id:r.messageId,conversation:t.conversationId,status,r,title:t.title};
      }));
      if(g!==session||hide())return;
      dest.replaceChildren();for(const grp of groupTasks(items.filter(Boolean)))for(const x of grp.turns){
        const b=button(x.title+' · '+x.r.input.text+' · '+(labels[x.r.status]||'结果待核'),()=>openSource(x.r,null));
        b.dataset.messageId=x.r.messageId;dest.append(b);
      }
      if(!dest.children.length)text(dest,'还没有可恢复的近期消息。');
    }catch(e){if(g!==session||hide())return;if(deny(e))return revoked();text(dest,'近期消息尚未核实。');}
  }
  async function capabilities(){
    const r=await fetch('/api/n22/capabilities',{credentials:'same-origin',cache:'no-store',mode:'same-origin',redirect:'error'});
    if(!r.ok)throw bad('host',r.status);const data=await r.json();if(data.authenticated!==true)throw bad('owner',401);return data;
  }
  async function ready(g){
    const dest=by('ready');
    const show=(c,a)=>{
      dest.replaceChildren();
      for(const [k,title] of Object.entries(names)){
        const m=c?.[k==='catalog'?'product':k], host=m==='mounted'?'宿主已挂载':m==='not_mounted'?'宿主未挂载':'挂载未知';
        const row=a.get(k), name={ready:'当前就绪',unavailable:'当前不可用',unknown:'待核实'}[row?.state]||'待核实';
        // A negative on either side can never be raised by static registration.
        const state=m==='not_mounted'?'当前不可用':name;
        dest.append(elem('li',title+'：'+host+'；'+state+(row?.detail?' · '+row.detail:'')));
      }
    };
    try{
      const c=await capabilities();if(g!==session||hide())return;show(c,new Map());
      if(!ports.readiness)return;
      try{
        const rows=await ports.readiness();if(!Array.isArray(rows))throw bad('ready',422);
        const a=new Map();for(const r of rows){
          if(!Object.hasOwn(names,r.warehouse)||a.has(r.warehouse)||!['ready','unavailable','unknown'].includes(r.state)||
             typeof r.detail!=='string'||r.detail.length>500)throw bad('row',422);a.set(r.warehouse,r);
        }
        if(g===session&&!hide())show(c,a);
      }catch(e){if(g===session&&!hide()){if(deny(e))return revoked();show(c,new Map());}}
    }catch(e){if(g!==session||hide())return;if(deny(e))return revoked();show(null,new Map());}
  }
  function refresh(){reset();const g=session;msg('列表仅供查看。发送普通指令不需要选择仓或点确认。');
    for(const id of ['pending','ready','recent'])text(by(id),'读取中…');
    void loadQueue(g);void recent(g);void ready(g);
  }
  function closeBox(){box.hidden=true;opener.setAttribute('aria-expanded','false');reset();}
  const thread=document.getElementById('thread');if(thread)thread.before(box);
  opener.setAttribute('aria-controls','k2-panel');opener.setAttribute('aria-expanded','false');
  opener.onclick=()=>{if(!hide()){closeBox();return;}box.hidden=false;opener.setAttribute('aria-expanded','true');refresh();};
  by('close').onclick=()=>{closeBox();opener.focus();};by('refresh').onclick=refresh;
  // Read exact P1 data and a fresh ticket BEFORE opening a message. A sidebar click never dispatches a turn.
  async function openSource(bind,confirmation){
    const id=++lookup,g=session,kLife=life,kView=view;let expectedView=kView;const c=bind.conversationId,m=bind.messageId;
    const wanted=()=>id===lookup&&g===session&&life===kLife&&view===kView&&!hide();
    try{
      const [dto,h]=await Promise.all([readP1('/'+c+'/messages/'+m),readP1('/'+c+'/messages?limit=1')]);
      if(!wanted())return;checkRow(dto,c);
      if(dto.messageId!==m||dto.runId!==bind.runId||!isTopic(h.conversation)||h.conversation.conversationId!==c)throw bad('origin',409);
      let t=null;if(confirmation){t=await current(confirmation);if(!wanted())return;}
      // Keep the verified K1 view/selection owner. For an old, off-page original open a one-row
      // exact history window; the existing earlier button uses the P1 opaque message cursor.
      if(!panel.open){panel.showModal();void list();}
      const targetView=view+1;expectedView=targetView;await select(h.conversation);
      if(id!==lookup||g!==session||life!==kLife||view!==targetView||active?.conversationId!==c||!panel.open)return;
      if(!rows.some(r=>r.messageId===m)){rows=[dto];messagePage=m;el('older').hidden=false;draw();}
      await jump(m);
      if(id!==lookup||g!==session||view!==targetView||life!==kLife||!panel.open)return;
      const node=[...messages.children].find(a=>a.dataset.mid===m&&a.dataset.cid===c&&a.dataset.run===dto.runId);
      if(!node||node.dataset.k1Focused!=='true')throw bad('unfocused',409);
      if(t){const latest=await current(t);
        if(id!==lookup||g!==session||view!==targetView||life!==kLife||!panel.open||!node.isConnected)return;
        appendCard(node,latest);note('已回到这张票的原消息；尚未执行。');}
    }catch(e){if(id!==lookup||g!==session||life!==kLife||view!==expectedView)return;if(deny(e))return revoked();notify(err(e));}
  }
  function openTicket(t){return openSource(t,t);}
  function appendCard(article,t){
    if(!panel.open||!article.isConnected||article.dataset.cid!==t.conversationId||
       article.dataset.mid!==t.messageId||article.dataset.run!==t.runId)return;
    const prior=[...article.querySelectorAll('.k2-ticket')].find(n=>n.dataset.confirmationId===t.confirmationId);
    if(prior){
      if(!same(snapshots.get(prior),t)||Date.parse(t.expiresAt)<=Date.now())
        prior.replaceChildren(elem('p','确认票已变化或过期。请刷新待确认列表，重新查看后果。'));
      return;
    }
    const card=elem('section','');card.className='k2-ticket';card.dataset.confirmationId=t.confirmationId;
    const info=elem('small','有效期至 '+new Date(t.expiresAt).toLocaleString());
    card.append(elem('strong',stamp(t)),elem('p','确认票 '+t.confirmationId),info);
    for(const [choice,label] of [['confirm','明确同意并执行'],['cancel','取消此项']]){
      const b=button(label,()=>decide(t,choice,card));b.dataset.k2Choice=choice;
      b.disabled=!ports.decide||busy.has(t.confirmationId)||Date.parse(t.expiresAt)<=Date.now();card.append(b);
    }
    snapshots.set(card,t);article.append(card);
  }
  function paintCards(){
    if(!panel.open)return;
    for(const art of messages.children)for(const t of ticketCache)appendCard(art,t);
  }
  // Also show the same server tickets when arriving through K1 without opening the sidebar.
  function scanSource(){
    if(!source||!panel.open||!messages.children.length)return;
    const q=++cardEpoch,v=view,l=life,g=session;
    const still=()=>q===cardEpoch&&v===view&&life===l&&g===session&&panel.open;
    void Promise.resolve().then(()=>ports.listPending()).then(a=>{
      if(!still())return;const live=ingest(a);
      for(const card of messages.querySelectorAll('.k2-ticket')){
        if(!live.some(x=>x.confirmationId===card.dataset.confirmationId))card.remove();
      }
      for(const art of messages.children)for(const t of live)appendCard(art,t);
    }).catch(e=>{if(!still())return;if(deny(e))return revoked();detach();});
  }
  new MutationObserver(scanSource).observe(messages,{childList:true});
  async function decide(old,choice,card){
    const id=old.confirmationId;if(!ports.decide||busy.has(id)||!card.isConnected||!panel.open)return;
    const g=session,v=view,l=life;
    const still=()=>session===g&&view===v&&life===l&&panel.open&&active?.conversationId===old.conversationId&&card.isConnected;
    busy.add(id);const buttons=[...card.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try{
      const live=await current(old);if(!still())return;
      const r=await readP1('/'+live.conversationId+'/messages/'+live.messageId);if(!still())return;
      checkRow(r,live.conversationId);if(r.messageId!==live.messageId||r.runId!==live.runId)throw bad('origin',409);
      validPending(live);
      // Producer must atomically compare original message, ACL, version, expiry & idempotency.
      // No production write port is shipped before a verified P2 contract is available.
      const after=ticket(await ports.decide(live,choice));if(!still())return;
      if(!same(live,after)||after.status!==(choice==='cancel'?'cancelled':'confirmed'))throw bad('receipt',409);
      ticketCache=ticketCache.filter(x=>x.confirmationId!==id);if(!hide())renderQueue();
      card.replaceChildren(elem('p',choice==='cancel'?'原票已取消。':'原票已确认。'));note('已收到该确认票的处理回执。');
    }catch(e){if(!still())return;if(deny(e))return revoked();
      card.replaceChildren(elem('p',err(e)));note(err(e));ticketCache=ticketCache.filter(x=>x.confirmationId!==id);if(!hide())renderQueue();
    }finally{if(g===session)busy.delete(id);}
  }
  panel.addEventListener('close',()=>{++lookup;++cardEpoch;detach();});
  window.addEventListener('pagehide',closeBox);
})();
