import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import {cpSync,mkdtempSync,readFileSync,realpathSync,readdirSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {assertP34Fixture} from './p34-write.mjs';

const own=fileURLToPath(new URL('./',import.meta.url));
const local=join(own,'仅本机只读');
const origin='http://127.0.0.1:17871';
const py=process.env.N22_TEST_PYTHON??(process.platform==='win32'?'python':'python3');
const parse=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function newFixture(){
  const path=mkdtempSync(join(local,'test-write-'));
  const made=spawnSync(py,['-B',join(own,'准备启动.py'),'--test-state',path,'--write-fixture'],{encoding:'utf8'});
  assert.equal(made.status,0,made.stderr);
  return {path,cfgFile:join(path,'runtime.json'),cfg:parse(join(path,'runtime.json')),
    entry:join(path,'run/backend/local-n22.mjs')};
}
function counts(f){
  const db=new DatabaseSync(join(f.cfg.stateDir,'n22-write-catalog.sqlite'),{readOnly:true});
  try{return ['catalog_products','catalog_product_assets'].map(n=>db.prepare('SELECT count(*) AS n FROM '+n).get().n);}
  finally{db.close();}
}
async function call(path,{body,cookie}={}){
  const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),
    ...(body?{'Content-Type':'application/json',Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(25000)});
  const j=await r.json();return {status:r.status,j,h:r.headers};
}
async function start(f){
  const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','PATHEXT','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  env.N17_CONFIG=f.cfgFile;
  const cli=fork(f.entry,[],{env,silent:true});let startup='';
  cli.stdout.resume();cli.stderr.on('data',x=>{startup+=x.toString('utf8').slice(0,600);});
  const gone=new Promise(r=>cli.once('exit',(code,signal)=>r({code,signal})));
  const until=Date.now()+16000;
  try{
    for(;Date.now()<until;await delay(70)){
      if(cli.exitCode!==null)throw Error('fixture start failed: '+startup);
      try{
        const h=await call('/healthz'), mark=parse(join(f.cfg.stateDir,'instance.json'));
        if(h.status===200&&mark.pid===cli.pid&&h.j.runId===mark.runId)return async()=>{
          if(cli.connected)cli.send('N17_STOP');assert.deepEqual(await gone,{code:0,signal:null});
        };
      }catch{}
    }
    throw Error('fixture start timeout: '+startup);
  }catch(e){if(cli.connected)cli.send('N17_STOP');await gone;throw e;}
}
async function pair(f){
  const anon=await call('/api/n22/capabilities');assert.equal(anon.status,401);
  const r=await fetch(origin+'/');assert.equal(r.status,200);
  const nonce=/name="nonce" value="([\w-]{43})"/u.exec(await r.text())[1];
  const {openState}=await import(pathToFileURL(join(f.path,'run','backend','state.mjs')).href);
  const s=openState(f.cfg);let code;try{code=s.issue().code;}finally{s.close();}
  const paired=await call('/api/pair',{cookie:r.headers.getSetCookie()[0].split(';')[0],body:{nonce,code}});
  assert.equal(paired.status,200);
  const cookie=paired.h.getSetCookie()[0].split(';')[0];assert.match(cookie,/^n22fixtureOwner=/u);
  return cookie;
}
const data=(text,more={})=>({text,messageId:randomUUID(),requestId:randomUUID(),...more});
async function turn(cookie,text,more={}){return call('/api/n22/turn',{cookie,body:data(text,more)});}
function result(r,s){
  assert.equal(r.status,200,JSON.stringify(r.j));assert.equal(r.j.status,'catalog_write_'+s,JSON.stringify(r.j));
  return r.j.actions[0].result;
}
const confirm=(c,r)=>turn(c,'确认 '+r.intentId,{replyToMessageId:r.preparedMessageId});
async function readCard(c,id){
  const q=await call('/api/n22/product/resolve',{cookie:c,body:data('查卡号 '+id)});
  assert.equal(q.status,200);return {status:q.j.status,card:q.j.cards?.[0]};
}
function checkpoint(f){
  const a=join(f.path,'before-write');
  const fileList=['n15-auth.sqlite','n22-messages.sqlite','n22-album.sqlite','n22-write-catalog.sqlite'];
  assert.deepEqual(readdirSync(f.cfg.stateDir).filter(x=>/sqlite-(?:wal|shm|journal)$/u.test(x)),[]);
  cpSync(f.cfg.stateDir,a,{recursive:true,errorOnExist:true,force:false});
  return {a,digests:Object.fromEntries(fileList.map(n=>[n,sha(join(a,n))])),
    runtimeSha256:sha(f.entry),configSha256:sha(f.cfgFile),
    signatures:Object.fromEntries([f.entry,f.cfgFile,join(f.path,'run','backend','wire.mjs'),join(f.path,'run','backend','p34-write.mjs'),
      ...Object.keys(f.cfg.uiFileDigests).map(n=>join(f.cfg.uiDir,n)),...Object.values(f.cfg.n22Adapters).map(a=>a.file),
      f.cfg.n22CatalogSource].map(n=>[n,sha(n)]))};
}

