import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {catalogResponse} from './catalog-page.mjs';
import {dataRoot,demoBase} from './paths.mjs';

const here=new URL('./',import.meta.url);
const bytes=n=>readFileSync(new URL(n,here));
const storefront=bytes('assets/anran-storefront.html').toString('utf8');
const ownerPage=bytes('anran-owner.html'),widget=bytes('anran-support.js'),css=bytes('anran-support.css'),launch=bytes('anran-launch.js');
const products=JSON.parse(bytes('sales-data.json').toString('utf8')).products;
const demoProducts=new Set(Object.keys(products).filter(id=>/^(?:BCMLDIY|DEMO)10[35]$/.test(id)));
const pinned=[...demoProducts].find(id=>id.endsWith('105'));
const hour=3600000,ttl=2*hour;
const folder=process.env.ANRAN_CLOUD_DB_DIR || path.join(dataRoot||here.pathname,'anran-cloud-demo');
mkdirSync(folder,{recursive:true,mode:0o700});
const db=new DatabaseSync(path.join(folder,'reception.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, session_hash TEXT UNIQUE, created TEXT);
CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, thread TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, sku TEXT, sources TEXT, provider_id TEXT, state TEXT NOT NULL, topic TEXT, media_url TEXT, UNIQUE(thread,id));
CREATE INDEX IF NOT EXISTS thread_messages ON messages(thread,seq);
CREATE TABLE IF NOT EXISTS demo_pairs (thread TEXT PRIMARY KEY, owner_hash TEXT NOT NULL UNIQUE, invite_hash TEXT UNIQUE, expires INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message_budget (hour INTEGER PRIMARY KEY, started INTEGER NOT NULL);`);
const q=s=>db.prepare(s);
if(!q('PRAGMA table_info(messages)').all().some(c=>c.name==='media_url')) db.exec('ALTER TABLE messages ADD COLUMN media_url TEXT');
const ownerBy=q('SELECT * FROM demo_pairs WHERE owner_hash=? AND expires>?');
const activeByThread=q('SELECT * FROM demo_pairs WHERE thread=? AND expires>?');
const byInvite=q('SELECT * FROM demo_pairs WHERE invite_hash=? AND expires>?');
const ownerRate=q('SELECT COUNT(*) AS n FROM demo_pairs WHERE created>?');
const newPair=q('INSERT INTO demo_pairs VALUES (?,?,?,?,?)');
const claim=q('UPDATE demo_pairs SET invite_hash=NULL WHERE thread=? AND invite_hash=?');
const clearThread=q('UPDATE threads SET session_hash=? WHERE id=?');
const expired=q('SELECT thread FROM demo_pairs WHERE expires<=?');
const delMessages=q('DELETE FROM messages WHERE thread=?');
const delThread=q('DELETE FROM threads WHERE id=?');
const delPair=q('DELETE FROM demo_pairs WHERE thread=?');
const newThread=q('INSERT INTO threads VALUES (?,?,?)');
const guestBy=q('SELECT * FROM threads WHERE session_hash=?');
const byThread=q('SELECT * FROM messages WHERE thread=? ORDER BY seq');
const latestSent=q("SELECT seq,thread AS threadId,id AS messageId FROM messages WHERE thread=? AND role='assistant' AND state='sent' ORDER BY seq DESC LIMIT 1");
const sentReply=q("SELECT sku FROM messages WHERE thread=? AND id=? AND role='assistant' AND state='sent'");
const customer=q("INSERT OR IGNORE INTO messages(thread,id,role,body,sku,state) VALUES (?,?,'customer',?,?,'pending')");
const existing=q("SELECT body,sku FROM messages WHERE thread=? AND id=? AND role='customer'");
const customerCount=q("SELECT COUNT(*) AS n FROM messages WHERE thread=? AND role='customer'");
const assistant=q("INSERT OR IGNORE INTO messages(thread,id,role,body,sku,sources,provider_id,state,topic,media_url) VALUES (?,?,'assistant',?,?,?,?,?,?,?)");
const mark=q("UPDATE messages SET state=? WHERE thread=? AND id=?");
const prior=q("SELECT sku,topic FROM messages WHERE thread=? AND seq<(SELECT seq FROM messages WHERE thread=? AND id=?) AND role='assistant' AND state='sent' AND sku IS NOT NULL ORDER BY seq DESC LIMIT 1");
const interrupted=q("SELECT thread,id,sku FROM messages WHERE role='customer' AND state='pending'");
const budget=q('SELECT started FROM message_budget WHERE hour=?');
const useBudget=q('INSERT INTO message_budget VALUES (?,1) ON CONFLICT(hour) DO UPDATE SET started=started+1');
const cleanBudget=q('DELETE FROM message_budget WHERE hour<?');
const queue=new Map();
function atomic(fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}
function saveReply(thread,id,reply,sku,sources=[],requestId=null,state='sent',topic=null,media=null) {
 atomic(()=>{
  assistant.run(thread,'reply-'+id,reply,sku,JSON.stringify(sources),requestId,state,topic,media);
  mark.run(state,thread,id);
 });
}
for(const item of interrupted.all())saveReply(item.thread,item.id,'刚才连接中断了，请再问一次。',item.sku,[],null,'failed');
function cleanup(now){
 atomic(()=>{
  for(const {thread} of expired.all(now)){
   if(queue.has(thread))continue;
   delMessages.run(thread);delThread.run(thread);delPair.run(thread);
  }
  cleanBudget.run(Math.floor(now/hour)-1);
 });
}
setInterval(()=>{try{cleanup(Date.now());}catch{console.error('Demo cleanup failed');}},15*60*1000).unref();
const hash=value=>createHash('sha256').update(value).digest('hex');
const newToken=()=>randomBytes(32).toString('hex');
const token=(req,name)=>new RegExp('(?:^|;\\s*)'+name+'=([a-f0-9]{64})(?:;|$)').exec(req.headers.cookie||'')?.[1];
function owned(req){const t=token(req,'anran_owner');return t?ownerBy.get(hash(t),Date.now()):null;}
function visiting(req){const t=token(req,'anran_demo');const g=t&&guestBy.get(hash(t));return g&&activeByThread.get(g.id,Date.now())?g:null;}
function cookie(req,name,value){
 const secure=req.socket.encrypted || req.headers['x-forwarded-proto']==='https';
 return name+'='+value+'; Path=/demo; HttpOnly; SameSite=Strict; Max-Age='+String(ttl/1000)+(secure?'; Secure':'');
}
function originOk(req){
 try{const u=new URL(req.headers.origin);return ['http:','https:'].includes(u.protocol)&&u.host===req.headers.host&&u.origin===req.headers.origin;}
 catch{return false;}
}
const html='text/html; charset=utf-8', json='application/json; charset=utf-8';
const frames={'content-security-policy':"frame-ancestors 'self'; base-uri 'self'; form-action 'self'"};
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function send(res,status,body,type=json,extra={}){
 res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin',...extra});
 res.end(type===json?JSON.stringify(body):body);
}
function denied(res){return send(res,403,{error:'此入口只对本次演示的店主开放'});}
async function body(req){
 if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Object.assign(Error('需要 JSON 请求'),{status:415});
 const data=[];let size=0;
 for await(const c of req){size+=c.length;if(size>4096)throw Object.assign(Error('消息过长'),{status:413});data.push(c);}
 try{return JSON.parse(Buffer.concat(data).toString('utf8'));}catch{throw Object.assign(Error('数据格式错误'),{status:400});}
}
function conversation(id,internal=false){
 return {id,messages:byThread.all(id).map(m=>({id:m.id,role:m.role,text:m.body,productId:m.sku,status:m.state,
   ...(m.media_url?.startsWith("https://")?{mediaUrl:m.media_url}:{}),
   ...(internal?{sources:JSON.parse(m.sources||'[]'),routeRequestId:m.provider_id,salesTopic:m.topic}:{})
 }))};
}
function shop(sku,view,thread='',message=''){
 const addon=`<link rel="stylesheet" href="/demo/anran-support.css"><script defer src="/demo/anran-support.js" data-view="${view}" data-sku="${sku||''}" data-name="${sku?esc(products[sku].name):''}" data-thread="${esc(thread)}" data-message="${esc(message)}"></script>`;
 return storefront.replace(/<\/body>/iu,()=>addon+'</body>');
}
async function answer(thread,id,text,pageSku){
 try{
  const {storeChat,storeRequestedSkus}=await import('./store-chat.mjs');
  const ids=storeRequestedSkus(text),prev=prior.get(thread,thread,id);
  const sku=ids.length===1?ids[0]:pageSku||prev?.sku||null;
  if(ids.length>1 || (sku&&!demoProducts.has(sku))){
   saveReply(thread,id,'请先确认想咨询的演示商品。',null);
   return;
  }
  const result=await storeChat(text,{productId:sku,previousProductId:prev?.sku||null,previousTopic:prev?.topic||null},[...demoProducts]);
  if(!result?.routeRequestId||typeof result.reply!=='string'||!result.reply)throw Error('Missing live provider receipt');
  const f=result.receipt.result;
  saveReply(thread,id,result.reply,f.productId||sku,f.sources,result.routeRequestId,'sent',f.topic,f.mediaUrl);
 }catch{
  saveReply(thread,id,'抱歉，客服暂时没有连上服务，请稍后再问。',pageSku,[],null,'failed');
 }
}
function schedule(thread,id,text,sku){
 const next=(queue.get(thread)||Promise.resolve()).then(()=>answer(thread,id,text,sku)).catch(()=>console.error('Demo conversation commit failed'));
 queue.set(thread,next);
 void next.then(()=>{if(queue.get(thread)===next)queue.delete(thread);});
}
export async function handleAnran(req,res,url){
 const {pathname:p,searchParams:qs}=url, m=req.method;
 try{
  if(m==='POST'&&!originOk(req))return send(res,403,{error:'请求来源不符'});
  if(m==='GET'&&p==='/demo/launch.js')return send(res,200,launch,'text/javascript; charset=utf-8');
  if(m==='GET'&&p==='/demo/anran-support.js')return send(res,200,widget,'text/javascript; charset=utf-8');
  if(m==='GET'&&p==='/demo/anran-support.css')return send(res,200,css,'text/css; charset=utf-8');
  if(m==='GET'&&p==='/demo/api/active')return owned(req)?send(res,200,{active:true}):denied(res);
  if(m==='POST'&&p==='/demo/api/start'){
   const now=Date.now();
   cleanup(now);
   if(ownerRate.get(now-hour).n>=20)return send(res,429,{error:'演示会话已达上限，请稍后重试'});
   const thread=randomUUID(), owner=newToken(), invite=newToken();
   atomic(()=>{newThread.run(thread,null,new Date(now).toISOString());newPair.run(thread,hash(owner),hash(invite),now+ttl,now);});
   const shop='/demo/shop?'+new URLSearchParams({invite,...(pinned?{sku:pinned}:{})});
   return send(res,200,{shop,owner:'/demo/owner'},json,{'set-cookie':cookie(req,'anran_owner',owner)});
  }
  if(m==='GET'&&p==='/demo/shop'){
   const sku=qs.get('sku');
   if(sku&&!demoProducts.has(sku))return send(res,404,{error:'演示商品未找到'});
   const invite=qs.get('invite'),g=visiting(req);
   if(invite!==null){
    const digest=/^[a-f0-9]{64}$/.test(invite)?hash(invite):null;
    const pair=digest&&byInvite.get(digest,Date.now());
    if(!pair)return send(res,404,'这个演示店铺链接已使用或过期，请从店主助手重新打开。',html,frames);
    const guest=newToken(),location='/demo/shop'+(sku?'?sku='+encodeURIComponent(sku):'');
    atomic(()=>{if(claim.run(pair.thread,digest).changes!==1)throw Error('Invite already used');clearThread.run(hash(guest),pair.thread);});
    return send(res,303,'',html,{location,'set-cookie':cookie(req,'anran_demo',guest)});
   }
   if(!g)return send(res,403,'请从店主助手的「销售接待」打开本次演示店铺。',html,frames);
   return send(res,200,shop(sku,'guest'),html,frames);
  }
  if(m==='GET'&&p==='/demo/product-image'&&(owned(req)||visiting(req))&&demoProducts.has(qs.get('sku'))){
   const out=await catalogResponse(demoBase,new URL('/catalog/image?id='+qs.get('sku'),'http://localhost'));
   return send(res,out.status,out.body,out.type);
  }
  if(m==='GET'&&['/demo/owner','/demo/owner-shop','/demo/api/owner','/demo/api/owner-shop'].includes(p)){
   const pair=owned(req);
   if(!pair)return denied(res);
   if(p==='/demo/owner')return send(res,200,ownerPage,html,frames);
   if(p==='/demo/api/owner'){
    const t=conversation(pair.thread,true),threads=t.messages.length?[t]:[];
    return send(res,200,qs.get('watch')==='1'?{threads,latestReply:latestSent.get(pair.thread)||null}:threads);
   }
   const thread=qs.get('thread'), id=qs.get('message');
   const reply=thread===pair.thread&&id&&sentReply.get(thread,id);
   if(!reply)return send(res,404,{error:'已发送的会话消息未找到'});
   return p==='/demo/owner-shop'?send(res,200,shop(demoProducts.has(reply.sku)?reply.sku:null,'mirror',thread,id),html,frames):send(res,200,conversation(thread));
  }
  if(p==='/demo/api/guest'&&(m==='GET'||m==='POST')){
   const g=visiting(req);
   return g?send(res,200,conversation(g.id)):send(res,401,{error:'请使用本次演示店铺入口'});
  }
  if(p==='/demo/api/message'&&m==='POST'){
   const g=visiting(req);
   if(!g)return send(res,401,{error:'请使用本次演示店铺入口'});
   const v=await body(req),id=v?.id,text=typeof v?.text==='string'?v.text.trim():'',sku=v?.sku||null;
   if(typeof id!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))||!text||text.length>350||(sku&&!demoProducts.has(sku)))return send(res,400,{error:'请核对演示商品与问题'});
   const old=existing.get(g.id,id);
   if(old)return send(res,old.body===text&&old.sku===sku?202:409,{id});
   const slot=Math.floor(Date.now()/hour);
   if(customerCount.get(g.id).n>=8||(budget.get(slot)?.started||0)>=40||(queue.size>=8&&!queue.has(g.id)))return send(res,429,{error:'演示答复已达上限，请稍后重试'});
   atomic(()=>{customer.run(g.id,id,text,sku);useBudget.run(slot);});
   schedule(g.id,id,text,sku);
   return send(res,202,{id});
  }
  return send(res,404,{error:'该演示入口不存在'});
 }catch(e){return send(res,e.status||500,{error:e.status?e.message:'销售演示暂不可用'});}
}
