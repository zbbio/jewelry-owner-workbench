// Host adapter for the P1 contract. k1CreateNavigation is bound privately to compiled Mika/Kotlin.
// Nothing from the identity, history or receipt is persisted in browser storage.
const el = id => document.getElementById('k1-' + id);
const panel = el('panel'), topics = el('topics'), messages = el('messages');
const root = '/api/n22/conversations', note = text => { el('note').textContent = text; };
let nav, life = 0, view = 0, fetchSeq = 0, focusSeq = 0, listSeq = 0, creating = false;
let active, topicPage, messagePage, rows, pending, drafts;
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const elem = (tag,text) => { const node=document.createElement(tag); node.textContent=text; return node; };
function clearAll(label) {
  ++life; ++view; ++fetchSeq; ++focusSeq; ++listSeq; nav=k1CreateNavigation();
  active=null; topicPage=messagePage=null; rows=[]; pending=new Map(); drafts=new Map(); creating=false;
  topics.replaceChildren(); messages.replaceChildren(); el('title').value=''; el('text').value='';
  el('active').textContent='请选择话题'; el('older').hidden=true; el('more-topics').hidden=true;
  el('create').disabled=false; controls(); note(label);
}
function controls() {
  el('send').disabled=!active || pending.has(active?.conversationId);
  el('text').disabled=!active;
  el('back-last').disabled=!active || !rows.length;
}
async function api(path, body) {
  const generation=life, init={cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error'};
  if(body!==undefined) Object.assign(init,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const res=await fetch(root+path,init);
  if(generation!==life) throw Error('STALE');
  if(res.status===401 || res.status===403) {
    clearAll('登录或话题权限已失效。请关闭面板，重新进入本店。');throw Error('STALE');
  }
  if(!res.ok)throw Error(res.status===404?'条目不可见，或当前版本尚未接入话题服务。':'话题服务未完成请求（'+res.status+'）。');
  const value=await res.json(); if(generation!==life)throw Error('STALE');return value;
}
function fail(e) { if(e.message!=='STALE')note(e instanceof TypeError?'连接中断，请重新查看历史；消息不会自动重发。':e.message); }
function assert(x){if(!x)throw Error('话题回执标识不一致，未展示。');}
function isTopic(t){return t&&uuid(t.conversationId)&&typeof t.title==='string';}
function checkRow(t,c) {
  assert(t&&t.conversationId===c&&uuid(t.messageId)&&uuid(t.runId)&&typeof t.input?.text==='string'&&Array.isArray(t.toolReceipts));
  for(const r of t.toolReceipts)assert(r.conversationId===c&&r.messageId===t.messageId&&r.runId===t.runId&&r.requestId===t.requestId);
}
const labels={completed:'已完成',running:'处理中',needs_clarification:'待澄清',failed:'未完成',unsupported:'暂未接通',partial_success:'部分完成',result_unknown:'结果待核'};
function receiptText(r){
  const v=r.result;if(r.toolName!=='catalog_read_facts'||!v)return r.toolName+' · 已留回执';
  const parts=['商品资料',v.productId,v.productVersion?'v'+v.productVersion:null].filter(Boolean);
  if(v.price)parts.push(v.price.status==='recorded'?'售价 '+v.price.amount+' '+v.price.currency:'售价待核');
  if(v.fields)for(const [k,f] of Object.entries(v.fields)){if(f && ['string','number'].includes(typeof f.value))parts.push(k+'：'+String(f.value)+(f.unit?' '+f.unit:''));}
  if(v.status!=='matched' && v.reason)parts.push(v.reason);
  return parts.join(' · ');
}
function draw() {
  messages.replaceChildren();
  for(const [index,r] of rows.entries()) {
    const art=elem('article',''); art.dataset.mid=r.messageId; art.dataset.cid=r.conversationId;
    art.dataset.rowKey='u'+index;art.dataset.run=r.runId;art.dataset.status=r.status;art.tabIndex=-1;
    art.append(elem('p',r.input.text),elem('small',labels[r.status]||'结果待核'));
    for(const t of r.toolReceipts)art.append(elem('p',receiptText(t)));
    const a=elem('button','定位这条消息');a.type='button';a.onclick=()=>jump(r.messageId);art.append(a);messages.append(art);
  }
  controls();
}
function setCurrent(){for(const b of topics.children)b.setAttribute('aria-current',String(b.dataset.cid===active?.conversationId));}
async function list(more=false) {
  const seq=++listSeq; const cursor=more?topicPage:null;
  try{const page=await api(cursor?'?before='+encodeURIComponent(cursor):'');if(seq!==listSeq)return;
    assert(Array.isArray(page.items)&&page.items.every(isTopic));assert(page.nextBefore===null||uuid(page.nextBefore));
    if(!more)topics.replaceChildren(); const seen=new Set([...topics.children].map(b=>b.dataset.cid));
    for(const t of page.items){if(seen.has(t.conversationId))continue;seen.add(t.conversationId);
      const b=elem('button',t.title);b.type='button';b.dataset.cid=t.conversationId;b.onclick=()=>select(t);topics.append(b);}
    setCurrent();topicPage=page.nextBefore;el('more-topics').hidden=!topicPage;
    if(!active&&!page.items.length)note('还没有话题。先给新话题取个名字。');
  }catch(e){if(seq===listSeq)fail(e);}
}
async function history(more=false) {
  if(!active)return;
  const c=active.conversationId, v=view,seq=++fetchSeq, cursor=more?messagePage:null;
  try{const page=await api('/'+c+'/messages'+(cursor?'?before='+encodeURIComponent(cursor):''));
    if(view!==v||seq!==fetchSeq)return;assert(page.conversation?.conversationId===c&&Array.isArray(page.items));assert(page.nextBefore===null||uuid(page.nextBefore));
    page.items.forEach(r=>checkRow(r,c));const combined=[...page.items].reverse().concat(more?rows:[]);
    assert(new Set(combined.map(r=>r.messageId)).size===combined.length);
    rows=combined;messagePage=page.nextBefore;el('older').hidden=!messagePage;draw();
    note(rows.length?'已读取本话题消息。':'这是新话题，还没有消息。');
  }catch(e){if(view===v&&seq===fetchSeq)fail(e);}
}
function select(t){
  if(active)drafts.set(active.conversationId,el('text').value);
  ++view;++focusSeq;active=t;nav.selectTopic(t.conversationId);rows=[];messagePage=null;el('older').hidden=true;
  el('active').textContent=t.title;el('text').value=drafts.get(t.conversationId)||'';setCurrent();draw();note('正在读取话题…');return history();
}
async function jump(mid) {
  if(!active || !uuid(mid))return;
  const c=active.conversationId,v=view,seq=++focusSeq;
  try{
    const r=await api('/'+c+'/messages/'+mid);
    if(view!==v||seq!==focusSeq)return;
    checkRow(r,c);const index=rows.findIndex(x=>x.messageId===mid);
    assert(r.messageId===mid&&index!==-1&&rows[index].runId===r.runId);
    const key=nav.openMessage(c,mid,rows.map(x=>x.messageId));
    assert(typeof key==='string');rows[index]=r;draw();
    const art=[...messages.children].find(row=>row.dataset.rowKey===key);assert(art&&art.dataset.mid===mid&&art.dataset.cid===c);
    art.dataset.rowKey=key;art.dataset.k1Focused='true';art.focus();art.scrollIntoView({block:'nearest'});note('已定位原消息，仅重新读取。');
  }catch(e){if(view===v&&seq===focusSeq)fail(e);}
}
el('new').onsubmit=async ev=>{
  ev.preventDefault();const title=el('title').value.trim();if(!title||creating)return;
  const g=life,v=view;creating=true;el('create').disabled=true;
  try{const t=await api('',{requestId:newRequestId(crypto),title});assert(isTopic(t));
    el('title').value='';if(v===view)await select(t);if(g===life)await list();
  }catch(e){if(g===life)fail(e);}finally{if(g===life){creating=false;el('create').disabled=false;}}
};
el('form').onsubmit=async ev=>{
  ev.preventDefault();if(!active)return;const c=active.conversationId,g=life;
  const text=el('text').value.trim();if(!text||pending.has(c))return;
  const req=newRequestId(crypto);pending.set(c,req);el('text').value='';drafts.delete(c);controls();note('正在处理本条消息…');
  try{
    const r=await api('/'+c+'/turn',{requestId:req,text});
    checkRow(r,c);assert(r.requestId===req);
    if(active?.conversationId===c)await history();
    if(g===life)await list();
  }catch(e){if(g===life && active?.conversationId===c)fail(e);}
  finally{if(g===life){pending.delete(c);controls();}}
};
el('older').onclick=()=>history(true);el('more-topics').onclick=()=>list(true);
el('back-last').onclick=()=>{if(rows.length)jump(rows[rows.length-1].messageId);};
el('launch').onclick=()=>{clearAll('正在读取本店话题…');panel.showModal();list();};
el('close').onclick=()=>panel.close();panel.addEventListener('close',()=>clearAll(''));
window.addEventListener('pagehide',()=>{if(panel.open)panel.close();clearAll('');});
clearAll('');
