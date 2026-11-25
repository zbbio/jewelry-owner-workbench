import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {COOKIE,Fault,OWNER_S,PORT,SHOP,openStore,privateDir} from './会话库.mjs';
import {prepareCatalog} from './agent/dist/catalog.js';
import {makeTurnService,TurnError} from './agent/dist/agent.js';

const SHELL=new URL('./agent/web/index.html',import.meta.url);
const PAIR_SCRIPT=new URL('./配对页面.js',import.meta.url);
const PAIR_VERSION='n14-same-origin-json-nonce-v2';
const PAIR_COOKIE='n14pair';
const denied=(code,status)=>{throw new Fault(code,status);};
const messages={SESSION_REQUIRED:'请先在本店配对。',PAIR_INVALID:'配对码无效、已使用或已过期。请向电脑操作员获取新码。',
  PAIR_RATE_LIMITED:'配对尝试过多，请稍后再试。', ALREADY_PAIRED:'当前安装已配对。', MODEL_PAUSED:'当前后端暂停模型；没有生成报价。',
  STALE_SELECTION:'商品或QA状态已切换，请重开当前页面后再问。', QA_ORDER_OR_LIMIT:'本次验收只接一次 A、一次 B，请联系现场执行人。',
  QA_HOLD_TIMEOUT:'验收旧回包等候超时。', TURN_LIMIT:'本机会话提问较多，请稍后重试。',
  LOCAL_ONLY:'请从本机助手首页刷新后再配对。', PAIR_NONCE_EXPIRED:'配对页已过期，请返回助手首页刷新后再试。',
  OWNER_ALREADY_BOUND:'本店已有有效配对。请先让电脑操作员核对，不开第二个安装。', MODEL_NOT_CONFIGURED:'本机暂未启用模型。'};
const sha=s=>createHash('sha256').update(s).digest('hex');
const errBody=(code,message)=>({error:{code,message:message||messages[code]||'本机操作未完成。'}});
const pairingPage=(nonce,code='')=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配对珠宝助手</title><style>body{font:18px system-ui,sans-serif;margin:0;background:#f8f7f2;color:#18382a}main{max-width:34rem;margin:8vh auto;padding:2rem}input,button{display:block;font:inherit;padding:.75rem;margin:1rem 0;box-sizing:border-box}input{width:100%}button{background:#1c5138;color:white;border:0;border-radius:.5rem}small{display:block}</style><main><h1>配对这台珠宝助手</h1><p>请向电脑操作员获取本次的一次性配对码。配对后，直接从桌面重开助手即可。</p><p id="pair-status" role="alert">${messages[code]||''}</p><form id="n14-pair" method="post" action="/api/pair"><label for="code">一次性配对码</label><input id="code" name="code" type="password" required maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">配对并打开助手</button></form><small>请勿把配对码截图或分享。</small></main><script defer src="/n14-pair.js"></script></html>`;

async function readBody(req,types=['application/json'],diag){
  const type=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
  if(!types.includes(type))denied('CONTENT_TYPE',415);
  if(Number(req.headers['content-length'])>8192)denied('BODY_TOO_LARGE',413);
  const buffers=[];let size=0;
  for await(const c of req){size+=c.length;if(diag)diag.bodyBytes=size;if(size>8192)denied('BODY_TOO_LARGE',413);buffers.push(c);}
  const text=Buffer.concat(buffers).toString('utf8');
  try{
    if(type==='application/json')return JSON.parse(text);
    const params=[...new URLSearchParams(text)];
    if(diag)diag.fieldCount=params.length;
    if(new Set(params.map(x=>x[0])).size!==params.length)throw Error('body');
    return Object.fromEntries(params);
  }catch{denied('INVALID_BODY',400);}
}
function exact(body,keys){if(body===null||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length||
    keys.some(k=>!Object.hasOwn(body,k)))denied('INVALID_BODY',400);return body;}
function selection(x){if(![null,'A','B'].includes(x.productId)||!Number.isSafeInteger(x.seq)||x.seq<0||x.seq>Number.MAX_SAFE_INTEGER-1)denied('INVALID_SELECTION',400);}
function cookie(req,name=COOKIE){const found=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
  return found.length===1?found[0].slice(name.length+1):null;}
function headers(html){const hashes=html?Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi))
    .filter(m=>!/(?:\s|^)src\s*=/i.test(m[1])).map(m=>`'sha256-${createHash('sha256').update(m[2].replace(/\r\n?/g,'\n')).digest('base64')}'`):[];
  return {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
    'Cross-Origin-Resource-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':`default-src 'none'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`};}

