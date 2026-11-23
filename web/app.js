const $ = (id) => document.getElementById(id);
const make = (tag, text, className) => {
  const el=document.createElement(tag); if(text!=null) el.textContent=String(text); if(className) el.className=className; return el;
};
const join = (host,...children) => host.append(...children.filter(Boolean));
const uri = (id) => encodeURIComponent(String(id));
const asArray = (value) => Array.isArray(value) ? value : [];
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
const stableReadKey='owner-ticket01.lastTask';
function storedTask(){try{return localStorage.getItem(stableReadKey)}catch{return null}}
function storeTask(t){try{localStorage.setItem(stableReadKey,t)}catch{/* browsing without storage still works */}}
const limits={count:12,each:8*1024*1024,total:36*1024*1024};
const types=['image/jpeg','image/png','image/webp'];
let cards=[], active=null, mode=null, staged=[], lock=false, attempt=null, reviewAttempt=null, retryAttempt=null, openCardId=null;
function option(value,text){const el=make('option',text);el.value=value;return el}
function thumb(assetId,description){if(!assetId)return null;const img=make('img',null,'thumb');img.loading='lazy';img.alt=description||'本件原图';img.src='/api/assets/'+uri(assetId);return img}
function button(text,click,klass){const b=make('button',text,klass);b.type='button';b.addEventListener('click',click);return b}
function tell(msg,error=false){$('notice').hidden=!msg;$('notice').className=error?'error':'';$('notice').textContent=msg}
function errorMsg(e){return e?.message||'暂时读取失败，请重试。'}
async function api(path,body,method='POST'){
 const opts={credentials:'same-origin',cache:'no-store'};
 if(body!==undefined){opts.method=method;opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(body)}
 let res;try{res=await fetch(path,opts)}catch{throw new Error('连接中断。如果刚刚已提交，先查看任务；重试原操作会沿用原请求号。')}
 let data;try{data=await res.json()}catch{throw new Error('服务没有返回可读的回执，请刷新数据核对。')}
 if(!res.ok){const err=data?.error??data;throw Object.assign(new Error([err?.message||'操作失败',err?.code||('HTTP '+res.status)].join(' · ')),{status:res.status,code:err?.code,taskId:typeof err?.taskId==='string'?err.taskId:null})}
 return data;
}
function useLock(val){
 lock=val;
 for(const e of document.querySelectorAll('main section')) e.inert=val;
 $('submit-import').disabled=val;
 document.querySelector('main').setAttribute('aria-busy',String(val));
 if(!val){$('open-task').disabled=!$('history').value;$('submit-review').disabled=staged.length===0;$('stage-group').disabled=!document.querySelector('#pending input[type=checkbox]');}
}
async function guarded(fn){if(lock)return;useLock(true);try{await fn()}catch(e){
 if(e.taskId){storeTask(e.taskId);try{await refresh(e.taskId)}catch{/* taskId remains available after reconnect */}}
 tell(errorMsg(e)+(e.taskId?' · 原任务 '+e.taskId:''),true);
}finally{useLock(false)}}
function wire(id,fn){$(id).addEventListener('click',()=>guarded(fn))}
function fileHelp(){return 'JPEG、PNG 或 WebP；每张不超过 8 MiB，每批最多 12 张、总计不超过 36 MiB。'}
$('file-limits').textContent=fileHelp();
function validFiles(files){
 if(!files.length)throw new Error('请先选择原照片。');
 if(files.length>limits.count)throw new Error('本批照片超过 12 张，请分两次整理。');
 if(files.some(f=>f.size<=0||f.size>limits.each))throw new Error('有空文件或单张原图超过 8 MiB；请选择符合上限的原照片。');
 if(files.reduce((a,f)=>a+f.size,0)>limits.total)throw new Error('原图总计超过 36 MiB，请分批选择。');
 if(files.some(f=>f.type && !types.includes(f.type.toLowerCase())))throw new Error('照片格式不支持。'+fileHelp());
}
async function base64(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('读取选中照片失败，请重新选择。'));r.onload=()=>{const s=String(r.result),comma=s.indexOf(',');if(comma<0)return reject(new Error('读取照片失败。'));resolve(s.slice(comma+1))};r.readAsDataURL(file)})}
$('photos').addEventListener('change',()=>{attempt=null;const fs=Array.from($('photos').files);$('selected').textContent=fs.length?'已选 '+fs.length+' 张原照片 · '+(fs.reduce((s,f)=>s+f.size,0)/1048576).toFixed(1)+' MiB':'尚未选择照片';try{if(fs.length)validFiles(fs);tell('')}catch(e){tell(errorMsg(e),true)}});
function setMode(card){
 mode=card?{productId:card.productId,expectedVersion:card.productVersion}:null;attempt=null;$('photos').value='';$('selected').textContent='尚未选择照片';
 $('import-title').textContent=card?'从这张商品卡补图':'从相册混选';
 $('mode-hint').textContent=card?'原卡：'+card.productId+'（版本 '+card.productVersion+'）。只选择这件实物的新角度。':'可同时选择不同实物的照片，无需先分组。手机原相册不会被更改。';
 $('album-mode').hidden=!card;$('submit-import').textContent=card?'提交到原商品卡':'开始整理';$('import-panel').scrollIntoView({block:'start'});
}
$('album-mode').addEventListener('click',()=>{if(!lock){setMode(null);tell('已回到相册混选入口。')}});
$('import-form').addEventListener('submit',ev=>{ev.preventDefault();guarded(async()=>{
 const fs=Array.from($('photos').files);validFiles(fs);
 if(!attempt){const files=[];for(const f of fs)files.push(await base64(f));attempt={requestId:newId(),files,...(mode?{targetProductId:mode.productId,expectedVersion:mode.expectedVersion}:{})}}
 tell('正在上传原图并核对归属，请稍候…');
 const task=await api('/api/import',attempt);if(!task?.taskId)throw new Error('未取得任务号，请刷新任务列表核对。');
 attempt=null;setMode(null);showTask(task);await refresh(task.taskId);tell('已收到整理回执，可查看逐图结果和商品卡。');$('task-detail').scrollIntoView({block:'start'});
})});
const codes={kept:'已保留',retained:'已保留',duplicate:'重复（不另存）',failed:'失败',pending:'待判断',pending_confirmation:'待确认归组',created:'已建卡',images_added:'已补入原卡',unchanged:'原卡未变',system_checked:'系统自检',owner_confirmed:'店主确认'};
function showTask(task){
 if(!task||!task.taskId)throw new Error('任务缺少任务号。');
 if(active?.taskId!==task.taskId){staged=[];reviewAttempt=null;retryAttempt=null}
 active=task;storeTask(task.taskId);
 const pend=new Set(asArray(task.pendingAssetIds));staged=staged.filter(g=>g.assetIds.every(id=>pend.has(id)));
 const host=$('task-detail');host.replaceChildren();join(host,make('h3','任务详情'),make('p',task.taskId,'technical'));
 for(const [i,it] of asArray(task.items).entries()){
  const row=make('div',null,'item');row.dataset.itemId=it.itemId||'';row.dataset.status=it.status||'';const info=make('div');
  join(info,make('span','第 '+(i+1)+' 张 · '+(codes[it.status]||it.status||'待查询'),'tag'),make('small','导入项：'+(it.itemId||'—')));
  if(it.assetId)join(info,make('small','素材：'+it.assetId));if(it.duplicateOf)join(info,make('small','重复指向：'+it.duplicateOf));if(it.reason)join(info,make('small','说明：'+it.reason));join(row,thumb(it.assetId||it.duplicateOf),info);host.append(row);
 }
 const rec=asArray(task.receipts);
 host.append(make('h3','商品仓回执'));
 const waiting=task.status==='awaiting_receipt'||asArray(task.handoffs).some(h=>h.status==='awaiting_receipt');
 if(waiting){
  host.append(make('p','商品仓回执尚未取回。请按原任务恢复，不必重新选图或再建卡。','muted'));
  const b=button('按原任务恢复回执',()=>guarded(async()=>{
   if(retryAttempt?.taskId!==task.taskId)retryAttempt={requestId:newId(),taskId:task.taskId};
   const recovered=await api('/api/retry',retryAttempt);retryAttempt=null;showTask(recovered);await refresh(recovered.taskId);
   tell('已重新读取原任务。请查看实际回执与待处理项。');
  }),'primary');b.id='retry-task';host.append(b);
 }else if(!rec.length)host.append(make('p','当前无商品仓回执。若有待确认照片，请在下方确认。','muted'));
 for(const r of rec){const row=make('div',null,'group');row.dataset.productId=r.productId||'';join(row,make('strong',codes[r.outcome]||r.outcome||'查看回执'),make('small','商品号：'+(r.productId||'—')+' · 版本 '+(r.productVersion??'—')),make('small','组号：'+(r.groupId||'—')+' · 新增关联 '+asArray(r.addedAssetIds).length+' 张'));host.append(row)}
 drawReview();
}
function drawTarget(){
 const out=$('target-preview');out.replaceChildren();const c=cards.find(c=>c.productId===$('target-card').value);
 if(!c)return;const box=make('div',null,'target');join(box,make('strong','当前选中的原卡：'+c.productId),make('small','版本 '+c.productVersion+' · 请比对实物特征'));const gallery=make('div',null,'gallery');
 asArray(c.assetIds).forEach(id=>join(gallery,thumb(id)));join(box,gallery);out.append(box);
}
$('target-card').addEventListener('change',drawTarget);
function drawReview(){
 const hint=active?.analysis?.reviewHint?.message, note=$('review-hint');note.textContent=typeof hint==='string'?hint:'';note.hidden=!note.textContent;
 const ids=asArray(active?.pendingAssetIds);$('review-panel').hidden=!ids.length;const total=new Set(staged.flatMap(g=>g.assetIds));
 const h=$('pending');h.replaceChildren();const oldTarget=$('target-card').value;$('target-card').replaceChildren(option('','为这一件建新卡'));
 for(const c of cards)$('target-card').append(option(c.productId,'补到 '+c.productId+' · '+c.assetIds.length+' 张 · v'+c.productVersion));
 if(cards.some(c=>c.productId===oldTarget))$('target-card').value=oldTarget;drawTarget();
 const photo=(id)=>{const idx=asArray(active?.items).findIndex(it=>it.assetId===id);return idx<0?'待确认照片':'本批第 '+(idx+1)+' 张'};
 for(const id of ids.filter(id=>!total.has(id))){const label=make('label',null,'choice');const input=make('input');input.type='checkbox';input.value=id;input.name='pendingAsset';const info=make('span');join(info,make('b',photo(id)),make('small',id));join(label,input,thumb(id),info);h.append(label)}
 if(ids.length&&!h.children.length)h.append(make('p','所有待确认照片均已加入下面的组。','muted'));
 $('group-list').replaceChildren();staged.forEach((g,i)=>{const row=make('div',null,'group');join(row,make('strong','第 '+(i+1)+' 组 · '+(g.targetProductId?'补原卡 '+g.targetProductId:'新实物')),make('p',g.assetIds.map(photo).join('、')),button('撤回本组',()=>{if(!lock){staged.splice(i,1);reviewAttempt=null;drawReview()}},'quiet'));$('group-list').append(row)});
 $('stage-group').disabled=!ids.some(id=>!total.has(id));$('submit-review').disabled=!staged.length;
}
$('stage-group').addEventListener('click',()=>{if(lock)return;const chosen=[...document.querySelectorAll('#pending input:checked')].map(el=>el.value);if(!chosen.length){tell('请先选出属于同一件实物的照片。',true);return}
 const c=cards.find(c=>c.productId===$('target-card').value);
 if(c&&staged.some(g=>g.targetProductId===c.productId)){tell('同一张原卡请放在同一组。可先撤回已有组，再一次选齐。',true);return}
 staged.push({assetIds:chosen,...(c?{targetProductId:c.productId,expectedVersion:c.productVersion}:{})});reviewAttempt=null;drawReview();tell('已加入本次确认，尚未提交。');
});
wire('submit-review',async()=>{if(!active||!staged.length)return;reviewAttempt??={requestId:newId(),taskId:active.taskId,groups:staged};tell('正在提交归属确认…');const res=await api('/api/resolve',reviewAttempt);if(!res?.taskId)throw new Error('未取得确认回执，请打开原任务核对。');staged=[];reviewAttempt=null;showTask(res);await refresh(res.taskId);tell('确认回执已返回，商品号和图片以实际回执为准。')});
async function openCard(pid,scroll=true){
 const c=await api('/api/cards/'+uri(pid));if(!c?.productId)throw new Error('商品卡不存在或已不可见。');openCardId=c.productId; saveTab('last-card',openCardId);
 const h=$('card-detail');h.replaceChildren();const box=make('article',null,'target');box.dataset.detailProductId=c.productId;join(box,make('h3','商品详情'),make('strong',c.productId),make('small','版本 '+c.productVersion+' · 已关联 '+asArray(c.assetIds).length+' 张原图'));
 const g=make('div',null,'gallery');asArray(c.assetIds).forEach(id=>join(g,thumb(id,'商品原图 '+id)));join(box,g,button('从这张原卡补图',()=>{if(!lock)setMode(c)},'primary'));box.querySelector('button').id='supplement-card';h.append(box);await drawWorkbench(box,c);if(scroll)box.scrollIntoView({block:'start'})
}
function showCards(){const h=$('cards');h.replaceChildren();$('card-count').textContent=cards.length?'当前本店共有 '+cards.length+' 张商品卡。':'当前还没有商品卡。';for(const c of cards){const row=make('div',null,'card');row.dataset.productId=c.productId;row.dataset.count=asArray(c.assetIds).length;
 const info=make('div');join(info,make('strong',c.productId,'technical'),make('small','版本 '+c.productVersion+' · '+asArray(c.assetIds).length+' 张原图'));const b=button('查看卡片',()=>guarded(()=>openCard(c.productId)));b.classList.add('open-card');join(row,thumb(asArray(c.assetIds)[0]),info,b);h.append(row)}}
