import http from "node:http";
import path from "node:path";
import { salesPort, mainPort, guestOrigin, ownerOrigin, sqlitePath, demoBase } from "./paths.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runAgent } from "./agent.mjs";
import { requestedSkus } from "./sales.mjs";
import { catalogResponse } from "./catalog-page.mjs";

const port=salesPort;
const here=new URL("./",import.meta.url);
const storefront=readFileSync(new URL("assets/storefront.html",here),"utf8");
const widget=readFileSync(new URL("anran-support.js",here),"utf8").replaceAll("__MAIN_PORT__",String(mainPort));
const css=readFileSync(new URL("anran-support.css",here));
const ownerPage=readFileSync(new URL("anran-owner.html",here),"utf8");
const productData=JSON.parse(readFileSync(new URL("sales-data.json",here),"utf8")).products;
const catalogBase=demoBase;
const demoProducts=new Set(["DEMO105","DEMO103"]);
const esc=(v)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dir=path.dirname(sqlitePath);
mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(sqlitePath);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, session_hash TEXT UNIQUE, created TEXT);
CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, thread TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, sku TEXT, sources TEXT, provider_id TEXT, state TEXT NOT NULL, UNIQUE(thread,id));
CREATE INDEX IF NOT EXISTS thread_messages ON messages(thread,seq);`);
const q=(sql)=>db.prepare(sql);
const queue=new Map();
const hash=(value)=>createHash("sha256").update(value).digest("hex");
const bySession=q("SELECT * FROM threads WHERE session_hash=?");
const allThreads=q("SELECT id,created FROM threads WHERE id IN (SELECT thread FROM messages) ORDER BY created DESC LIMIT 80");
const byThread=q("SELECT id,role,body,sku,sources,provider_id,state FROM messages WHERE thread=? ORDER BY seq");
const threadById=q("SELECT id,created FROM threads WHERE id=?");
const latestSent=q("SELECT seq, thread AS threadId, id AS messageId FROM messages WHERE role='assistant' AND state='sent' ORDER BY seq DESC LIMIT 1");
const sentReply=q("SELECT sku FROM messages WHERE thread=? AND id=? AND role='assistant' AND state='sent'");
const insertThread=q("INSERT INTO threads VALUES (?,?,?)");
const customer=q("INSERT OR IGNORE INTO messages(thread,id,role,body,sku,state) VALUES (?,?,'customer',?,?,'pending')");
const customerCount=q("SELECT COUNT(*) AS n FROM messages WHERE thread=? AND role='customer'");
const assistant=q("INSERT OR IGNORE INTO messages(thread,id,role,body,sku,sources,provider_id,state) VALUES (?,?,'assistant',?,?,?,?,?)");
const mark=q("UPDATE messages SET state=? WHERE thread=? AND id=?");
const productContext=q("SELECT sku FROM messages WHERE thread=? AND seq<(SELECT seq FROM messages WHERE thread=? AND id=?) AND role='assistant' AND sku IS NOT NULL ORDER BY seq DESC LIMIT 1");
const interrupted=q("SELECT thread,id,sku FROM messages WHERE role='customer' AND state='pending'");
function saveReply(thread,id,reply,sku,sources=[],requestId=null,state="sent") {
  db.exec("BEGIN");
  try {
    assistant.run(thread,"reply-"+id,reply,sku,JSON.stringify(sources),requestId,state);
    mark.run(state,thread,id);
    db.exec("COMMIT");
  } catch(e) {db.exec("ROLLBACK"); throw e;}
}
for(const item of interrupted.all()) saveReply(item.thread,item.id,"刚才连接中断了，请再问一次。",item.sku,[],null,"failed");
function threadFor(req) {
  const token=/(?:^|;\s*)anran_demo=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||"")?.[1];
  return token ? bySession.get(hash(token)) : undefined;
}
function conversation(thread, internal=false) {
  return {id:thread.id, messages:byThread.all(thread.id).map(m=>({
    id:m.id, role:m.role, text:m.body, productId:m.sku, status:m.state,
    ...(internal ? {sources:JSON.parse(m.sources||"[]"), routeRequestId:m.provider_id} : {}),
  }))};
}
function send(res,status,body,type="application/json; charset=utf-8",extra={}) {
  res.writeHead(status,{"content-type":type,"cache-control":"no-store","x-content-type-options":"nosniff",...extra});
  res.end(type.startsWith("application/json")?JSON.stringify(body):body);
}
async function body(req) {
  if(!/^application\/json(?:;|$)/i.test(req.headers["content-type"]||"")) throw Object.assign(new Error("需要 JSON 请求"),{status:415});
  const chunks=[]; let len=0;
  for await(const chunk of req) {len+=chunk.length;if(len>4096)throw Object.assign(new Error("消息过长"),{status:413});chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString("utf8"));} catch {throw Object.assign(new Error("数据格式错误"),{status:400});}
}
async function answer(thread,id,text,pageSku) {
  const explicit=requestedSkus(text);
  const sku=explicit.length===1?explicit[0]:pageSku||productContext.get(thread,thread,id)?.sku||null;
  if(explicit.length>1 || (sku&&!demoProducts.has(sku))) {
    saveReply(thread,id,"请选定一件演示商品后再问，或告诉我您看到的商品名称。",null);
    return;
  }
  try {
    const input=sku&&!explicit.length?`当前已选演示商品： ${sku}\n顾客原话：${text}`:text;
    const result=await runAgent(input,{storeSales:true});
    if(result.mode!=="deepseek"||result.tool!=="sales_prepare_reply"||!result.reply||!result.routeRequestId) throw new Error("No verified live reply");
    saveReply(thread,id,result.reply,result.receipt.result.productId||sku,result.receipt.result.sources,result.routeRequestId);
  } catch {
    saveReply(thread,id,"抱歉，销售助理暂时没有连上服务。请稍后再发一次。",sku,[],null,"failed");
  }
}
function schedule(thread,id,text,sku) {
  const next=(queue.get(thread)||Promise.resolve()).then(()=>answer(thread,id,text,sku)).catch(()=>console.error("Demo conversation commit failed"));
  queue.set(thread,next);
  void next.then(()=>{if(queue.get(thread)===next)queue.delete(thread);});
}
const accept=(pathname,p)=>pathname===p;
const html="text/html; charset=utf-8";
const ownerFrames={"content-security-policy":`frame-ancestors 'self' http://127.0.0.1:${mainPort} http://localhost:${mainPort}`};
function shop(sku,view,thread="",message="") {
  const addon=`<link rel="stylesheet" href="/demo/anran-support.css"><script defer src="/demo/anran-support.js" data-view="${view}" data-sku="${sku||""}" data-name="${sku?esc(productData[sku].name):""}" data-thread="${esc(thread)}" data-message="${esc(message)}"></script>`;
  return storefront.replace(/<\/body>/i,()=>addon+"</body>");
}
const server=http.createServer(async(req,res)=>{
  try {
    const host=req.headers.host, guest=host===`127.0.0.1:${port}`, owner=host===`localhost:${port}`;
    if(!guest&&!owner) return send(res,404,{error:"仅供本机演示"});
    const {pathname,searchParams}=new URL(req.url,guest?guestOrigin:ownerOrigin);
    if(req.method==="POST" && (!guest||req.headers.origin!==guestOrigin)) return send(res,403,{error:"请求来源不符"});
    if(req.method==="GET" && guest && accept(pathname,"/demo/shop")){
      const sku=searchParams.get("sku");
      if(sku&&!demoProducts.has(sku)) return send(res,404,{error:"演示商品未找到"});
      return send(res,200,shop(sku,"guest"),html,{"content-security-policy":"frame-ancestors 'none'"});
    }
    if(req.method==="GET" && owner && accept(pathname,"/demo/owner")){
      return send(res,200,ownerPage.replaceAll("__GUEST_ORIGIN__",guestOrigin),html,ownerFrames);
    }
    if(req.method==="GET" && owner && accept(pathname,"/demo/owner-shop")){
      const thread=searchParams.get("thread"), message=searchParams.get("message");
      const reply=thread&&message&&sentReply.get(thread,message);
      if(!reply) return send(res,404,{error:"已发送的会话消息未找到"});
      return send(res,200,shop(demoProducts.has(reply.sku)?reply.sku:null,"mirror",thread,message),html,ownerFrames);
    }
    if(req.method==="GET" && accept(pathname,"/demo/product-image") && demoProducts.has(searchParams.get("sku"))) {
      const out=await catalogResponse(catalogBase,new URL("/catalog/image?id="+searchParams.get("sku"),guestOrigin));
      return send(res,out.status,out.body,out.type);
    }
    if(req.method==="GET" && accept(pathname,"/demo/anran-support.js"))return send(res,200,widget,"text/javascript; charset=utf-8");
    if(req.method==="GET" && accept(pathname,"/demo/anran-support.css"))return send(res,200,css,"text/css; charset=utf-8");
    if(req.method==="GET" && owner && accept(pathname,"/demo/api/owner")) {
      const threads=allThreads.all();
      if(searchParams.get("watch")!=="1") return send(res,200,threads.map(t=>conversation(t,true)));
      const latestReply=latestSent.get()||null;
      for (const id of [latestReply?.threadId,searchParams.get("focus")]) {
        if(id&&!threads.some(t=>t.id===id)){const t=threadById.get(id);if(t)threads.push(t);}
      }
      return send(res,200,{threads:threads.map(t=>conversation(t,true)),latestReply});
    }
    if(req.method==="GET" && owner && accept(pathname,"/demo/api/owner-shop")){
      const thread=searchParams.get("thread"), message=searchParams.get("message");
      if(!thread||!message||!sentReply.get(thread,message)) return send(res,404,{error:"已发送的会话消息未找到"});
      return send(res,200,conversation({id:thread}));
    }
    if(guest && accept(pathname,"/demo/api/guest")){
      const t=threadFor(req);
      if(req.method==="GET")return send(res,t?200:401,t?conversation(t):{error:"请先打开销售助理"});
      if(req.method==="POST"){
        await body(req);
        if(t)return send(res,200,conversation(t));
        const token=randomBytes(32).toString("hex"),id=randomUUID();
        insertThread.run(id,hash(token),new Date().toISOString());
        return send(res,200,{id,messages:[]},undefined,{"set-cookie":`anran_demo=${token}; Path=/demo; HttpOnly; SameSite=Strict; Max-Age=604800`});
      }
    }
    if(guest && req.method==="POST" && accept(pathname,"/demo/api/message")){
      if(process.env.MVP_PREVIEW === '1')return send(res,503,{preview:true,error:'请先配置 DeepSeek 密钥，再启动在线演示。当前仅可查看店铺和商品资料。'});
      const t=threadFor(req);
      if(!t)return send(res,401,{error:"请先打开销售助理"});
      const v=await body(req),id=v?.id, text=typeof v?.text==="string"?v.text.trim():"", sku=v?.sku||null;
      if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||!text||text.length>350||(sku&&!demoProducts.has(sku)))return send(res,400,{error:"请核对商品和提问（最多 350 字）"});
      const existing=byThread.all(t.id).find(m=>m.id===id);
      if(existing) return send(res,existing.body===text&&existing.sku===sku?202:409,{id});
      if(customerCount.get(t.id).n>=30 || queue.size>=8 && !queue.has(t.id))return send(res,429,{error:"本次演示对话达到上限"});
      if(customer.run(t.id,id,text,sku).changes)schedule(t.id,id,text,sku);
      return send(res,202,{id});
    }
    return send(res,404,{error:"该演示入口不存在"});
  }catch(e){return send(res,e.status||500,{error:e.status?e.message:"演示服务暂时出错"});}
});
server.listen(port,"127.0.0.1",()=>console.log(`ANRAN_READY ${guestOrigin}/demo/shop`));
