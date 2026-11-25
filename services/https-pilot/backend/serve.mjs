import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {makeTurnService,TurnError} from './agents-deepseek.mjs';
import {Fault,exact,fail,loadCatalog,loadConfig,readModelSecret,secureFile,sha} from './config.mjs';
import {OWNER_COOKIE,NONCE_COOKIE,OWNER_SECONDS,openState,tokenShape} from './state.mjs';

const pages=new URL('./public/',import.meta.url);
const localError={SESSION_REQUIRED:'请从本店应用首页配对。',STALE_SELECTION:'商品已切换，请先重新确认当前商品。',
  SOURCE_NOT_READY:'本店资料未就绪；没有读取商品事实。',MODEL_NOT_READY:'本店模型未就绪；本次没有生成报价。',
  PAIR_INVALID:'配对码无效、过期或使用过。',PAIR_PAGE_EXPIRED:'配对页已失效，请回到同源首页。',
  PAIR_RATE_LIMITED:'配对尝试过多，请稍后再试。',TURN_LIMIT:'提问次数达到本店上限。',OWNER_ALREADY_BOUND:'本店已有有效安装。',
  QA_HOLD_TIMEOUT:'本轮等待放行超时，已退出验收状态。',QA_NOT_ACTIVE:'本轮验收已退出。',QA_SOURCE_UNVERIFIED:'本轮原卡回执不完整，未进入延迟验收。'};