export async function startLocal({dir=privateDir(),port=PORT,live=false,holdMs=90_000,clock}={}){
  const store=openStore(dir,{now:clock});
  let conn;
  try{conn=await prepareCatalog();}catch(e){store.close();throw e;}
  const agent=makeTurnService(conn.catalog);
  const data=alias=>{const f=conn.catalog.read(alias);if(f.shopId!==SHOP)throw Error('SHOP_PIN_FAILED');
    return {productId:f.productId,cardId:f.cardId,productVersion:f.version,priceYuan:f.priceText,size:f.size,inventory:f.inventory};};
  let cards,page,pairScript;
  try{cards={A:data('A'),B:data('B')};
    if(cards.A.priceYuan===null||cards.B.priceYuan!==null)throw Error('DEMO_CARDS_INVALID');
    page=(await readFile(SHELL,'utf8')).replaceAll('请从测试店启动入口重新打开','请返回助手首页并检查配对')
      .replaceAll('会话未打开，请从测试店本机启动入口进入。','会话未打开，请重新打开珠宝助手并检查配对。');
    pairScript=await readFile(PAIR_SCRIPT,'utf8');
  }catch(e){conn.close();store.close();throw e;}
  const runId=randomUUID(), pending=new Map();
  let inFlight=0, stopping=false, stopped=false, timer, origin;
  const server=http.createServer(async(req,res)=>{
    const requestAt=new Date().toISOString();
    const isPair=req.url==='/api/pair'&&req.method==='POST';
    const ho=req.headers.origin, fs=req.headers['sec-fetch-site'];
    const diag=isPair?{status:500,reason:'SERVICE_ERROR',originClass:ho===undefined?'absent':ho==='null'?'null':ho===origin?'same':'different',
      fetchSiteClass:['none','same-origin','same-site','cross-site'].includes(fs)?fs:fs===undefined?'absent':'other',
      bodyBytes:null,fieldCount:null,codeLength:null}:null;
    const classified=(rule)=>{if(diag)diag.reason=rule;denied('LOCAL_ONLY',403);};
    const send=(status,body='',kind='application/json; charset=utf-8',extra={})=>{
      if(res.destroyed)return;
      res.writeHead(status,{'Content-Type':kind,...headers(kind.startsWith('text/html')?body:null),...extra});
      res.end(req.method==='HEAD'?undefined:body);
    };
    const json=(s,o)=>send(s,JSON.stringify(o));
    const html=(s,o)=>send(s,o,'text/html; charset=utf-8');
    try{
      if(stopping)denied('SERVICE_STOPPING',503);
      const path=req.url, method=req.method;
      if(req.socket.remoteAddress!=='127.0.0.1')classified('REMOTE_NOT_LOOPBACK');
      if(req.headers.host!==origin?.slice(7))classified('HOST_MISMATCH');
      if(ho!==undefined&&ho!==origin)classified(ho==='null'?'ORIGIN_NULL':'ORIGIN_MISMATCH');
      if(fs!==undefined&&!['none','same-origin'].includes(fs))classified('FETCH_SITE_DENIED');
      if(method==='POST'&&ho!==origin){
        const jsonWire=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/json';
        // Only this endpoint: absent Origin needs independent same-origin evidence AND an active matching issued nonce below.
        if(!isPair||!jsonWire||!(fs==='same-origin'||req.headers.referer===origin+'/'))classified('ORIGIN_MISSING_WITHOUT_SAME_ORIGIN_PROOF');
      }
      if(typeof path!=='string'||(!/^\/[A-Za-z0-9/_-]*$/.test(path)&&path!=='/n14-pair.js')||path.startsWith('//'))denied('INVALID_PATH',400);
      if(path==='/api/health'&&method==='GET'){json(200,{ok:true,service:'n14-local-readonly',runId,model:live?'enabled_for_paired_questions':'paused',catalog:'synthetic_public_demo',pairProtocol:PAIR_VERSION});return;}
      if(path==='/n14-pair.js'&&['GET','HEAD'].includes(method)){send(200,pairScript,'text/javascript; charset=utf-8');return;}
      const id=store.auth(cookie(req));
      if(path==='/'&&['GET','HEAD'].includes(method)){
        if(id){html(200,page);return;}
        if(method==='HEAD'){html(200,'');return;}
        const pn=store.pairPageNonce(cookie(req,PAIR_COOKIE));
        send(200,pairingPage(pn),'text/html; charset=utf-8',{'Referrer-Policy':'same-origin','Set-Cookie':`${PAIR_COOKIE}=${pn}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`});return;
      }
      if(path==='/api/pair'&&method==='POST'){
        const form=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/x-www-form-urlencoded';
        if(id)denied('ALREADY_PAIRED',409);
        const body=await readBody(req,['application/json','application/x-www-form-urlencoded'],diag);
        if(body&&typeof body==='object'&&!Array.isArray(body)){
          diag.fieldCount=Object.keys(body).length;diag.codeLength=typeof body.code==='string'?body.code.length:null;
        }
        const x=exact(body,['code','nonce']),pn=cookie(req,PAIR_COOKIE);
        if(typeof x.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(x.nonce)||x.nonce!==pn){diag.reason='NONCE_COOKIE_MISMATCH_OR_MISSING';denied('PAIR_NONCE_EXPIRED',403);}
        const paired=store.redeem(x.code,pn);
        if(paired.error){diag.reason=paired.why||paired.error;diag.status=paired.status;
          if(form)html(paired.status,pairingPage(pn,paired.error));else json(paired.status,errBody(paired.error));return;}
        const cookies=[`${COOKIE}=${paired.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${OWNER_S}`,`${PAIR_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`];
        diag.reason=ho===origin?'PAIRED_ORIGIN_CONFIRMED':'PAIRED_NONCE_FALLBACK';diag.status=form?303:200;
        if(form)send(303,'','text/plain; charset=utf-8',{'Location':'/','Set-Cookie':cookies});
        else send(200,JSON.stringify({paired:true}),'application/json; charset=utf-8',{'Set-Cookie':cookies});return;
      }
      if(!id)denied('SESSION_REQUIRED',401);
      if(path==='/api/session'&&method==='GET'){json(200,store.format(store.expect(id)));return;}
      if(path==='/api/cards'&&method==='GET'){json(200,[cards.A,cards.B]);return;}
      const card=/^\/api\/cards\/(A|B)$/.exec(path);
      if(card&&method==='GET'){json(200,cards[card[1]]);return;}
      if(path==='/api/selection'&&method==='POST'){
        const x=exact(await readBody(req),['productId','seq']);selection(x);
        json(200,store.selection(id,x.productId,x.seq));return;
      }
      if(path==='/api/agent/turn'&&method==='POST'){
        const x=exact(await readBody(req),['text','mode','productId','seq']);selection(x);
        if(typeof x.text!=='string'||x.text.length>1000||!x.text.trim()||[...x.text.trim()].length>500||
          ![null,'album','catalog','sales','style'].includes(x.mode))denied('INVALID_BODY',400);
        if((pending.get(id)||0)>=2||inFlight>=4)denied('TURN_LIMIT',429);
        const q=store.reserve(id,x.productId,x.seq,live), rid=randomUUID();
        const turn={productId:x.productId,mode:x.mode,text:x.text.trim()};
        const auditRow=(status,code,r)=>({requestId:rid,utc:requestAt,requestAt,selectionSeq:x.seq,productId:x.productId,
          cardId:r?.toolReceipts?.[0]?.cardId??null,productVersion:r?.toolReceipts?.[0]?.version??null,
          status,code,model:r?.model??null,live:r?.live===true,toolReceipts:r?.toolReceipts??[],modelTurns:r?.modelTurns??0,
          providerHttpAttempts:r?.httpAttempts??0,providerResponseIdSha256:(r?.responseIds??[]).map(sha)});
        const log=(...args)=>store.audit(q,auditRow(...args));
        const original=(ret)=>{const f=cards[x.productId],r=ret.runtime,t=r?.toolReceipts?.[0];return Boolean(r?.live&&
          r.toolReceipts.length===1&&t.name==='read_selected_jewelry_card'&&t.productId===x.productId&&t.cardId===f.cardId&&t.version===f.productVersion);};
        inFlight++;pending.set(id,(pending.get(id)||0)+1);
        try{
          const ret=await agent(turn);
          let cur=store.sameContext(q);
          if(!cur)denied('STALE_SELECTION',409);
          if(q.kind==='qa'&&x.productId==='A'&&original(ret)){
            store.mark(q,'a',auditRow(200,'QA_A_HELD',ret.runtime));
            const until=Date.now()+holdMs;
            while(cur&&!stopping&&!cur.aRelease&&!res.destroyed&&Date.now()<until){await pause(120);cur=store.sameContext(q);}
            if(!cur||stopping||res.destroyed)denied('STALE_SELECTION',409);
            if(!cur.aRelease)denied('QA_HOLD_TIMEOUT',504);
            // This no longer updates selection. Deliver the exact genuine old A response on purpose for APK UI verification.
            log(200,'QA_A_RELEASED_UNCHANGED',ret.runtime);
          }else{
            if(cur.seq!==q.seq||cur.product!==q.product)denied('STALE_SELECTION',409);
            if(q.kind==='qa'&&x.productId==='B'&&original(ret))store.mark(q,'b',auditRow(200,'QA_B_READY',ret.runtime));
            else log(200,'OK',ret.runtime);
          }
          json(200,{...ret,selectionSeq:x.seq,requestId:rid});
        }catch(e){
          const status=e instanceof TurnError||e instanceof Fault?e.status:500,code=status===500?'SERVICE_ERROR':e.code;
          log(status,code,e instanceof TurnError?e.runtime:null);
          const r=e instanceof TurnError&&store.sameContext(q)?.seq===q.seq?{runtime:e.runtime}:{};
          json(status,{...errBody(code,e instanceof TurnError?e.message:undefined),productId:x.productId,selectionSeq:x.seq,requestId:rid,...r});
        }finally{inFlight--;const n=pending.get(id)-1;if(n)pending.set(id,n);else pending.delete(id);}
        return;
      }
      denied('NOT_FOUND',404);
    }catch(e){if(diag){diag.status=e instanceof Fault?e.status:500;if(diag.reason==='SERVICE_ERROR')diag.reason=e instanceof Fault?e.code:'SERVICE_ERROR';}
      if(!res.headersSent&&!res.destroyed)json(e instanceof Fault?e.status:500,errBody(e instanceof Fault?e.code:'SERVICE_ERROR'));}
    finally{if(diag){try{store.diagnostic(diag);}catch{ /* telemetry is never an authorization input */ }}}
  });
  server.requestTimeout=10_000;server.headersTimeout=8_000;server.keepAliveTimeout=3000;
  function close(){if(stopping)return;stopping=true;clearInterval(timer);
    server.close();server.closeIdleConnections();
    // Let in-flight work see stopping before closing SQLite; the original adapter bounds remote time.
    const end=setInterval(()=>{if(inFlight===0){clearInterval(end);if(!stopped){stopped=true;store.close();conn.close();resolveDone();}}},60);
    const force=setTimeout(()=>server.closeAllConnections(),4000);force.unref();}
  let resolveDone;
  const done=new Promise(r=>{resolveDone=r;});
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);origin='http://127.0.0.1:'+server.address().port;resolve();});});
    store.clearQA();
  }catch(e){server.close();store.close();conn.close();throw e;}
  return {server,store,origin,runId,done,close,cards,watchStop(){timer=setInterval(async()=>{
    try{if((await readFile(join(dir,'stop.request'),'utf8')).trim()===runId)close();}catch{}},400);timer.unref();}};
}

async function main(){
  const live=process.argv.slice(2).includes('--live');
  if(process.argv.slice(2).some(a=>a!=='--live'))throw Error('INVALID_ARGUMENT');
  if(live&&!process.env.DEEPSEEK_API_KEY)throw Error('LOCAL_CREDENTIAL_LAUNCH_REQUIRED');
  const dir=privateDir(),app=await startLocal({live,dir});
  try{
    await writeFile(join(dir,'service.json'),JSON.stringify({pid:process.pid,runId:app.runId,origin:app.origin,live,sinceUtc:new Date().toISOString()}),{mode:0o600});
    app.watchStop();process.once('SIGINT',app.close);process.once('SIGTERM',app.close);await app.done;
  }catch(e){app.close();await app.done;throw e;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){main().catch(e=>{
  // Never print generic exception bodies (which might carry user input or environment).
  console.error(e?.code==='EADDRINUSE'?'N14_PORT_17864_IN_USE':e?.message==='LOCAL_CREDENTIAL_LAUNCH_REQUIRED'?'N14_LOCAL_CREDENTIAL_LAUNCH_REQUIRED':'N14_START_FAILED');process.exitCode=2;});}
