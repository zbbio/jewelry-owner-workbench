import http from "node:http";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {extname,isAbsolute,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {readFile,realpath,stat} from "node:fs/promises";
import {prepareCatalog,type ProductId,type Turn} from "./catalog.js";
import {makeTurnService,TurnError,type Runtime} from "./agent.js";

const webRoot=fileURLToPath(new URL("../web/",import.meta.url));
const mime:Record<string,string>={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon",".woff2":"font/woff2"};
const token=()=>randomBytes(32).toString("base64url");
class HttpError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
const invalid=()=>new HttpError(400,"INVALID_BODY","请求包含不支持的字段或值，请刷新后重试。");
interface Selection {productId:ProductId|null;seq:number}
interface Session extends Selection {until:number;pending:number;turns:number}
interface Audit {id:string;ts:string;productId:ProductId|null;selectionSeq:number;status:number;code:string;runtime:Runtime}
function checkKeys(x:unknown,keys:string[]):Record<string,unknown>{
  if(!x||typeof x!=="object"||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k))) throw invalid();
  return x as Record<string,unknown>;
}
function selection(v:Record<string,unknown>):Selection{
  const {productId,seq}=v;
  if((productId!==null&&productId!=="A"&&productId!=="B") || typeof seq!=="number" || !Number.isSafeInteger(seq) || seq<0 || seq>100000000) throw invalid();
  return {productId,seq};
}
async function readJSON(req:http.IncomingMessage){
  if((req.headers["content-type"]||"").split(";")[0].trim().toLowerCase()!=="application/json") throw new HttpError(415,"JSON_ONLY","请发送纯文本问题的 JSON 请求。");
  const chunks:Buffer[]=[];let total=0;
  for await(const chunk of req) {const b=Buffer.from(chunk);total+=b.length;if(total>8192) throw new HttpError(413,"TOO_LARGE","本次问题过长。");chunks.push(b);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw invalid();}
}
export async function startServer(port=0) {
  if(!Number.isInteger(port)||port<0||port>65535)throw Error("INVALID_PORT");
  const connection=await prepareCatalog(),perform=makeTurnService(connection.catalog);
  const launches=new Map<string,number>(),sessions=new Map<string,Session>(),log:Audit[]=[];
  let globalPending=0,closed=false;
  const reap=()=>{const t=Date.now();for(const [k,v] of launches)if(v<=t)launches.delete(k);for(const [k,v] of sessions)if(v.until<=t&&!v.pending)sessions.delete(k);};
  const save=(r:Audit)=>{log.push(structuredClone(r));if(log.length>128)log.shift();};
  const server=http.createServer(async(req,res)=>{
    const send=(s:number,payload:string|Buffer,t="application/json; charset=utf-8",extra:Record<string,string>={})=>{
      const hashes=t.startsWith("text/html")?Array.from(payload.toString().matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi))
        .filter(m=>!/(?:\s|^)src\s*=/i.test(m[1])).map(m=>"'sha256-"+createHash("sha256").update(m[2].replace(/\r\n?/g,"\n")).digest("base64")+"'"):[];
      res.writeHead(s,{"Content-Type":t,"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",
        "Cross-Origin-Resource-Policy":"same-origin","Permissions-Policy":"camera=(), microphone=(), geolocation=()",
        "Content-Security-Policy":"default-src 'self'; script-src 'self' "+hashes.join(" ")+"; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",...extra});
      res.end(req.method==="HEAD"?undefined:payload);
    };
    const json=(s:number,v:unknown)=>send(s,JSON.stringify(v));
    try {
      reap();
      const address=server.address(),host=req.headers.host;
      if(!address||typeof address==="string" || host!=="127.0.0.1:"+address.port) throw new HttpError(403,"LOCAL_HOST_ONLY","请从本次本机入口打开。");
      const origin="http://"+host, raw=req.url??"/";
      if(!raw.startsWith("/")||raw.startsWith("//")||raw.includes("?")||raw.includes("#")||raw.includes("\\")) throw new HttpError(400,"INVALID_PATH","无效入口。");
      if((req.headers.origin!==undefined && req.headers.origin!==origin) || (req.method==="POST"&&req.headers.origin!==origin)) throw new HttpError(403,"ORIGIN_DENIED","仅接受当前页面发起的操作。");
      const url=new URL(raw,origin),path=url.pathname;
      const cookieName="n9session_"+address.port;
      const launch=/^\/open\/([a-zA-Z0-9_-]{43})$/.exec(path);
      if(launch){
        if(req.method!=="GET") throw new HttpError(405,"GET_REQUIRED","请打开本次试用入口。");
        if(!launches.delete(launch[1])) throw new HttpError(401,"LAUNCH_EXPIRED","本次入口已用过或已过期。");
        if(sessions.size>=16) throw new HttpError(429,"SESSION_LIMIT","本机试用会话已满。");
        const s=token();sessions.set(s,{productId:null,seq:0,pending:0,turns:0,until:Date.now()+30*60000});
        send(303,"","text/plain",{"Location":"/","Set-Cookie":cookieName+"="+s+"; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800"});return;
      }
      if(path==="/api/health"&&req.method==="GET"){json(200,{ok:true,service:"jewelry-agent-readonly",sdk:"@openai/agents",remoteModel:"on-selected-turn-only"});return;}
      const ck=(req.headers.cookie||"").split(";").map(c=>c.trim()).filter(c=>c.startsWith(cookieName+"="));
      const session=ck.length===1?sessions.get(ck[0].slice(cookieName.length+1)):undefined;
      if(!session||session.until<=Date.now()) throw new HttpError(401,"SESSION_REQUIRED","请从本次试用入口打开助手。");
      if(path==="/api/session"&&req.method==="GET"){json(200,{productId:session.productId,seq:session.seq});return;}
      if(path==="/api/selection"){
        if(req.method!=="POST")throw new HttpError(405,"POST_REQUIRED","需要 POST。");
        const desired=selection(checkKeys(await readJSON(req),["productId","seq"]));
        if(desired.seq<=session.seq)throw new HttpError(409,"STALE_SELECTION","这次选卡已过期，请以较新选择为准。");
        session.productId=desired.productId;session.seq=desired.seq;json(200,desired);return;
      }
      if(path==="/api/agent/turn"){
        if(req.method!=="POST")throw new HttpError(405,"POST_REQUIRED","需要 POST。");
        const v=checkKeys(await readJSON(req),["text","mode","productId","seq"]),want=selection(v);
        if(typeof v.text!=="string"||!v.text.trim()||Array.from(v.text.trim()).length>500 ||
          (v.mode!==null&&!(typeof v.mode==="string"&&["album","catalog","sales","style"].includes(v.mode))))throw invalid();
        if(want.seq!==session.seq||want.productId!==session.productId)throw new HttpError(409,"STALE_SELECTION","商品已切换，请在当前商品上重新提问。");
        if(session.pending>=2||globalPending>=4||session.turns>=30)throw new HttpError(429,"TURN_LIMIT","本次试用请求较多，请稍后或重新开一个试用会话。");
        // Freeze selection on admission. A later valid B selection must not be overwritten by a late A response.
        const turn:Turn={productId:session.productId,mode:v.mode as Turn["mode"],text:v.text.trim()};
        const seq=session.seq,id=randomUUID(),ts=new Date().toISOString();
        session.pending++;globalPending++;session.turns++;
        try {
          const result=await perform(turn);
          save({id,ts,productId:turn.productId,selectionSeq:seq,status:200,code:"OK",runtime:result.runtime});
          json(200,{...result,selectionSeq:seq,requestId:id});
        } catch(e) {
          if(!(e instanceof TurnError)) throw e;
          save({id,ts,productId:turn.productId,selectionSeq:seq,status:e.status,code:e.code,runtime:e.runtime});
          json(e.status,{error:{code:e.code,message:e.message},productId:turn.productId,selectionSeq:seq,requestId:id,runtime:e.runtime});
        } finally {session.pending--;globalPending--;}
        return;
      }
      if(req.method!=="GET"&&req.method!=="HEAD")throw new HttpError(405,"METHOD_DENIED","不支持此操作。");
      const decoded=decodeURIComponent(path);
      if(decoded.split("/").some(s=>s.startsWith("."))||!/^\/[\p{L}\p{N}_./ -]*$/u.test(decoded)||decoded.startsWith("//"))throw new HttpError(404,"NOT_FOUND","未找到资源。");
      const root=await realpath(webRoot);
      const resource=await realpath(resolve(root,decoded==="/"?"index.html":decoded.slice(1))).catch(()=>null);
      if(resource){
        const sub=relative(root,resource),type=mime[extname(resource).toLowerCase()];
        if(sub&&sub!==".."&&!sub.startsWith(".."+sep)&&!isAbsolute(sub)&&type&&(await stat(resource)).isFile()){send(200,await readFile(resource),type);return;}
      }
      throw new HttpError(404,"NOT_FOUND","未找到资源。");
    } catch(e) {
      if(!res.headersSent){const er=e instanceof HttpError?e:new HttpError(500,"SERVICE_ERROR","服务没有完成本次操作。");json(er.status,{error:{code:er.code,message:er.message}});}
    }
  });
  server.requestTimeout=12000;server.headersTimeout=10000;
  server.on("close",()=>{closed=true;launches.clear();sessions.clear();connection.close();});
  await new Promise<void>((yes,no)=>{server.once("error",no);server.listen(port,"127.0.0.1",()=>{server.off("error",no);yes();});}).catch(e=>{connection.close();throw e;});
  const addr=server.address();if(!addr||typeof addr==="string")throw Error("BIND_FAILED");
  const origin="http://127.0.0.1:"+addr.port;
  return {origin,server,issueLaunch:()=>{
    reap();if(closed||launches.size>=16)throw Error("LAUNCH_UNAVAILABLE");
    const t=token();launches.set(t,Date.now()+180000);return origin+"/open/"+t;
  },getAudit:()=>structuredClone(log),
    close:()=>new Promise<void>((yes,no)=>{if(closed){yes();return;}server.close(e=>e?no(e):yes());server.closeIdleConnections();})};
}
