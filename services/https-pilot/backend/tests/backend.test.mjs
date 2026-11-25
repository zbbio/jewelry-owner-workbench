import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {approvedOrigin,loadCatalog,validateConfig,sha} from '../config.mjs';
import {start} from '../serve.mjs';
import {openState,PUBLIC_TEST_NO} from '../state.mjs';

const host='n15-isolated.test',origin='https://'+host;
let externalFetch=0;
globalThis.fetch=async()=>{externalFetch++;throw Error('NO_EXTERNAL_FETCH_IN_THIS_SUITE');};
test.after(()=>assert.equal(externalFetch,0));
// POSIX permission assertions require a native private scratch directory, even if the source lives on a WSL Windows mount.
const storage=process.platform==='win32'?fileURLToPath(new URL('../../.local-tests/',import.meta.url)):
  mkdtempSync(join(tmpdir(),'n15-test-data-'));
mkdirSync(storage,{recursive:true});
// Test fixture only; production needs no Python, PATH alias or fixture certificate.
const testPython=process.env.N15_TEST_PYTHON?.trim()||(process.platform==='win32'?'python':'python3');
const output=spawnSync(testPython,['-B',fileURLToPath(new URL('./local-cert.py',import.meta.url))],{encoding:'utf8',shell:false});
assert.equal(output.status,0,'LOCAL_TEST_CERT_GENERATION_FAILED: install Python 3 + cryptography for the test interpreter, or set N15_TEST_PYTHON to its executable');
const tls=JSON.parse(output.stdout);
const aliasFixtures=()=>[{alias:'A',productId:randomUUID(),productVersion:2,priceYuan:'10.00',size:null},
  {alias:'B',productId:randomUUID(),productVersion:1,priceYuan:null,size:null}];
function fixture(policy='disabled'){
  const dir=mkdtempSync(join(storage,'state-')),sock=process.platform==='win32'?'\\\\.\\pipe\\n15-test-'+randomUUID():join(mkdtempSync(join(tmpdir(),'n15sock-')),'s');
  const cards=aliasFixtures(),snapshotFile=join(dir,'fixture.json'),stateDir=join(dir,'private-state'),modelSecretFile=join(dir,'fixture-model'),storeRef='fixture-store';
  const bytes=Buffer.from(JSON.stringify({schema:1,storeRef,cards}));writeFileSync(snapshotFile,bytes,{mode:0o600});
  return {cards,cfg:validateConfig({schema:1,publicOrigin:origin,storeRef,snapshotFile,snapshotSha256:sha(bytes),stateDir,socketPath:sock,
    modelId:'deepseek-flash',modelPolicy:policy,modelSecretFile},{test:true})};
}
async function proxy(cfg){
  // Makes a real, certificate-validated local HTTPS hop; forwards to the kernel-private app socket.
  const p=https.createServer(tls,(q,s)=>{
    const r=http.request({socketPath:cfg.socketPath,path:q.url,method:q.method,headers:q.headers},ret=>{
      s.writeHead(ret.statusCode,ret.headers);ret.pipe(s);});r.on('error',()=>{s.writeHead(502);s.end();});q.pipe(r);
  });
  await new Promise(ok=>p.listen(0,'127.0.0.1',ok));
  const port=p.address().port;
  const call=(path,{data,cookie,originOverride,omitOrigin=false,headers={}}={})=>new Promise((ok,no)=>{
    const body=data===undefined?undefined:JSON.stringify(data),r=https.request({hostname:'127.0.0.1',port,servername:host,ca:tls.cert,
      path,method:body===undefined?'GET':'POST',headers:{Host:host,...(cookie?{Cookie:cookie}:{}),...
        (body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body),...(omitOrigin?{}:{Origin:originOverride??origin})}),...headers}},res=>{
        const data=[];res.on('data',b=>data.push(b));res.on('end',()=>{const text=Buffer.concat(data).toString('utf8');
          ok({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)});});});
    r.setTimeout(6000,()=>r.destroy(Error('TEST_HTTPS_TIMEOUT')));r.on('error',no);r.end(body);
  });
  return {call,close:()=>new Promise(ok=>{p.close(ok);p.closeAllConnections();})};
}
function admin(cfg,fn){const s=openState(cfg);try{return fn(s);}finally{s.close();}}
const done=async a=>{a.close();await a.done;};
async function page(h){const r=await h.call('/');assert.equal(r.status,200);const nonce=/name="nonce" value="([\w-]{43})"/.exec(r.text)?.[1];
  assert.ok(nonce);const pairCookie=r.headers['set-cookie'][0].split(';')[0];return {nonce,pairCookie};}
