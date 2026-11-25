import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash,randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {verifyG2ApprovalSignature} from './g2-service.mjs';

const own=fileURLToPath(new URL('./',import.meta.url));
const py=process.env.N22_TEST_PYTHON??(process.platform==='win32'?'python':'python3');
const json=f=>JSON.parse(readFileSync(f,'utf8'));
const tag='N22_G2_PRIVATE';
const sha=s=>createHash('sha256').update(s).digest('hex');
const aText='查 A 多少钱，把它以前的视频找出来，不要新做。';
const bText='查 B 多少钱，找以前的视频';
const turn=(text)=>({requestId:randomUUID(),messageId:randomUUID(),text});
const quote=r=>r.body.actions.find(x=>x.action==='quote');
const clip=r=>r.body.actions.find(x=>x.action==='old_video');
const disabled=r=>assert.equal(quote(r).code,'PROVIDER_NOT_RELEASED',JSON.stringify(r.body));
const until=async(fn,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch{}await delay(35);}throw Error('fixture_timeout');};
async function listen(handler){
  const s=createServer(handler);await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});
  return {port:s.address().port,async close(){s.closeAllConnections();await new Promise(r=>s.close(r));}};
}
function reply(res,n,x){res.writeHead(n,{'content-type':'application/json'});res.end(JSON.stringify(x));}
const env=()=>Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','PATHEXT','TEMP','TMP'].filter(n=>process.env[n]).map(n=>[n,process.env[n]]));

test('signer validator rejects modified release and wrong operator key (ephemeral synthetic key pair)',()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'), pem=publicKey.export({type:'spki',format:'pem'});
  const approval={documentSha256:'0'.repeat(64),release:{expiresAtMs:100},budgetIdentity:'1:2',pins:[]};
  function c(x){return x&&typeof x==='object'?(Array.isArray(x)?x.map(c):Object.fromEntries(Object.keys(x).sort().map(k=>[k,c(x[k])]))):x;}
  const signature=sign(null,Buffer.from(JSON.stringify(c(approval))),privateKey).toString('base64');
  assert.equal(verifyG2ApprovalSignature(approval,signature,pem),true);
  assert.equal(verifyG2ApprovalSignature({...approval,release:{expiresAtMs:101}},signature,pem),false);
  const wrong=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  assert.equal(verifyG2ApprovalSignature(approval,signature,wrong),false);
});