test('ordinary paired P3/P4: prepare/confirm/cancel/conflict with persisted catalog, real S1 adapter and matched rollback',{timeout:100000},async()=>{
  const f=newFixture();let stop=await start(f),cookie,idC,idD,checkpointA;
  try{
    assert.throws(()=>assertP34Fixture({...f.cfg,origin:'http://127.0.0.1:17869'}),{code:'WRITE_FIXTURE_REQUIRED'});
    assert.throws(()=>assertP34Fixture({...f.cfg,allowAndroidHost:true}),{code:'WRITE_FIXTURE_REQUIRED'});
    cookie=await pair(f);
    assert.equal((await call('/readyz')).j.ready,true);
    const caps=(await call('/api/n22/capabilities',{cookie})).j;
    assert.equal(caps.catalogWrite,'isolated_fixture_only');assert.equal(caps.model,'disabled');assert.equal(caps.content,'not_mounted');
    const gen=spawnSync(py,['-I','-B',join(own,'pixel-dev-fixtures.py')],{encoding:'utf8'});
    assert.equal(gen.status,0);
    const files=JSON.parse(gen.stdout).slice(0,4);
    const received=await call('/api/n22/album/batches',{cookie,body:{requestId:randomUUID(),messageId:randomUUID(),files}});
    assert.equal(received.status,200,JSON.stringify(received.j));
    const {batchId,items}=received.j;
    assert.equal(items.length,4);
    const [a,b,c,d]=items.map(x=>x.assetId);
    const group=id=>'把批次 '+batchId+' 的素材 '+id;
    const C=result(await turn(cookie,group(a)+' 建档'),'prepared');
    assert.equal(C.preview.productId,null);assert.deepEqual(C.preview.willAttach,[a]);
    assert.deepEqual(counts(f),[0,0]);
    assert.equal((await turn(cookie,'确认')).status,400);
    assert.equal((await turn(cookie,'确认 '+C.intentId,{replyToMessageId:randomUUID()})).status,404);
    const first=result(await confirm(cookie,C),'committed').receipt;
    idC=first.productId;assert.deepEqual([first.productVersion,first.outcome],[1,'created']);
    assert.deepEqual(result(await confirm(cookie,C),'committed').receipt,first);
    const same=result(await turn(cookie,'用组 '+C.preview.groupId+' v1 建档'),'prepared');
    const noOp=result(await confirm(cookie,same),'committed').receipt;
    assert.deepEqual([noOp.productId,noOp.productVersion,noOp.outcome],[idC,1,'unchanged']);
    assert.deepEqual(counts(f),[1,1]);
    assert.equal((await turn(cookie,'用组 '+C.preview.groupId+' v9 建档')).status,409);
    const D=result(await turn(cookie,group(b)+' 建档'),'prepared');
    idD=result(await confirm(cookie,D),'committed').receipt.productId;assert.notEqual(idD,idC);
    const wrong=result(await turn(cookie,'用组 '+D.preview.groupId+' v1 补到卡号 '+idC),'prepared');
    assert.equal(result(await confirm(cookie,wrong),'conflict').code,'GROUP_PRODUCT_CONFLICT');
    const cancel=result(await turn(cookie,'把卡号 '+idC+' 的售价改为 901.00 元'),'prepared');
    assert.equal(result(await turn(cookie,'取消 '+cancel.intentId),'cancelled').status,'cancelled');
    assert.equal(result(await confirm(cookie,cancel),'cancelled').status,'cancelled');
    assert.equal((await readCard(cookie,idC)).card.priceYuan,null);
    await stop();stop=null;checkpointA=checkpoint(f);stop=await start(f);
    const addC=result(await turn(cookie,group(c)+' 补到卡号 '+idC),'prepared');
    const addD=result(await turn(cookie,group(d)+' 补到卡号 '+idD),'prepared');
    assert.equal((await readCard(cookie,idC)).card.assetRefs.length,1);
    assert.deepEqual(result(await confirm(cookie,addC),'committed').receipt.addedAssetIds,[c]);
    assert.deepEqual(result(await confirm(cookie,addD),'committed').receipt.addedAssetIds,[d]);
    const price='把卡号 '+idC+' 的售价改为 320.00 元';
    const x=result(await turn(cookie,price),'prepared');
    const y=result(await turn(cookie,price.replace('320.00','999.00')),'prepared');
    assert.equal(x.preview.expectedVersion,2);assert.equal(y.preview.expectedVersion,2);
    assert.equal(x.preview.difference.before,null);assert.equal(x.preview.difference.after.value,'320.00');
    const applied=await confirm(cookie,x);
    assert.equal(result(applied,'committed').receipt.productVersion,3);
    const stale=result(await confirm(cookie,y),'conflict');
    assert.deepEqual([stale.code,stale.currentVersion],['VERSION_CONFLICT',3]);
    const measure=result(await turn(cookie,'把这件的尺寸改为 17.2 cm',{replyToMessageId:applied.j.messageId}),'prepared');
    assert.equal(result(await confirm(cookie,measure),'committed').receipt.productVersion,4);
    const afterC=(await readCard(cookie,idC)).card,afterD=(await readCard(cookie,idD)).card;
    assert.deepEqual([afterC.productVersion,afterC.priceYuan,afterC.size.value,afterC.size.unit],[4,'320.00','17.2','cm']);
    assert.deepEqual(afterC.assetRefs.map(m=>m.assetId),[a,c]);
    assert.deepEqual([afterD.productVersion,afterD.priceYuan,afterD.assetRefs.map(m=>m.assetId)],[2,null,[b,d]]);
    const quote=await turn(cookie,'查卡号 '+idC+' 多少钱');
    assert.equal(quote.j.status,'completed',JSON.stringify(quote.j));
    const q=quote.j.actions[0];assert.deepEqual([q.productId,q.productVersion,q.price.amount,q.modelReceipt.providerHttpAttempts],[idC,4,'320.00',0]);
    await stop();stop=null;stop=await start(f);
    assert.deepEqual((await readCard(cookie,idC)).card,afterC);
    assert.deepEqual((await readCard(cookie,idD)).card,afterD);
    await stop();stop=null;
    assert.equal(dirname(realpathSync(f.cfg.stateDir)),realpathSync(f.path));
    assert.equal(sha(f.entry),checkpointA.runtimeSha256);assert.equal(sha(f.cfgFile),checkpointA.configSha256);
    for(const [n,h] of Object.entries(checkpointA.signatures))assert.equal(sha(n),h);
    for(const [n,h] of Object.entries(checkpointA.digests))assert.equal(sha(join(checkpointA.a,n)),h);
    renameSync(f.cfg.stateDir,join(f.path,'advanced-state-retained'));
    cpSync(checkpointA.a,f.cfg.stateDir,{recursive:true,errorOnExist:true,force:false});
    for(const [n,h] of Object.entries(checkpointA.digests))assert.equal(sha(join(f.cfg.stateDir,n)),h);
    stop=await start(f);
    const oldC=(await readCard(cookie,idC)).card,oldD=(await readCard(cookie,idD)).card;
    assert.deepEqual([oldC.productVersion,oldC.priceYuan,oldC.assetRefs.length,oldD.productVersion,oldD.assetRefs.length],[1,null,1,1,1]);
    assert.deepEqual(counts(f),[2,2]);
    await stop();stop=null;
    const other=newFixture();stop=await start(other);
    assert.notEqual(f.cfg.storeRef,other.cfg.storeRef);
    assert.equal((await call('/api/n22/capabilities',{cookie})).status,401);
    const separate=await pair(other);
    assert.equal((await turn(separate,price)).status,404);
    assert.equal((await turn(separate,'确认 '+C.intentId)).status,404);
    assert.equal((await turn(separate,group(a)+' 建档')).status,404);
    console.log(JSON.stringify({case:'P34 ordinary HTTP',runtimeSha256:checkpointA.runtimeSha256,
      readiness:'isolated_fixture_only',fixtureGateRejectsOldPortAndAndroid:true,preparedCounts:[0,0],created:2,groupReplay:'unchanged_version_1',wrongGroup:'GROUP_PRODUCT_CONFLICT',
      confirmedSiblingLinks:[2,2],cancelledBeforeWrite:true,staleWrite:'VERSION_CONFLICT',
      finalFixtureC:[4,'320.00','17.2 cm'],finalFixtureD:[2,null],sales:[4,'320.00',0],reopened:true,
      rollback:[1,1],matchedSnapshot:true,matchedRuntimeSignatures:Object.keys(checkpointA.signatures).length,
      foreign:['old_cookie_401','foreign_card_404','foreign_intent_404','foreign_batch_404'],
      mobile:false,sourceWrites:0}));
  }finally{if(stop)await stop();}
});