async function refresh(preferred){
 const [cs,ts]=await Promise.all([api('/api/cards'),api('/api/tasks')]);if(!Array.isArray(cs)||!Array.isArray(ts))throw new Error('服务返回的卡片或任务列表格式不匹配。');
 cards=cs;showCards();const sel=$('history');sel.replaceChildren();for(const record of ts){const id=typeof record==='string'?record:record?.taskId;if(id)sel.append(option(id,id))}
 if(!sel.options.length){sel.append(option('','暂无任务'));active=null;staged=[];reviewAttempt=null;$('review-panel').hidden=true;$('task-detail').textContent='尚无整理任务。'}
 const wanted=preferred||active?.taskId||storedTask();if(wanted&&[...sel.options].some(o=>o.value===wanted))sel.value=wanted;
 $('open-task').disabled=!sel.value;if(sel.value)showTask(await api('/api/tasks/'+uri(sel.value)));openCardId??=readTab('last-card');if(openCardId&&cards.some(c=>c.productId===openCardId))await openCard(openCardId,false);else {openCardId=null;$('card-detail').replaceChildren()} await drawDesk();
}
wire('open-task',async()=>{const id=$('history').value;if(id)showTask(await api('/api/tasks/'+uri(id)));tell('已读取保存的任务。')});
wire('refresh',async()=>{await refresh();tell('已重新读取本店任务和商品卡。')});
// Initial refresh runs after the card workspace helpers are defined.
// Session storage holds only the last selected card and this tab's unacknowledged write.
// No request is automatically replayed; always re-read the visible card from the server.
const tabFallback=new Map();
function readTab(k){try{return sessionStorage.getItem('n3.owner.'+k)}catch{return tabFallback.get(k)||null}}
function saveTab(k,v){if(v==null)tabFallback.delete(k);else tabFallback.set(k,v);try{if(v==null)sessionStorage.removeItem('n3.owner.'+k);else sessionStorage.setItem('n3.owner.'+k,v)}catch{/* this tab still works */}}
const pendingKey=pid=>'pending.'+pid;
function pendingOp(pid){try{const op=JSON.parse(readTab(pendingKey(pid)));return op?.pid===pid?op:null}catch{return null}}
function field(host,id,title,type,value=''){
 const label=make('label',title);label.htmlFor=id;const e=make(type==='textarea'?'textarea':type==='select'?'select':'input');e.id=id;if(e.tagName==='INPUT')e.type=type;e.value=value??'';join(host,label,e);return e;
}
const cardPath=(c,end='')=>'/api/cards/'+uri(c.productId)+end;
const workLabels={awaiting_approval:'等待店主确认',queued:'已排队',rendering:'正在制作',awaiting_confirmation:'等待店主确认',pending_confirmation:'等待店主确认',pending_review:'等待店主确认',draft:'等待店主确认',approved:'已确认',confirmed:'已确认',needs_review:'需要复核',failed:'制作未完成'};
const sourceLabel=f=>({manual:'店主手填',imported:'导入资料',ai_suggestion:'待核建议'}[f?.source]||'来源未记录');
function part(host,id,title,summary){
 const p=make('div',null,'desk-part');p.id=id;join(p,make('h3',title),summary&&make('p',summary,'fine'));host.append(p);return p;
}
function control(host,id,label,action,klass=''){
 const b=button(label,()=>guarded(action),klass);b.id=id;host.append(b);return b;
}
function sourceUrl(value){
 if(typeof value!=='string'||!value.startsWith('/api/')||value.includes('\\'))return null;
 try{const u=new URL(value,location.href);return u.origin===location.origin?u.href:null}catch{return null}
}
let asks=new Map(), notices=new Map();
function localStatus(pid,text){notices.set(pid,text)}
function recordWrite(op,out){
 if(op.kind==='ask'){asks.set(op.pid,{question:op.body.question,result:out});localStatus(op.pid,'问答已返回，尚未发送到外店。')}
 if(op.kind==='facts')localStatus(op.pid,'已保存本件资料 · 商品版本 '+out.productVersion);
 if(op.kind==='copy')localStatus(op.pid,'本件介绍已保存 · 文案版本 '+out.copyVersion);
 if(op.kind==='setup')localStatus(op.pid,'已登记本次选择；仅用于本件这次制作。');
 if(op.kind==='request'){
  const state={needs_source:'没有可用的本件实拍',needs_review:'需要复核本件权属、文案或选择',existing_available:'已找到本件可播作品',queued:'已排队，尚未出片'};
  localStatus(op.pid,(state[out.outcome]||'已取回视频回执')+(out.nextAction?' · '+out.nextAction:''));
 }
 if(op.kind==='render')localStatus(op.pid,'已收到制作回执；请预览并核对要确认的作品版本。');
 if(op.kind==='confirm')localStatus(op.pid,'已确认所选版本，未提交外店。');
}
async function sendOp(op){
 const p='/api/cards/'+uri(op.pid), rule={facts:['PATCH',p],copy:['POST',p+'/copy'],ask:['POST','/api/sales/ask'],setup:['POST',p+'/video/setup'],request:['POST',p+'/video']};
 if(['render','confirm'].includes(op.kind)&&typeof op.taskId==='string')rule[op.kind]=['POST','/api/video/tasks/'+uri(op.taskId)+'/'+op.kind];
 const dest=rule[op.kind];if(!dest||op.pid!==openCardId||(!cards.some(c=>c.productId===op.pid))||(op.kind==='ask'&&op.body?.productId!==op.pid))throw new Error('请从当前商品卡核对这次操作。');
 let out;
 try{out=await api(dest[1],op.body,dest[0])}catch(e){
  if(e.status>=400&&e.status<500&&![408,425,429].includes(e.status)){
   saveTab(pendingKey(op.pid),null);$('pending-action')?.replaceChildren();
   if(e.status===409)throw new Error('商品、作品或请求版本已变化，原输入未覆盖现有记录。请先刷新原卡，核对以后再提交。 · '+(e.code||409));
  }else drawRetry(op.pid);
  throw e;
 }
 saveTab(pendingKey(op.pid),null);recordWrite(op,out);
 await refresh();tell(notices.get(op.pid)||'已收到服务回执。');
 const next={facts:'edit-facts',copy:'edit-copy',ask:'ask-section',setup:'video-section',request:'video-section',render:'video-section',confirm:'video-section'}[op.kind];
 $(next)?.scrollIntoView({block:'start'});return out;
}
async function mutate(c,kind,body,taskId){
 if(pendingOp(c.productId)){drawRetry(c.productId);throw new Error('上次操作尚无回执，请先按原请求重试。')}
 const op={pid:c.productId,kind,body:{requestId:newId(),...body},taskId};saveTab(pendingKey(c.productId),JSON.stringify(op));return sendOp(op);
}
function drawRetry(pid){
 const h=$('pending-action');if(!h)return;h.replaceChildren();const op=pendingOp(pid);if(!op)return;
 const labels={facts:'保存本件资料',copy:'保存本件介绍',ask:'问本件',setup:'确认本次素材许可',request:'查看或申请本件视频',render:'制作样片',confirm:'确认指定版'};
 join(h,make('strong','有一项操作尚未收到回执'),make('p',(labels[op.kind]||'原操作')+' · 请求号 '+op.body.requestId,'technical'));
 control(h,'retry-write','按原请求重试',()=>sendOp(op),'primary');
}
function showAsk(h,c){
 const item=asks.get(c.productId);if(!item)return;
 const {question,result}=item;
 if(result.productRef&&result.productRef.productId!==c.productId)return;
 const out=make('div',null,'answer');out.id='sales-result';join(out,make('small','上次问题：'+question),make('strong',result.answer));
 if(result.productRef)out.append(make('small','引用本件：'+result.productRef.productId+' · v'+result.productRef.productVersion));
 if(result.productRef&&result.productRef.productVersion!==c.productVersion)out.append(make('p','此为旧版本答复。原卡已更新，请重新提问后再引用。'));
 if(result.status==='clarification_required')out.append(make('p','请先在商品卡列表打开你要问的另一件，再重新提问。'));
 if(result.video)out.append(make('small','本件视频：'+({queued:'已排队，尚未成片',existing_available:'已有可播版',needs_source:'请补本件素材',needs_review:'需复核许可或文案'}[result.video.outcome]||'见本件视频回执')));
 out.append(make('small','内部问答 · 外店未提交'));h.append(out);
}
async function drawWorkbench(box,c){
 const pid=c.productId;
 const pending=make('div');pending.id='pending-action';box.append(pending);drawRetry(pid);
 const nav=make('nav',null,'chapter-nav');nav.setAttribute('aria-label','本件操作');
 [['资料','edit-facts'],['介绍','edit-copy'],['问本件','ask-section'],['视频','video-section']].forEach(([title,id])=>join(nav,button(title,()=>$(id)?.scrollIntoView({block:'start'}),'quiet')));box.append(nav);
 const facts=part(box,'edit-facts','修改本件资料','只保存实际填写的字段，空白不清除已存资料。');const size=c.fields?.size,price=c.fields?.price;
 const s=field(facts,'card-size','尺寸','text',size?.value);s.maxLength=48;s.placeholder='如 16.5';const u=field(facts,'size-unit','尺寸单位','select');['mm','cm','m',...(size?.unit&&!['mm','cm','m'].includes(size.unit)?[size.unit]:[])].forEach(x=>u.append(option(x,({mm:'毫米（mm）',cm:'厘米（cm）',m:'米（m）'})[x]||x)));u.value=size?.unit||'mm';
 const a=field(facts,'card-price','店主记录的售价（人民币元）','text',price?.value);a.inputMode='decimal';a.maxLength=16;a.placeholder='无记录请留空';
 facts.append(make('p','尺寸：'+(size?size.value+' '+size.unit+' · '+sourceLabel(size):'未填写')+'；售价：'+(price?price.value+' '+(price.unit||'')+' · '+sourceLabel(price):'未填写')+'。这次填写来源：店主手填。','fine'));
 control(facts,'save-facts','保存本件资料',async()=>{
  const changes=[];
  if(s.value.trim()&&(s.value.trim()!==String(size?.value??'')||u.value!==size?.unit))changes.push({field:'size',value:s.value.trim(),unit:u.value,source:'manual'});
  if(a.value.trim()&&a.value.trim()!==String(price?.value??'')){
   if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(a.value.trim())||Number(a.value)<=0||!Number.isSafeInteger(Math.round(Number(a.value)*100)))throw new Error('请输入大于零的人民币售价，最多两位小数。');
   changes.push({field:'price',value:Number(a.value.trim()),unit:'元',source:'manual'});
  }
  if(!changes.length)throw new Error('请先修改一项本件资料。');await mutate(c,'facts',{expectedVersion:c.productVersion,changes});
 });
 const copy=part(box,'edit-copy','本件商品介绍',c.copyVersion?'当前已保存文案 v'+c.copyVersion:'尚无已确认介绍；请按本件实际资料填写。');
 const cp=field(copy,'card-copy','店主确认的介绍','textarea',c.copyText||'');cp.maxLength=1500;cp.rows=3;
 control(copy,'save-copy','保存并确认本件介绍',async()=>{if(!cp.value.trim())throw new Error('请先填写本件介绍。');await mutate(c,'copy',{expectedVersion:c.productVersion,text:cp.value.trim()})});
 const ask=part(box,'ask-section','问本件','这里是店主内部问答。库存没有核实，不会作为现货承诺。');
 const q=field(ask,'ask-input','想问这件什么？','text');q.placeholder='这条多少钱、有货吗？';q.maxLength=500;
 control(ask,'ask-submit','问这件',async()=>{if(!q.value.trim())throw new Error('请先写下想问本件的问题。');let sessionId=readTab('session.'+pid);if(!sessionId){sessionId=newId();saveTab('session.'+pid,sessionId)}await mutate(c,'ask',{sessionId,productId:pid,question:q.value.trim()})},'primary');showAsk(ask,c);
 const vh=part(box,'video-section','看本件视频','这里只用本件已确认素材和介绍。生成样片、确认作品与对外发布是三件事。');
 try{const data=await api(cardPath(c,'/video'));if(data.productId!==pid)throw new Error('返回的视频不属于当前原卡。');drawVideo(vh,c,data)}catch(e){vh.append(make('p','视频状态暂未读到：'+errorMsg(e),'fine'));control(vh,'retry-video-read','刷新本件视频',()=>openCard(pid,false))}
 if(notices.has(pid))box.append(make('small',notices.get(pid),'local-notice'));
}
function drawVideo(h,c,data){
 const assets=asArray(c.assetIds), works=asArray(data.works).filter(w=>!w.productId||w.productId===c.productId),tasks=asArray(data.tasks).filter(t=>!t.productId||t.productId===c.productId);
 const display=make('p',null,'video-state');display.id='video-state';
 const playable=works.filter(w=>w.status==='approved'&&sourceUrl(w.playUrl));
 const drafts=works.filter(w=>w.status!=='approved'&&sourceUrl(w.previewUrl));
 const queued=tasks.filter(t=>t.status==='queued');
 const choice=data.choice;
 display.textContent=playable.length?'已确认 · 本件视频可播放':drafts.length?'样片已制作 · 等待店主确认':queued.length?'已排队 · 尚未成片':!assets.length?'没有本件实拍素材':(choice?.choiceId||data.choiceId)?'已登记本次素材选择，尚无可播版':'有本件原图 · 制作前请复核权属和许可';
 join(h,display);if(notices.has(c.productId))h.append(make('small',notices.get(c.productId)));
 const clips=[...playable,...drafts];
 for(const w of clips){
  const published=playable.includes(w),v=make('video');v.controls=true;v.playsInline=true;v.preload='metadata';v.src=sourceUrl(published?w.playUrl:w.previewUrl);v.dataset.kind=published?'approved':'preview';v.dataset.version=String(w.workVersion);
  const card=make('div',null,'video-work');join(card,make('strong',published?'本件已确认版本':'店主预览 · 等待确认'),make('small','作品 '+w.workId+' · v'+w.workVersion),v);
  const tid=w.taskId||tasks.find(t=>t.workRef?.workId===w.workId||t.workId===w.workId)?.taskId;
  if(!published&&tid)control(card,'confirm-'+uri(tid),'确认使用这个版本 v'+w.workVersion,()=>mutate(c,'confirm',{workVersion:w.workVersion},tid),'primary').dataset.action='confirm';
  h.append(card);
 }
 for(const t of tasks){const row=make('div',null,'video-task');row.dataset.taskId=t.taskId;join(row,make('small','任务 '+t.taskId+' · '+(workLabels[t.status]||t.status)));if(t.status==='queued')control(row,'render-'+uri(t.taskId),'制作本件样片',()=>mutate(c,'render',{},t.taskId)).dataset.action='render';h.append(row)}
 if(assets.length){
  const set=make('details');set.id='setup-video';set.append(make('summary','选择本次素材并登记许可'));
  const picked=new Map();for(const [i,id] of assets.entries()){
   const label=make('label',null,'choice'),e=make('input');e.type='checkbox';e.value=id;e.name='video-asset';join(label,e,thumb(id),make('span','本件第 '+(i+1)+' 张'));set.append(label);picked.set(id,e);
  }
  const y=make('input');y.type='checkbox';y.id='rights-check';const rights=make('label',null,'choice');join(rights,y,make('span','我已核对所选素材属于本件，并有权用于本次店内短片'));set.append(rights);
  set.append(make('small','本次样式：竖屏商品卡。此选择不作为长期偏好。'));
  control(set,'save-setup','保存本次制作选择',async()=>{const assetIds=[...picked].filter(([,e])=>e.checked).map(([id])=>id);if(!assetIds.length||!y.checked)throw new Error('请先选择本件实拍，并核对本次使用许可。');await mutate(c,'setup',{expectedVersion:c.productVersion,assetIds,rightsConfirmed:true,style:'portrait_card'})});
  h.append(set);
 }
 control(h,'request-video',playable.length?'取回本件已确认视频':'查找或申请本件视频',()=>mutate(c,'request',{expectedVersion:c.productVersion}),'primary');
 h.append(make('small','外店状态：未提交。'));
}
async function drawDesk(){
 const h=$('desk-tasks');if(!h)return;
 let data;try{data=await api('/api/desk/tasks')}catch(e){h.textContent='待办暂未读到：'+errorMsg(e);return}
 h.replaceChildren();const inventory=asArray(data.inventory),video=asArray(data.video);
 if(!inventory.length&&!video.length){h.append(make('p','本店目前没有库存或视频任务。','muted'));return}
 for(const t of [...inventory,...video]){
  const stock=inventory.includes(t);const line=make('details',null,'desk-task');line.dataset.taskId=t.taskId;
  join(line,make('summary',(stock?'核实库存':'本件视频')+' · '+(stock?(t.status==='resolved'?'已核实':'待核实'):(workLabels[t.status]||t.status))),make('small','商品 '+t.productId+' · 任务 '+t.taskId));
  if(stock)line.append(make('p',t.originalQuestion?'原问题：'+t.originalQuestion:'历史待办没有保存原问题。'));
  control(line,'desk-'+uri(t.taskId),'打开这张原卡',()=>openCard(t.productId));h.append(line);
 }
}
wire('refresh-desk',drawDesk);
guarded(()=>refresh());

// User-driven installation only. Never imply that a manifest or prompt installed a phone app.
if(window.isSecureContext&&'serviceWorker' in navigator){
 navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{
  $('install-help').textContent='当前浏览器未启用桌面入口；可继续联网使用本页。';
 });
 let installOffer=null;const install=$('install-desk'),msg=$('install-help');
 const installed=()=>{installOffer=null;install.hidden=true;msg.textContent='当前以桌面工作台方式打开。仍需连接测试店，离线不显示业务资料。'};
 if(matchMedia('(display-mode: standalone)').matches)installed();
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installOffer=e;install.hidden=false});
 install.addEventListener('click',async()=>{const offer=installOffer;if(!offer)return;installOffer=null;install.hidden=true;
  try{await offer.prompt();const choice=await offer.userChoice;msg.textContent=choice.outcome==='accepted'?'已在浏览器中接受安装提示，是否完成请查看本机桌面。':'已取消安装，仍可继续使用本页。'}catch{msg.textContent='当前浏览器未打开安装提示，可从浏览器菜单查看桌面入口。'}
 });
 window.addEventListener('appinstalled',installed);
}