const err=(c,message)=>({error:{code:c,message:message||localError[c]||'操作未完成。'}});
function pairPage(nonce){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配对珠宝店主助手</title><style>body{font:18px system-ui;margin:0;background:#faf8f0;color:#234135}main{max-width:33rem;padding:2rem;margin:6vh auto}input,button{display:block;margin:1rem 0;padding:.65rem;font:inherit}input{width:100%;box-sizing:border-box}</style><main><h1>配对珠宝店主助手</h1><p>从本店操作员取得本次短期配对码，直接在这里输入。</p><form id="n15-pair" method="post" action="/api/pair"><label>一次性配对码<input name="code" type="password" required maxlength="64" autocomplete="off" spellcheck="false"></label><input type="hidden" name="nonce" value="${nonce}"><button>配对并打开</button></form><p id="state" role="alert"></p><noscript>本店配对需要启用 JavaScript。</noscript></main><script type="module" src="/pair.mjs"></script></html>`;}
function cookie(req,name){const c=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));return c.length===1?c[0].slice(name.length+1):null;}
const bake=(n,v,age)=>`${n}=${v}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`;
async function json(req){
  if((req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')fail('CONTENT_TYPE',415);
  if(Number(req.headers['content-length'])>8192)fail('BODY_LIMIT',413);
  let n=0;const b=[];for await(const c of req){n+=c.length;if(n>8192)fail('BODY_LIMIT',413);b.push(c);}
  try{return JSON.parse(Buffer.concat(b).toString('utf8'));}catch{fail('INVALID_BODY',400);}
}
const pick=x=>{if(!['A','B',null].includes(x.productId)||!Number.isSafeInteger(x.seq)||x.seq<0||x.seq>=Number.MAX_SAFE_INTEGER)fail('INVALID_SELECTION',400);};
const hashScripts=html=>[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(x=>!x[1].includes('src='))
  .map(x=>`'sha256-${createHash('sha256').update(x[2].replace(/\r\n?/g,'\n')).digest('base64')}'`).join(' ');
const secureHeaders=(html='')=>({'Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY','Cross-Origin-Resource-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':`default-src 'none'; script-src 'self' ${hashScripts(html)}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`});

export async function start(cfg,{clock,testTurn,holdMs=75_000}={}){
  if(testTurn!==undefined&&(!process.env.NODE_TEST_CONTEXT||!cfg.host.endsWith('.test')||typeof testTurn!=='function'))fail('TEST_INJECTION_DENIED',500);
  const catalog=loadCatalog(cfg), ownerHtml=readFileSync(new URL('index.html',pages),'utf8')
    .replaceAll('请从测试店启动入口重新打开','请重新打开本店助手并检查配对')
    .replaceAll('会话未打开，请从测试店本机启动入口进入。','会话未打开，请返回同源首页检查配对。');
  const pairJS=readFileSync(new URL('pair.mjs',pages),'utf8');
  // Linux only in CLI; tests use a kernel-private named pipe on Windows, not a TCP application listener.
  if(process.platform==='linux'){
    const d=lstatSync(dirname(cfg.socketPath));
    if(!d.isDirectory()||(d.mode&0o007)!==0||existsSync(cfg.socketPath))fail('SOCKET_DIRECTORY_OR_EXISTING_SOCKET',503);
  }
  const store=openState(cfg,clock), perform=makeTurnService(catalog,{getApiKey:()=>readModelSecret(cfg),modelId:cfg.modelId});
  const readySource=()=>{try{return sha(secureFile(cfg.snapshotFile,16000))===cfg.snapshotSha256;}catch{return false;}};
  const view=id=>{const x=catalog.read(id);return {productId:id,cardId:x.cardId,productVersion:x.version,priceYuan:x.priceText,size:x.size,inventory:null};};
  let running=0,closing=false;
  const pending=new Map();
  const server=http.createServer(async(req,res)=>{
    const at=new Date().toISOString(),p=req.url,m=req.method;
    const out=(s,b,t='application/json; charset=utf-8',extra={})=>{if(res.destroyed)return;res.writeHead(s,{'Content-Type':t,...secureHeaders(t.startsWith('text/html')?b:''),...extra});res.end(m==='HEAD'?undefined:b);};
    const send=(s,b,extra)=>out(s,JSON.stringify(b),undefined,extra);
    try{
      // Unix-only listener is the proxy trust boundary. Never inspect forwarding headers for origin, identity, scheme, or quotas.
      if(req.socket.remoteAddress!==undefined||req.headers.host!==cfg.host)fail('TRUST_BOUNDARY',403);
      const o=req.headers.origin,f=req.headers['sec-fetch-site'];
      if((o!==undefined&&o!==cfg.origin)||(f!==undefined&&!['none','same-origin'].includes(f)))fail('ORIGIN_DENIED',403);
      if(m==='POST'&&o!==cfg.origin){if(p!=='/api/pair'||!(f==='same-origin'||req.headers.referer===cfg.origin+'/'))fail('ORIGIN_REQUIRED',403);}
      if(typeof p!=='string'||p.length>120||!/^\/[A-Za-z0-9/_.-]*$/.test(p)||p.startsWith('//'))fail('INVALID_PATH',400);
      if(closing)fail('STOPPING',503);
      if(p==='/healthz'&&m==='GET'){send(200,{ok:true,service:'n15-https-readonly',contract:'n15.v1'});return;}
      if(p==='/readyz'&&m==='GET'){
        const source=readySource(),model=Boolean(readModelSecret(cfg)),ready=source&&(cfg.modelPolicy==='disabled'||model);
        send(ready?200:503,{ready,source,model,modelPolicy:cfg.modelPolicy});return;
      }
      if(p==='/pair.mjs'&&m==='GET'){out(200,pairJS,'text/javascript; charset=utf-8');return;}
      const owner=store.auth(cookie(req,OWNER_COOKIE));
      if(p==='/'&&(m==='GET'||m==='HEAD')){
        if(owner){out(200,ownerHtml,'text/html; charset=utf-8');return;}
        if(m==='HEAD'){out(200,'','text/html; charset=utf-8');return;}
        const n=store.pageNonce(cookie(req,NONCE_COOKIE));out(200,pairPage(n),'text/html; charset=utf-8',{'Set-Cookie':bake(NONCE_COOKIE,n,600)});return;
      }
      if(p==='/api/pair'&&m==='POST'){
        if(owner)fail('ALREADY_PAIRED',409);
        if(!readySource())fail('SOURCE_NOT_READY',503);
        const x=exact(await json(req),['code','nonce']);
        if(!tokenShape(x.nonce)||x.nonce!==cookie(req,NONCE_COOKIE))fail('PAIR_PAGE_EXPIRED',403);
        const r=store.redeem(x.code,x.nonce);if(!r.token)fail(r.error,r.status);
        send(200,{paired:true},{'Set-Cookie':[bake(OWNER_COOKIE,r.token,OWNER_SECONDS),bake(NONCE_COOKIE,'',0)]});return;
      }
      if(!owner)fail('SESSION_REQUIRED',401);
      if(p==='/api/session'&&m==='GET'){send(200,store.publicScope(store.expect(owner)));return;}
      if(p==='/api/selection'&&m==='POST'){
        const x=exact(await json(req),['productId','seq']);pick(x);send(200,store.select(owner,x.productId,x.seq));return;
      }
      if((p==='/api/cards'||/^\/api\/cards\/(?:A|B)$/.test(p))&&m==='GET'){
        if(!readySource())fail('SOURCE_NOT_READY',503);
        send(200,p==='/api/cards'?['A','B'].map(view):view(p.at(-1)));return;
      }
      if(p==='/api/agent/turn'&&m==='POST'){
        const x=exact(await json(req),['text','mode','productId','seq']);pick(x);
        if(typeof x.text!=='string'||!x.text.trim()||[...x.text.trim()].length>500||!['album','catalog','sales','style',null].includes(x.mode))fail('INVALID_BODY',400);
        if(x.productId!==null&&!readySource())fail('SOURCE_NOT_READY',503);
        if(running>=4||(pending.get(owner)||0)>=2)fail('TURN_LIMIT',429);
        const id=randomUUID(),version=x.productId===null?null:catalog.read(x.productId).version;
        const s=store.reserve(owner,x.productId,x.seq,x.productId===null||Boolean(readModelSecret(cfg)),{requestId:id,requestAt:at,productVersion:version});
        const event=(status,code,r)=>({requestId:id,requestAt:at,sessionKind:s.kind,selectionSeq:s.seq,productId:s.card,
          productVersion:r?.toolReceipts?.[0]?.version??version,status,code,providerAttempts:r?.httpAttempts??0,
          toolReads:r?.toolReceipts?.length??0,publicTestNo:s.publicNo??null});
        const log=(...args)=>store.audit(event(...args));
        const replyMeta={requestId:id,selectionSeq:s.seq,...(s.publicNo?{publicTestNo:s.publicNo}:{})};
        const isVerified=r=>{const t=r?.toolReceipts?.[0];return r?.live===true&&r.toolReceipts.length===1&&t.productId===s.card&&
          t.name==='read_selected_jewelry_card'&&t.cardId===catalog.read(s.card).cardId&&t.version===version;};
        running++;pending.set(owner,(pending.get(owner)||0)+1);
        try{
          // No card always uses the SDK adapter's own zero-call clarification, never the selected-card fixture/remote path.
          const ret=await (s.card!==null&&testTurn?testTurn:perform)({productId:s.card,text:x.text.trim(),mode:x.mode},catalog);
          if(s.card!==null&&!readySource())fail('SOURCE_NOT_READY',503);
          if(s.kind==='qa'&&s.card!==null){
            if(!isVerified(ret.runtime))fail('QA_SOURCE_UNVERIFIED',502);
            if(s.card==='A'){
              store.qaMark(s,event(200,'QA_A_HELD',ret.runtime));
              const deadline=Math.min(Date.now()+holdMs,Date.parse(at)+100_000);let q=store.qaContext(s);
              while(q&&!q.released&&!res.destroyed&&!closing&&Date.now()<deadline){await pause(60);q=store.qaContext(s);}
              if(!q||res.destroyed||closing)fail('QA_NOT_ACTIVE',409);
              if(!q.released)fail('QA_HOLD_TIMEOUT',504);
              if(!readySource())fail('SOURCE_NOT_READY',503);
              log(200,'QA_A_RELEASED',ret.runtime);
            }else{
              if(!store.same(s))fail('STALE_SELECTION',409);
              store.qaMark(s,event(200,'QA_B_READY',ret.runtime));
            }
          }else{
            if(!store.same(s))fail('STALE_SELECTION',409);
            log(200,s.card===null?'NO_CARD_LOCAL':'OK',ret.runtime);
          }
          send(200,{...ret,...replyMeta});
        }catch(e){
          const fault=e instanceof Fault||e instanceof TurnError, code=fault?e.code:'TURN_FAILED', status=fault?e.status:500;
          log(status,code,e instanceof TurnError?e.runtime:null);
          if(s.kind==='qa'&&s.card!==null&&store.qaContext(s))store.qaEnd(s.id,'QA_ABORTED_NO_REPEAT');
          send(status,{...err(code),productId:s.card,...replyMeta});
        }finally{running--;const n=pending.get(owner)-1;if(n)pending.set(owner,n);else pending.delete(owner);}
        return;
      }
      fail('NOT_FOUND',404);
    }catch(e){if(!res.headersSent&&!res.destroyed)send(e instanceof Fault?e.status:500,err(e instanceof Fault?e.code:'SERVICE_ERROR'));}
  });
  server.requestTimeout=10000;server.headersTimeout=7000;server.keepAliveTimeout=3000;
  function close(){if(closing)return;closing=true;server.close();server.closeIdleConnections();const t=setInterval(()=>{if(running===0){clearInterval(t);store.close();finish();}},60);}
  let finish;const done=new Promise(r=>{finish=r;});
  try{await new Promise((yes,no)=>{server.once('error',no);server.listen(cfg.socketPath,()=>{server.off('error',no);yes();});});
    if(process.platform==='linux')chmodSync(cfg.socketPath,0o660);
    store.clearQA();
  }catch(e){server.close();store.close();throw e;}
  return {close,done,server};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const main=async()=>{
    if(process.platform!=='linux')fail('LINUX_DEPLOYMENT_RUNTIME_REQUIRED',503);
    const node=process.versions.node.split('.').map(Number);
    if(node[0]<22||(node[0]===22&&node[1]<13))fail('PINNED_NODE_22_13_PLUS_REQUIRED',503);
    process.umask(0o077);
    const app=await start(loadConfig(process.env.N15_CONFIG));
    process.once('SIGTERM',app.close);process.once('SIGINT',app.close);
    console.log('N15_READY_PRIVATE_SOCKET');await app.done;
  };
  main().catch(e=>{console.error(e instanceof Fault?e.code:'N15_BOOT_FAILED');process.exitCode=2;});
}
