const historyPath='/api/message-photos/messages', assetPath='/api/message-photos/assets';
const qid=x=>document.getElementById(x);
const fileTypes=new Set(['image/jpeg','image/png','image/webp']);
const id=()=>{
 const h=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
 return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
};
const assetId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function setupMessagePhotos({q,addMessage,reveal}){
 const camera=qid('message-photo-add'), choices=qid('message-photo-choices'), draft=qid('message-photo-draft');
 const status=qid('message-photo-status');
 const take=qid('message-photo-take'),pick=qid('message-photo-pick');
 const files=[qid('message-photo-camera-input'),qid('message-photo-album-input')];
 let staged=[],messageRequest=null,sending=false;
 const rendered=new Set();
 function hint(text){status.textContent=text;status.hidden=!text}
 const close=(focus=false)=>{choices.hidden=true;camera.setAttribute('aria-expanded','false');if(focus)camera.focus({preventScroll:true})};
 camera.addEventListener('click',()=>{
  if(!choices.hidden){close(true);return}
  choices.hidden=false;camera.setAttribute('aria-expanded','true');take.focus({preventScroll:true});
 });
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!choices.hidden){e.preventDefault();close(true)}
 });
 document.addEventListener('pointerdown',e=>{
  if(!choices.hidden&&!choices.contains(e.target)&&!camera.contains(e.target))close();
 });
 for(const [i,button] of [take,pick].entries())button.addEventListener('click',()=>{
  files[i].value='';files[i].click();close(true);
 });
 function renderDraft(){
  draft.replaceChildren();draft.hidden=!staged.length;
  for(const [i,row] of staged.entries()){
   const tile=document.createElement('div'), img=document.createElement('img'),remove=document.createElement('button');
   img.src=row.preview;img.alt='待发送照片 '+(i+1);
   remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除照片 '+(i+1));
   remove.addEventListener('click',()=>{
    if(sending)return;
    staged=staged.filter(x=>x!==row);URL.revokeObjectURL(row.preview);messageRequest=null;
    renderDraft();hint('');camera.focus({preventScroll:true});
   });
   tile.append(img,remove);draft.append(tile);
  }
 }
 for(const input of files)input.addEventListener('change',()=>{
  if(sending)return;
  const warning=new Set();
  for(const file of input.files){
   const key=JSON.stringify([file.name,file.size,file.lastModified,file.type]);
   if(!fileTypes.has(file.type)){warning.add('仅支持 JPEG、PNG 或 WebP。');continue}
   if(!file.size||file.size>10*1024*1024){warning.add('每张照片最多 10 MiB，空文件不可选。');continue}
   if(staged.some(x=>x.key===key)){warning.add('已略过重复选择的照片。');continue}
   if(staged.length>=3){warning.add('每条最多 3 张照片。');continue}
   staged.push({key,file,uploadKey:id(),preview:URL.createObjectURL(file),assetId:null});messageRequest=null;
  }
  input.value='';renderDraft();hint([...warning].join(' '));
 });
 async function checked(url,opts){
  const r=await fetch(url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(35000),...opts});
  if(!r.headers.get('content-type')?.startsWith('application/json'))throw Error('照片入口暂不可用。');
  const body=await r.json();
  if(!r.ok)throw Error(typeof body.error==='string'?body.error:'照片暂未发送。');
  return body;
 }
 function show(message){
  if(!assetId.test(message?.messageId||'')||rendered.has(message.messageId)||!Array.isArray(message.attachments))return;
  rendered.add(message.messageId);reveal();
  const owner=addMessage('owner','店主',message.text||'');owner.dataset.photoMessageId=message.messageId;
  const photos=document.createElement('div');photos.className='message-photo-links';
  for(const [i,asset] of message.attachments.entries()){
   if(!assetId.test(asset?.id||''))continue;
   const a=document.createElement('a'),img=document.createElement('img');
   a.href=assetPath+'/'+asset.id;a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label','打开原照片 '+(i+1));
   img.src=a.href+'/thumbnail';img.alt='照片 '+(i+1);img.loading='lazy';a.append(img);photos.append(a);
  }
  owner.append(photos);addMessage('assistant','助手',message.reply||'已收到照片。');
 }
 const init=()=>checked(historyPath).then(r=>{for(const m of r.messages||[])show(m);return true}).catch(()=>false);
 // First use creates the private cookie. On browsers supporting Web Locks, simultaneous
 // fresh tabs serialize that initial read so two pending sends don't fork the cookie.
 const initScoped=()=>navigator.locks?.request?navigator.locks.request('mvp-message-photos-scope',init):init();
 let ready=initScoped();
 async function send(text){
  if(sending||!staged.length)return;
  sending=true;close();
  q.readOnly=true;
  const controls=[...document.querySelectorAll('button:not(:disabled):not(#anran-return):not(#catalog-confirmation-open):not(#catalog-confirmation-close)')];
  for(const x of controls)x.disabled=true;
  hint('正在发送照片…');
  try{
   if(!await ready){ready=initScoped();if(!await ready)throw Error('相片接收暂不可用。')}
   for(const row of staged){
    if(!row.assetId){
     const out=await checked(assetPath,{method:'POST',headers:{'content-type':row.file.type,'x-message-photo-key':row.uploadKey},body:row.file});
     if(!assetId.test(out.asset?.id||''))throw Error('照片收据不完整。');
     row.assetId=out.asset.id;
    }
   }
   if(messageRequest?.text!==text)messageRequest={text,id:id()};
   const out=await checked('/api/chat',{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({text,attachments:staged.map(r=>r.assetId),requestId:messageRequest.id})});
   if(out.received!==true||out.messageId!==out.message?.messageId||!assetId.test(out.messageId||''))throw Error('照片消息回执不完整。');
   show(out.message);
   for(const row of staged)URL.revokeObjectURL(row.preview);
   staged=[];messageRequest=null;q.value='';renderDraft();hint('');
  }catch(e){hint((e.name==='TypeError'||e.name==='TimeoutError'?'连接暂时中断。':e.message)+' 已保留照片和文字，可重试发送。')}
  finally{sending=false;q.readOnly=false;for(const x of controls)x.disabled=false}
 }
 return {hasDraft:()=>staged.length>0,send};
}