for(const scenario of ['bounded_pair','missing_getter'])test('actual paired N22 entry: '+scenario, {timeout:170000},async()=>{
  const f=mkdtempSync(join(own,'仅本机只读','test-g2-'));
  const cfgFile=join(f,'runtime.json'),entry=join(f,'run','backend','local-n22.mjs');
  const temp=await listen((q,r)=>r.end());const port=temp.port;await temp.close();assert.ok(port>=30000);
  const origin='http://127.0.0.1:'+port;
  const proof={ticket:'N22-G2PREP/商品仓',scenario,scope:'two authored synthetic cards and local FFmpeg fixture; true Agents SDK, outbound substitute is loopback only',
    realProviderRequests:0,physicalDevice:false,starts:[],stops:[],events:[],httpSubstitute:[],getterCount:0,checkpoints:{},startedUtc:new Date().toISOString()};
  let forbiddenFixtureIDs=[];
  const provider=await listen(async(req,res)=>{
    try{
      assert.equal(req.url,'/fake-deepseek');assert.equal(req.method,'POST');
      assert.equal(req.headers.authorization,'Bearer '+['synthetic','g2','local'].join('-'));
      let s='';for await (const b of req)s+=b;const q=JSON.parse(s);
      assert.equal(q.model,'deepseek-flash');
      assert.ok(!/n22-g2-fixture|https?:\/\//iu.test(s));
      assert.ok(forbiddenFixtureIDs.length===2&&forbiddenFixtureIDs.every(x=>!s.includes(x)));
      const containsTool=q.messages.some(x=>x.role==='tool');
      const n=proof.httpSubstitute.length+1;
      proof.httpSubstitute.push({n,containsTool,noRawScope:true});
      const message=containsTool?{role:'assistant',content:'{"kind":"facts","fields":["price"]}'}:
        {role:'assistant',content:null,tool_calls:[{id:'local-tool-'+n,type:'function',function:{name:'read_selected_jewelry_card',arguments:'{}'}}]};
      reply(res,200,{id:'local-synthetic-'+n,object:'chat.completion',model:'deepseek-flash',created:1700000000,
        choices:[{index:0,message,finish_reason:containsTool?'stop':'tool_calls'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
    }catch(e){proof.substituteFault=e?.code??e?.name;reply(res,500,{error:{message:'test contract mismatch'}});}
  });
  let active;
  async function call(p,{cookie,body,range,foreignOrigin}={}){
    const r=await fetch(origin+p,{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),
      ...(body?{Origin:foreignOrigin??origin,'Content-Type':'application/json'}:{}),...(range?{Range:range}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(55000)});
    return {status:r.status,headers:r.headers,body:r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer())};
  }
  const readCounters=state=>{
    const db=new DatabaseSync(join(state,'n22-g2-fixture-once.sqlite'),{readOnly:true});
    try{return {...db.prepare('SELECT count(*) AS rows,sum(a_claim) AS aClaim,sum(b_claim) AS bClaim,sum(a_http) AS aHttp,sum(b_http) AS bHttp FROM n22_g2_budget').get()};}
    finally{db.close();}
  };
  async function boot(cfg,mode,preload){
    const child=fork(entry,[],{cwd:f,env:{...env(),N17_CONFIG:cfgFile},
      execArgv:preload?['--import',pathToFileURL(preload).href]:[],silent:true});
    let stderr='';
    child.stdout.resume();child.stderr.on('data',b=>stderr+=b);
    const gone=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
    child.on('message',x=>{if(x.testMarker==='getter')proof.getterCount++;
      if(x.testMarker==='event')proof.events.push(x.event);});
    active={child,gone,mode};
    const stop=async()=>{
      if(child.connected)child.send('N17_STOP');
      const x=await gone;proof.stops.push({mode,...x});active=null;
      assert.deepEqual(x,{code:0,signal:null},stderr);
    };
    try{
      const h=await until(async()=>{if(child.exitCode!==null)return {dead:true};const got=await call('/healthz');
        const m=json(join(cfg.stateDir,'instance.json'));
        return got.status===200&&got.body.runId===m.runId&&m.pid===child.pid?got.body:null;});
      if(h.dead)throw Error('BOOT_EXIT: '+stderr);
      assert.equal((await call('/readyz')).body.ready,true);
      proof.starts.push({mode,runId:h.runId,pid:child.pid,model:h.model});
      return stop;
    }catch(e){if(child.connected)child.send('N17_STOP');await gone;active=null;throw e;}
  }
  function operator(op,params={}){
    const {child}=active,id=randomUUID();
    return new Promise((ok,no)=>{
      const timer=setTimeout(()=>{child.off('message',f);no(Error('PRIVATE_ACK_TIMEOUT'));},4000);
      function f(m){if(m.type===tag&&m.id===id){clearTimeout(timer);child.off('message',f);ok(m);}}
      child.on('message',f);child.send({type:tag,id,op,params});
    });
  }
  const imports=(cfg,mode,release)=>{
    const target=join(f,'operator-'+mode+'.mjs');
    const lib=pathToFileURL(join(f,'run','backend','g2-service.mjs')).href;
    const options={release,substituteOrigin:'http://127.0.0.1:'+provider.port};
    writeFileSync(target,"import {fixtureG2Host,registerN22G2} from "+JSON.stringify(lib)+";\n"+
      "const plan="+JSON.stringify(options)+";\n"+
      "registerN22G2(fixtureG2Host({...plan,getApiKey(){process.send({testMarker:'getter'});return "+
      (scenario==='missing_getter'?"null":"['synthetic','g2','local'].join('-')")+
      ";},record(event){process.send({testMarker:'event',event})}}));\n",{flag:'wx'});
    return target;
  };
  try{
    const prep=spawnSync(py,['-B',join(own,'准备启动.py'),'--test-state',f,'--g2-test-port',String(port)],{encoding:'utf8',timeout:45000});
    assert.equal(prep.status,0,prep.stderr);
    const cfg=json(cfgFile);assert.equal(cfg.modelPolicy,'disabled');assert.equal(cfg.n22G2Fixture,true);
    proof.sourceSHA={wire:sha(readFileSync(join(f,'run','backend','wire.mjs'))),server:sha(readFileSync(entry)),
      g2:sha(readFileSync(join(f,'run','backend','g2-service.mjs'))),sales:cfg.n22Adapters.sales.sha256,
      album:cfg.n22Adapters.album.sha256,content:cfg.n22Adapters.content.sha256,ui:cfg.uiFileDigests['n22-app.js']};
    const contacts=json(cfg.snapshotFile).cards;
    forbiddenFixtureIDs=contacts.map(c=>c.productId);
    const send=(body,cookie)=>call('/api/n22/turn',{body,cookie});
    let stop=await boot(cfg,'no_private_boot');
    const page=await call('/'), nonce=/name="nonce" value="([\w-]{43})"/u.exec(page.body.toString())[1];
    const {openState}=await import(pathToFileURL(join(f,'run','backend','state.mjs')).href);
    const pstate=openState(cfg);let code;try{code=pstate.issue().code;}finally{pstate.close();}
    const paired=await call('/api/pair',{cookie:page.headers.getSetCookie()[0].split(';')[0],body:{nonce,code}});
    assert.equal(paired.status,200);
    const cookie=paired.headers.getSetCookie()[0].split(';')[0];
    const auth=openState(cfg);let sid;try{const bindings=auth.list();assert.equal(bindings.length,1);sid=bindings[0].installationId;}finally{auth.close();}
    assert.equal((await call('/api/n22/capabilities',{cookie})).body.model,'disabled');
    const normal=await send(turn(aText),cookie);disabled(normal);assert.equal(clip(normal).status,'existing_available');
    const readClip=await call(clip(normal).pinnedPlayUrl,{cookie,range:'bytes=0-23'});assert.equal(readClip.status,206);
    assert.equal((await send(turn(bText))).status,401);
    proof.checkpoints.default={status:normal.body.status,quote:quote(normal).code,clip:clip(normal).status,range:readClip.status,outbound:0};
    await stop();
    const release={releaseId:'local-fixture-'+randomUUID(),notBeforeMs:Date.now()-1000,expiresAtMs:Date.now()+360000,
      scope:{shopId:cfg.storeRef,actorId:'n22-local-owner',sessionId:sid}};
    for(const [tag1,text] of [['a',aText],['b',bText]]){
      const row=contacts.find(c=>c.alias===tag1.toUpperCase());
      release[tag1]={productId:row.productId,productVersion:row.productVersion,requestId:null,messageId:null,inputTextSha256:sha(text.trim())};
    }
    const wrong=structuredClone(release);wrong.scope.sessionId='fixture-other-installation';
    stop=await boot(cfg,'wrong_installation',imports(cfg,'wrong',wrong));
    disabled(await send(turn(aText),cookie));
    assert.equal(existsSync(join(cfg.stateDir,'n22-g2-fixture-once.sqlite')),false);
    assert.equal(proof.getterCount,0);
    await stop();

    const expired=structuredClone(release);expired.notBeforeMs=Date.now()-60000;expired.expiresAtMs=Date.now()-1;
    stop=await boot(cfg,'expired_approval',imports(cfg,'expired',expired));
    const expiredReply=await send(turn(aText),cookie);disabled(expiredReply);assert.equal(clip(expiredReply).status,'existing_available');
    assert.equal(existsSync(join(cfg.stateDir,'n22-g2-fixture-once.sqlite')),false);
    assert.equal(proof.getterCount,0);
    proof.checkpoints.expired={quote:quote(expiredReply).code,clip:clip(expiredReply).status,getterCalls:0,http:0};
    await stop();

    const preload=imports(cfg,'active',release);
    stop=await boot(cfg,'fixture_authorized_only',preload);
    assert.equal((await call('/api/n22/capabilities',{cookie})).body.model,'fixture_armed');
    assert.equal(proof.getterCount,0);
    const noCard=await send(turn('多少钱'),cookie);
    assert.equal(noCard.body.status,'needs_clarification',JSON.stringify(noCard.body));
    const early=await send(turn(bText),cookie);disabled(early);
    const changed=await send(turn('A 多少钱'),cookie);disabled(changed);
    for(const k of ['providerURL','key','allow','budget'])
      assert.equal((await send({...turn(aText),[k]:'fixture-invalid'},cookie)).status,400);
    assert.equal((await call('/api/n22/g2/release',{cookie,body:{}})).status,404);
    assert.equal((await call('/api/n22/turn',{cookie,body:turn(aText),foreignOrigin:'http://127.0.0.1:1'})).status,403);
    assert.equal(proof.httpSubstitute.length,0);assert.equal(proof.getterCount,0);
    proof.checkpoints.before={noCard:noCard.body.status,earlyB:quote(early).code,changedSentence:quote(changed).code,frontendOverrides:400,
      crossOrigin:403,publicControl:404,readGetter:0,http:0};

    if(scenario==='missing_getter'){
      const request=turn(aText),r=await send(request,cookie);
      assert.equal(r.body.status,'partial');assert.equal(quote(r).code,'MODEL_NOT_CONFIGURED',JSON.stringify(r.body));
      assert.equal(clip(r).status,'existing_available');assert.equal((await call(clip(r).pinnedPlayUrl,{cookie,range:'bytes=0-23'})).status,206);
      assert.equal((await send(request,cookie)).body.replay,true);
      assert.equal(proof.getterCount,1);assert.equal(proof.httpSubstitute.length,0);
      const counters=readCounters(cfg.stateDir);assert.deepEqual(counters,{rows:1,aClaim:1,bClaim:0,aHttp:0,bHttp:0});
      proof.checkpoints.missing={quote:quote(r).code,clip:clip(r).status,range:206,counters,readGetter:1,http:0};
      await stop();proof.result='passed';return;
    }

    const A=turn(aText),B=turn(bText);
    let passed=false;
    const held=send(A,cookie).then(x=>{passed=true;return x;});
    const dup=send(A,cookie);
    void held.catch(()=>{});void dup.catch(()=>{});
    await until(async()=>{const state=await operator('status');return state.result?.phase==='a_held';});
    assert.equal(passed,false);
    assert.equal((await operator('release')).ok,false);
    disabled(await send(turn(aText),cookie));
    const beforeRelease=await send(B,cookie);
    assert.equal(beforeRelease.status,200);assert.equal(quote(beforeRelease).status,'unknown',JSON.stringify(beforeRelease.body));
    assert.equal(clip(beforeRelease).status,'no_verified_old_clip');
    assert.equal(quote(beforeRelease).price,null);assert.equal(quote(beforeRelease).modelReceipt.tool.productVersion,1);
    assert.equal(quote(beforeRelease).modelReceipt.tool.productId,release.b.productId);
    assert.equal(passed,false);
    assert.equal((await operator('b_visible',{requestId:A.requestId,messageId:A.messageId})).ok,false);
    const seen=await operator('b_visible',{requestId:B.requestId,messageId:B.messageId});assert.equal(seen.result.phase,'b_visible');
    assert.equal((await operator('release')).result.phase,'released');
    const gotA=await held;const replay=await dup;
    assert.equal(quote(gotA).price.amount,'82.30');assert.equal(quote(gotA).modelReceipt.tool.productId,release.a.productId);
    assert.equal(quote(gotA).modelReceipt.tool.productVersion,5);assert.equal(clip(gotA).workRef.workVersion,2);
    assert.equal(replay.body.replay,true);
    for(const x of [gotA,beforeRelease]){
      assert.equal(quote(x).modelReceipt.mode,'fixture_transport');assert.equal(quote(x).modelReceipt.providerHttpAttempts,2);
    }
    const counts=(await operator('status')).result.counters;
    assert.deepEqual(counts,{businessQuestions:2,providerHttpReservations:4,lanes:{a:{business:1,http:2},b:{business:1,http:2}}});
    assert.equal(proof.getterCount,2);
    assert.deepEqual(proof.httpSubstitute.map(x=>x.containsTool),[false,true,false,true]);
    const savedB=await call('/api/n22/messages/'+B.messageId,{cookie});
    proof.checkpoints.completed={counts,a:{requestId:A.requestId,status:quote(gotA).status,price:quote(gotA).price.amount,clipVersion:2},
      b:{requestId:B.requestId,status:quote(beforeRelease).status,price:null,clip:clip(beforeRelease).status},heldBeforeB:true,duplicate:replay.body.replay};
    await stop();

    const another=structuredClone(release);another.releaseId='changed-after-restart-'+randomUUID();
    stop=await boot(cfg,'new_process_same_budget',imports(cfg,'restart',another));
    assert.equal((await call('/api/n22/capabilities',{cookie})).body.model,'disabled');
    assert.deepEqual((await call('/api/n22/messages/'+B.messageId,{cookie})).body,savedB.body);
    assert.equal((await send(A,cookie)).body.replay,true);
    const fresh=await send(turn(aText),cookie);disabled(fresh);assert.equal(clip(fresh).status,'existing_available');
    assert.equal(proof.httpSubstitute.length,4);assert.equal(proof.getterCount,2);
    const persisted=readCounters(cfg.stateDir);
    assert.deepEqual(persisted,{rows:1,aClaim:1,bClaim:1,aHttp:2,bHttp:2});
    proof.checkpoints.restart={model:'disabled',newReleaseIdDoesNotRearm:true,sameMessage:true,replay:true,freshQuote:quote(fresh).code,clip:clip(fresh).status,persisted};
    const phaseEvents=proof.events.map(x=>x.type);
    for(const [a,b] of [['QA_A_HELD','QA_B_READY'],['QA_B_READY','QA_B_VISIBLE'],['QA_B_VISIBLE','QA_RELEASE_ACK'],['QA_RELEASE_ACK','QA_A_RELEASED']])
      assert.ok(phaseEvents.includes(a)&&phaseEvents.indexOf(a)<phaseEvents.indexOf(b),phaseEvents.join(','));
    await stop();
    proof.result='passed';
  }catch(e){proof.result='failed';proof.failure=e.message;throw e;}
  finally{
    if(active){if(active.child.connected)active.child.send('N17_STOP');proof.stops.push({mode:active.mode,...await active.gone});}
    await provider.close();
    proof.finishedUtc=new Date().toISOString();
    const file=join(f,'G2-unified-proof.json');writeFileSync(file,JSON.stringify(proof,null,2)+'\n');
    console.log('G2 HTTP evidence: '+file);
  }
});