async function pair(h,cfg){const p=await page(h),code=admin(cfg,s=>s.issue().code);
  const d=await h.call('/api/pair',{data:{code,nonce:p.nonce},cookie:p.pairCookie});assert.equal(d.status,200);assert.deepEqual(d.json(),{paired:true});
  const owner=d.headers['set-cookie'][0];assert.match(owner,/^__Host-n15session=/);assert.match(owner,/Secure; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(owner,/Domain=/i);return owner.split(';')[0];}

test('配置拒绝 HTTP、IP、保留域名、路径；快照拒绝额外媒体字段/错误 SHA 或店铺',()=>{
  for(const x of ['http://u.company.net','https://127.0.0.1','https://x.example.com','https://x.invalid','https://u.company.net/x','https://u.company.net:444'])
    assert.throws(()=>approvedOrigin(x),{code:'APPROVED_HTTPS_ORIGIN_REQUIRED'});
  const {cfg,cards}=fixture();assert.throws(()=>loadCatalog({...cfg,storeRef:'other-store'}),{code:'SNAPSHOT_SCOPE'});
  assert.throws(()=>loadCatalog({...cfg,snapshotSha256:'0'.repeat(64)}),{code:'SNAPSHOT_DIGEST_MISMATCH'});
  const w=Buffer.from(JSON.stringify({schema:1,storeRef:cfg.storeRef,cards:[{...cards[0],image:'forbidden'},cards[1]]}));
  writeFileSync(cfg.snapshotFile,w);assert.throws(()=>loadCatalog({...cfg,snapshotSha256:sha(w)}),{code:'SNAPSHOT_CARD_FIELDS'});
});

test('真实本地TLS＋私有socket：转发头无授权、Host/Origin封闭、未配对401',async t=>{
  const {cfg}=fixture(),app=await start(cfg),p=await proxy(cfg);t.after(async()=>{await p.close();await done(app);});
  assert.equal(typeof app.server.address(),'string');
  assert.equal((await p.call('/healthz')).status,200);
  assert.equal((await p.call('/readyz')).json().model,false);
  const poison={'x-forwarded-host':host,'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1',Forwarded:'proto=https;host='+host};
  assert.equal((await p.call('/api/cards',{headers:poison})).status,401);
  assert.equal((await p.call('/healthz',{headers:{...poison,Host:'attacker.invalid'}})).status,403);
  assert.equal((await p.call('/api/pair',{data:{},originOverride:'null',headers:poison})).status,403);
  assert.equal((await p.call('/api/pair',{data:{},originOverride:'https://attacker.invalid',headers:poison})).status,403);
  assert.equal((await p.call('/api/pair',{data:{},omitOrigin:true,headers:poison})).status,403);
});

test('HTTPS配对仅一次，持久Cookie随服务重开，退出QA恢复owner, 撤销拒绝',async()=>{
  const {cfg,cards}=fixture();let app=await start(cfg),p=await proxy(cfg);let k;
  try{
    k=await pair(p,cfg);
    const facts=(await p.call('/api/cards',{cookie:k})).json();
    assert.deepEqual(facts.map(x=>[x.cardId,x.productVersion,x.priceYuan]),cards.map(x=>[x.productId,x.productVersion,x.priceYuan]));
    assert.equal((await p.call('/api/cards/A?shopId=other',{cookie:k})).status,400);
    assert.equal((await p.call('/api/selection',{data:{productId:'A',seq:1,shopId:'forged'},cookie:k})).status,400);
    assert.throws(()=>admin(cfg,s=>s.issue()),{code:'OWNER_ALREADY_BOUND'});
    assert.equal((await p.call('/api/selection',{data:{productId:'B',seq:1},cookie:k})).status,200);
    const selected=(await p.call('/api/session',{cookie:k})).json(),id=admin(cfg,s=>s.list()[0].installationId);
    const q=admin(cfg,s=>s.qaStart(id));assert.equal((await p.call('/api/session',{cookie:k})).json().sessionKind,'qa');
    assert.equal((await p.call('/api/selection',{data:{productId:'A',seq:2},cookie:k})).status,409);
    admin(cfg,s=>s.qaEnd(q.qaRunId));assert.deepEqual((await p.call('/api/session',{cookie:k})).json(),selected);
    await p.close();await done(app);app=await start(cfg);p=await proxy(cfg);
    assert.deepEqual((await p.call('/api/session',{cookie:k})).json(),selected);
    admin(cfg,s=>s.revoke(id));assert.equal((await p.call('/api/cards/A',{cookie:k})).status,401);
  }finally{await p.close();await done(app);}
});

test('无卡走真实SDK入口本地澄清0实呼；缺凭据选中闭合、不串旧选择',async t=>{
  const {cfg}=fixture(),app=await start(cfg),p=await proxy(cfg);t.after(async()=>{await p.close();await done(app);});
  const k=await pair(p,cfg),x=await p.call('/api/agent/turn',{cookie:k,data:{text:'这件多少钱？',mode:'sales',productId:null,seq:0}});
  assert.equal(x.status,200);assert.match(x.json().text,/请先选择/);assert.equal(x.json().runtime.httpAttempts,0);assert.deepEqual(x.json().evidence,[]);
  await p.call('/api/selection',{cookie:k,data:{productId:'A',seq:1}});
  assert.equal((await p.call('/api/agent/turn',{cookie:k,data:{text:'问价',mode:'sales',productId:'A',seq:1}})).json().error.code,'MODEL_NOT_READY');
  assert.equal((await p.call('/api/agent/turn',{cookie:k,data:{text:'旧请求',mode:'sales',productId:'B',seq:1}})).status,409);
  assert.equal(admin(cfg,s=>s.auditList()[0].providerAttempts),0);
});

test('就绪随测试文件轮换：缺失/坏密钥503，合法格式准备无外呼；快照变更闭合',async t=>{
  const {cfg}=fixture('enabled'),app=await start(cfg),p=await proxy(cfg);t.after(async()=>{await p.close();await done(app);});
  const k=await pair(p,cfg);
  assert.equal((await p.call('/readyz')).status,503);
  // Random local format-only fixture; never passed to an upstream call.
  const staging=cfg.modelSecretFile+'.next';writeFileSync(staging,'sk-'+randomBytes(24).toString('hex'),{mode:0o600});renameSync(staging,cfg.modelSecretFile);
  assert.equal((await p.call('/readyz')).json().model,true);
  writeFileSync(staging,'broken',{mode:0o600});renameSync(staging,cfg.modelSecretFile);
  assert.equal((await p.call('/readyz')).status,503);
  writeFileSync(cfg.snapshotFile,'{}');assert.equal((await p.call('/api/cards',{cookie:k})).status,503);
  assert.deepEqual((await p.call('/readyz')).json(),{ready:false,source:false,model:false,modelPolicy:'enabled'});
});

test('隔离配对失败窗和过期：nonce/码不作为报告，来源严格不放宽',()=>{
  const {cfg}=fixture();let time=Date.now();const s=openState(cfg,()=>time);
  try{
    const p=s.pageNonce(),c=s.issue();time+=180_001;
    assert.equal(s.redeem(c.code,p).status,401);
    for(let i=0;i<7;i++)assert.equal(s.redeem('wrong',p).status,401);
    assert.equal(s.redeem(s.issue().code,p).status,429);
    time+=300_001;const a=s.issue();assert.ok(s.redeem(a.code,p).token);assert.equal(s.redeem(a.code,p).status,403);
  }finally{s.close();}
});

test('缺 Origin 仅同源证据和双提交匹配才配对，既有会话不能跨新origin或店搬用',async t=>{
  const {cfg}=fixture(),app=await start(cfg),h=await proxy(cfg);t.after(async()=>{await h.close();await done(app);});
  const n=await page(h),second=await page(h),code=admin(cfg,s=>s.issue().code),data={code,nonce:n.nonce};
  assert.equal((await h.call('/api/pair',{data,cookie:second.pairCookie,omitOrigin:true,headers:{Referer:origin+'/'}})).status,403);
  const p=await h.call('/api/pair',{data,cookie:n.pairCookie,omitOrigin:true,headers:{'Sec-Fetch-Site':'same-origin'}});
  assert.equal(p.status,200);
  assert.throws(()=>openState({...cfg,storeRef:'other-store'}),{code:'STATE_SCOPE_MISMATCH'});
  assert.throws(()=>openState({...cfg,origin:'https://different.test'}),{code:'STATE_SCOPE_MISMATCH'});
});

test('限额只测状态预占，不发模型：owner/QA分离，owner 12 次每小时、QA每卡一次',()=>{
  const {cfg}=fixture();const s=openState(cfg);
  try{
    const n=s.pageNonce(),code=s.issue().code,c=s.auth(s.redeem(code,n).token);
    s.select(c,'A',1);
    for(let i=0;i<12;i++)assert.equal(s.reserve(c,'A',1,true).kind,'owner');
    assert.throws(()=>s.reserve(c,'A',1,true),{code:'TURN_LIMIT'});
    const q=s.qaStart(c),seq=s.expect(c).seq;s.select(c,'A',seq+1);
    const event={requestId:randomUUID(),requestAt:new Date().toISOString(),productVersion:2};
    const hold=s.reserve(c,'A',seq+1,true,event);assert.equal(hold.kind,'qa');assert.throws(()=>s.reserve(c,'A',seq+1,true),{code:'QA_ORDER_OR_LIMIT'});
    s.qaMark(hold,{...event,code:'QA_A_HELD',publicTestNo:q.publicTestNo});
    s.select(c,'B',seq+2);assert.equal(s.reserve(c,'B',seq+2,true).kind,'qa');
    assert.throws(()=>s.reserve(c,'B',seq+2,true),{code:'TURN_LIMIT'});
    s.qaEnd(q.qaRunId);assert.deepEqual(s.publicScope(s.expect(c)),{productId:'A',seq:1,sessionKind:'owner'});
    assert.throws(()=>s.reserve(c,'A',1,true),{code:'TURN_LIMIT'});
  }finally{s.close();}
});

function mockQaModel(log){return async({productId},cat)=>{
  log.push(productId);const card=cat.read(productId);
  // Generated local application receipt, not a model stand-in or provider call.
  return {text:'QA_LOCAL_FIXTURE_'+productId,productId,evidence:[],runtime:{live:true,httpAttempts:0,toolReceipts:[
    {name:'read_selected_jewelry_card',productId,cardId:card.cardId,version:card.version}]}};
};}
function makeFormatOnlyFile(cfg){writeFileSync(cfg.modelSecretFile,'sk-'+randomBytes(24).toString('hex'),{mode:0o600});}
async function auditWait(cfg,pn,code){
  for(let i=0;i<44;i++){const e=admin(cfg,s=>s.auditList()).find(x=>x.publicTestNo===pn&&x.code===code);if(e)return e;await wait(50);}
  assert.fail('QA_EVENT_DID_NOT_ARRIVE');
}

test('N15-QA-LINK 本地合成HTTPS流：预登记、A扣、B先到、仅私有释放、无卡0调用、不重放',async t=>{
  const {cfg}=fixture('enabled');makeFormatOnlyFile(cfg);const modelCalls=[];
  const app=await start(cfg,{testTurn:mockQaModel(modelCalls),holdMs:5000}),h=await proxy(cfg);
  t.after(async()=>{await h.close();await done(app);});
  const cookie=await pair(h,cfg),id=admin(cfg,s=>s.list()[0].installationId);
  await h.call('/api/selection',{cookie,data:{productId:'B',seq:1}});
  const owner=(await h.call('/api/session',{cookie})).json(),q=admin(cfg,s=>s.qaStart(id));
  assert.match(q.publicTestNo,PUBLIC_TEST_NO);assert.match(q.publicTestNo,/^N15-[A-F0-9]{12}$/);
  const reg=await auditWait(cfg,q.publicTestNo,'QA_REGISTERED'),seq=(await h.call('/api/session',{cookie})).json().seq;
  const ask=(productId,seq)=>h.call('/api/agent/turn',{cookie,data:{text:'本机合成测试',mode:'sales',productId,seq}});
  const pick=(productId,seq)=>h.call('/api/selection',{cookie,data:{productId,seq}});
  assert.throws(()=>admin(cfg,s=>s.qaRelease(q.qaRunId,false)),{code:'QA_RELEASE_REQUIRES_B_VISUAL_CONFIRMATION'});
  await pick('A',seq+1);let completed=false;const aP=ask('A',seq+1).then(r=>(completed=true,r));
  const held=await auditWait(cfg,q.publicTestNo,'QA_A_HELD');assert.equal(completed,false);
  assert.equal((await ask('A',seq+1)).status,429);assert.equal(modelCalls.length,1);
  assert.throws(()=>admin(cfg,s=>s.qaRelease(q.qaRunId,true)),{code:'QA_B_NOT_READY'});
  assert.equal((await h.call('/api/qa/release',{cookie,data:{}})).status,404);
  await pick('B',seq+2);const b=await ask('B',seq+2);assert.equal(b.status,200);assert.equal(completed,false);
  const bReady=await auditWait(cfg,q.publicTestNo,'QA_B_READY');assert.equal(b.json().requestId,bReady.requestId);
  const ack=admin(cfg,s=>s.qaRelease(q.qaRunId,true)),a=await aP;assert.equal(a.status,200);
  const released=await auditWait(cfg,q.publicTestNo,'QA_A_RELEASED');
  assert.equal(held.requestId,ack.requestId);assert.equal(held.requestId,released.requestId);assert.equal(a.json().requestId,held.requestId);
  assert.equal(held.requestAt,released.requestAt);assert.equal(held.productVersion,released.productVersion);
  assert.equal(b.json().publicTestNo,q.publicTestNo);assert.equal(a.json().publicTestNo,q.publicTestNo);
  assert.equal((await h.call('/api/session',{cookie})).json().productId,'B');
  assert.throws(()=>admin(cfg,s=>s.qaRelease(q.qaRunId,true)),{code:'QA_ALREADY_RELEASED'});
  await pick(null,seq+3);const none=await ask(null,seq+3);
  assert.equal(none.status,200);assert.equal(none.json().runtime.httpAttempts,0);assert.deepEqual(none.json().runtime.toolReceipts,[]);
  const nullAudit=await auditWait(cfg,q.publicTestNo,'NO_CARD_LOCAL');assert.equal(none.json().requestId,nullAudit.requestId);
  assert.equal(nullAudit.providerAttempts,0);assert.equal(nullAudit.toolReads,0);
  assert.ok(admin(cfg,s=>s.auditList()).filter(x=>x.publicTestNo===q.publicTestNo&&x.code==='REQUEST_ADMITTED').length===3);
  const chain=[reg,held,bReady,ack,released,nullAudit];
  assert.ok(chain.slice(1).every((r,i)=>r.eventSeq>chain[i].eventSeq&&Date.parse(r.eventAt)>=Date.parse(chain[i].eventAt)));
  assert.throws(()=>admin(cfg,s=>s.qaRelease(q.qaRunId,true)),{code:'QA_B_NOT_READY'}); // already cleared card, no repeat release
  admin(cfg,s=>s.qaEnd(q.qaRunId));assert.deepEqual((await h.call('/api/session',{cookie})).json(),owner);
  assert.throws(()=>admin(cfg,s=>s.qaStart(id)),{code:'QA_OWNER_UNAVAILABLE_OR_SPENT'});
  assert.deepEqual(modelCalls,['A','B']);
  const ownerReply=await ask('B',1);assert.equal(ownerReply.status,200);assert.equal(ownerReply.json().publicTestNo,undefined);
  assert.deepEqual(modelCalls,['A','B','B']); // ordinary owner does not hold; this is a local fixture call only
});

test('N15-QA-LINK 回答错误自动复位，旧测试拒重开且不泄漏异常正文（合成）',async t=>{
  const {cfg}=fixture('enabled');makeFormatOnlyFile(cfg);let calls=0;
  const app=await start(cfg,{testTurn:async()=>{calls++;throw Error('LOCAL_PRIVATE_ERROR_MARKER');}}),h=await proxy(cfg);
  t.after(async()=>{await h.close();await done(app);});
  const cookie=await pair(h,cfg),id=admin(cfg,s=>s.list()[0].installationId),owner=(await h.call('/api/session',{cookie})).json();
  const q=admin(cfg,s=>s.qaStart(id)),seq=(await h.call('/api/session',{cookie})).json().seq;
  await h.call('/api/selection',{cookie,data:{productId:'A',seq:seq+1}});
  const a=await h.call('/api/agent/turn',{cookie,data:{text:'本机合成错误',mode:'sales',productId:'A',seq:seq+1}});
  assert.equal(a.status,500);assert.doesNotMatch(a.text,/LOCAL_PRIVATE_ERROR_MARKER/);
  assert.equal(calls,1);assert.deepEqual((await h.call('/api/session',{cookie})).json(),owner);
  assert.equal((await auditWait(cfg,q.publicTestNo,'QA_ABORTED_NO_REPEAT')).code,'QA_ABORTED_NO_REPEAT');
  assert.throws(()=>admin(cfg,s=>s.qaStart(id)),{code:'QA_OWNER_UNAVAILABLE_OR_SPENT'});
});

test('N15-QA-LINK 超时不吐A、不重试，自动恢复原owner（合成）',async t=>{
  const {cfg}=fixture('enabled');makeFormatOnlyFile(cfg);const attempts=[];
  const app=await start(cfg,{testTurn:mockQaModel(attempts),holdMs:75}),h=await proxy(cfg);t.after(async()=>{await h.close();await done(app);});
  const cookie=await pair(h,cfg),id=admin(cfg,s=>s.list()[0].installationId),owner=(await h.call('/api/session',{cookie})).json();
  const q=admin(cfg,s=>s.qaStart(id)),seq=(await h.call('/api/session',{cookie})).json().seq;
  await h.call('/api/selection',{cookie,data:{productId:'A',seq:seq+1}});
  const a=await h.call('/api/agent/turn',{cookie,data:{text:'本机合成超时',mode:'sales',productId:'A',seq:seq+1}});
  assert.equal(a.status,504);assert.equal(a.json().error.code,'QA_HOLD_TIMEOUT');assert.doesNotMatch(a.text,/QA_LOCAL_FIXTURE/);
  assert.deepEqual(attempts,['A']);assert.deepEqual((await h.call('/api/session',{cookie})).json(),owner);
  assert.equal((await auditWait(cfg,q.publicTestNo,'QA_ABORTED_NO_REPEAT')).code,'QA_ABORTED_NO_REPEAT');
});

test('N15-PUBLICNO 冻结4–12位大写字母数字；发生冲突只重取公开编号（含已结束历史）',()=>{
  for(const a of ['N15-01ZZ','N15-AB9012347890'])assert.match(a,PUBLIC_TEST_NO);
  for(const a of ['N15-123','N15-AB90123478901','N15-AB901234789012','N15-ab01','N15-AB_C','N15-AAAA\n'])assert.doesNotMatch(a,PUBLIC_TEST_NO);
  const {cfg}=fixture();let pulls=0;
  const s=openState(cfg,Date.now,{publicBytes:()=>Buffer.alloc(6,++pulls<=2?0xAB:0xCD)});
  try{
    const secret=s.redeem(s.issue().code,s.pageNonce()).token,id=s.auth(secret);
    const a=s.qaStart(id);assert.equal(a.publicTestNo,'N15-ABABABABABAB');s.qaEnd(a.qaRunId);
    const b=s.qaStart(id);assert.equal(b.publicTestNo,'N15-CDCDCDCDCDCD');assert.equal(pulls,3);
    assert.notEqual(b.qaRunId,a.qaRunId);assert.equal(s.auth(secret),id);assert.equal(s.list().length,1);
    assert.deepEqual(s.auditList().filter(x=>x.code==='QA_REGISTERED').map(x=>x.publicTestNo),[a.publicTestNo,b.publicTestNo]);
  }finally{s.close();}
});

test('N15-PUBLICNO 并发独立 SQLite 连接只有一个登记结果，不产生重复或新的 owner',async()=>{
  const {cfg}=fixture(),ownerId=admin(cfg,s=>s.auth(s.redeem(s.issue().code,s.pageNonce()).token));
  const workers=[0,1].map(()=>new Worker(new URL('./publicno-worker.mjs',import.meta.url),{workerData:{cfg,ownerId}}));
  try{
    const once=w=>new Promise((ok,no)=>{w.once('message',ok);w.once('error',no);});
    assert.deepEqual(await Promise.all(workers.map(once)),[{ready:true},{ready:true}]);
    const results=Promise.all(workers.map(once));workers.forEach(w=>w.postMessage('go'));
    const out=await results,win=out.filter(x=>x.ok),los=out.filter(x=>!x.ok);
    assert.equal(win.length,1);assert.match(win[0].publicTestNo,PUBLIC_TEST_NO);assert.deepEqual(los,[{ok:false,code:'QA_ACTIVE'}]);
    assert.equal(admin(cfg,s=>s.list().length),1);
    assert.equal(admin(cfg,s=>s.auditList().filter(x=>x.code==='QA_REGISTERED').length),1);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
});
