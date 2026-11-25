import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const own=fileURLToPath(new URL('./',import.meta.url));
const py=process.env.N22_TEST_PYTHON??(process.platform==='win32'?'python':'python3');
const origin='http://127.0.0.1:17873';
const parse=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const fixture=()=>mkdtempSync(join(own,'仅本机只读','test-write-d3-'));
function run(exe,args,opts={}){
  const p=spawnSync(exe,args,{encoding:'utf8',timeout:45000,...opts});
  assert.equal(p.status,0,p.stdout+'\n'+p.stderr+'\n'+p.error);
  return p.stdout;
}
async function http(p,{cookie,body,range}={}){
  const r=await fetch(origin+p,{method:body?'POST':'GET',headers:{
    ...(cookie?{Cookie:cookie}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{}),...(range?{Range:range}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(55000)});
  return {status:r.status,h:r.headers,body:r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer())};
}
function make(text,mid){return {requestId:randomUUID(),messageId:randomUUID(),text,...(mid?{replyToMessageId:mid}:{})};}
const first=(r)=>r.body.actions?.[0];
function action(r,kind,st){
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(first(r)?.action,kind,JSON.stringify(r.body));
  assert.equal(first(r).status,st,JSON.stringify(r.body));return first(r).result;
}
function count(f){
  const base=join(f,'state','d3');
  const db=new DatabaseSync(join(base,'d3-content.sqlite'),{readOnly:true});
  try{return {jobs:db.prepare('SELECT count(*) n FROM n22_plan_jobs').get().n,
    tasks:db.prepare('SELECT count(*) n FROM content_tasks').get().n,
    works:db.prepare('SELECT count(*) n FROM studio_works').get().n,
    mp4:readdirSync(join(base,'media')).filter(k=>k.endsWith('.mp4')).length};}
  finally{db.close();}
}
const zero={jobs:0,tasks:0,works:0,mp4:0}, one={jobs:1,tasks:1,works:1,mp4:1};
function scopes(f){
  const d=new DatabaseSync(join(f,'state','n22-write-catalog.sqlite'),{readOnly:true});
  try{return d.prepare('SELECT product_id productId,product_version productVersion FROM catalog_products ORDER BY product_id').all().map(x=>({...x}));}
  finally{d.close();}
}
async function start(f,trace,cfgFile='runtime.json'){
  const cfgPath=join(f,cfgFile),entry=join(f,'run','backend','local-n22.mjs');
  const env=Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','PATHEXT','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  env.N17_CONFIG=cfgPath;
  const cli=fork(entry,[],{env,silent:true});let stderr='';
  cli.stdout.resume();cli.stderr.on('data',x=>{stderr+=x.toString('utf8');});
  const gone=new Promise(r=>cli.once('exit',(code,signal)=>r({code,signal})));
  const stop=async()=>{if(cli.connected)cli.send('N17_STOP');const outcome=await gone;trace.stops.push(outcome);assert.deepEqual(outcome,{code:0,signal:null},stderr);};
  try{
    for(let i=0;i<150;i++){
      if(cli.exitCode!==null)throw Error('isolated service exit: '+stderr);
      try{
        const h=await http('/healthz'),m=parse(join(f,'state','instance.json'));
        if(h.status===200&&h.body.runId===m.runId&&m.pid===cli.pid){
          trace.starts.push({runId:h.body.runId,pid:cli.pid,health:h.status});return stop;
        }
      }catch{}
      await delay(60);
    }
    throw Error('isolated service did not start: '+stderr);
  }catch(e){if(cli.connected)cli.send('N17_STOP');await gone;throw e;}
}
async function pair(f){
  const p=await http('/'), page=p.body.toString('utf8');
  const nonce=/name="nonce" value="([\w-]{43})"/u.exec(page)?.[1];assert.ok(nonce);
  const {openState}=await import(pathToFileURL(join(f,'run','backend','state.mjs')).href);
  const state=openState(parse(join(f,'runtime.json')));let code;
  try{code=state.issue().code;}finally{state.close();}
  const r=await http('/api/pair',{cookie:p.h.getSetCookie()[0].split(';')[0],body:{nonce,code}});
  assert.equal(r.status,200);return r.h.getSetCookie()[0].split(';')[0];
}
function expiryFixture(f,id){
  const db=new DatabaseSync(join(f,'state','n22-write-catalog.sqlite'));
  try{const now=Date.now();assert.equal(db.prepare('UPDATE n22_d3_windows SET expires=? WHERE message=?').run(now-1,id).changes,1);}
  finally{db.close();}
}
function swapFixtureBlob(f,cfg,id,replacement){
  const d=new DatabaseSync(join(f,'state','n22-album.sqlite'));
  try{
    const current=d.prepare('SELECT b FROM alb_asset WHERE s=? AND id=?').get(cfg.storeRef,id);
    assert.ok(current?.b);
    assert.equal(d.prepare('UPDATE alb_asset SET b=? WHERE s=? AND id=?').run(replacement,cfg.storeRef,id).changes,1);
    return Buffer.from(current.b);
  }finally{d.close();}
}

test('paired ordinary N22 HTTP: real D3 prepare, cancel, exact confirmation, repeat, media and adopt', {timeout:165000},async()=>{
  const started=new Date().toISOString();
  const f=fixture(), cfgFile=join(f,'runtime.json');
  const trace={task:'N22-D3UI',started,fixture:f,source:'two locally drawn PNGs; isolated C only',origin,starts:[],stops:[],replies:{}};
  const save=(key,r)=>{trace.replies[key]={http:r.status,requestHeader:r.h.get('x-n22-request-id'),body:r.body};return r;};
  let stop=null;
  try{
    trace.prepareOutput=run(py,['-B',join(own,'准备启动.py'),'--test-state',f,'--write-fixture','--d3-fixture','--without-sales']).trim();
    const cfg=parse(cfgFile); trace.adapterPins=cfg.n22D3Adapters;
    trace.uiPins=cfg.uiFileDigests;
    trace.fixtureInputHashes=parse(cfg.n22D3Policy).hashes;
    assert.equal(cfg.n22Adapters.sales,undefined);
    stop=await start(f,trace);
    assert.equal((await http('/api/n22/turn',{body:make('准备两种风格，先别制作')})).status,401);
    const cookie=await pair(f), turn=(x)=>http('/api/n22/turn',{cookie,body:x}), get=(p)=>http(p,{cookie});
    const caps=save('capabilities',await get('/api/n22/capabilities')).body;
    assert.equal(caps.sales,'not_mounted');assert.equal(caps.model,'disabled');
    assert.equal(caps.contentD3,'mounted_in_isolated_write_fixture');
    const html=await get('/');
    assert.match(html.body.toString(),/id="composer"/u);assert.match(html.h.get('content-security-policy'),/media-src 'self'/u);
    trace.page={status:html.status,sha256:hash(html.body),sameOriginMedia:true};
    for(const [n,expected] of Object.entries(cfg.uiFileDigests)){
      const r=await get(n==='index.html'?'/':'/'+n);
      assert.equal(r.status,200);assert.equal(hash(r.body),expected);
    }
    const generated=JSON.parse(run(py,['-I','-B',join(own,'d3-fixture-input.py')]));
    const upload={requestId:randomUUID(),messageId:randomUUID(),files:generated.files};
    const loaded=await http('/api/n22/album/batches',{cookie,body:upload});assert.equal(loaded.status,200);
    const keys=loaded.body.items.map(x=>x.assetId);assert.equal(keys.length,2);
    const pr=await turn(make('把批次 '+loaded.body.batchId+' 的素材 '+keys.join(' ')+' 建档'));
    assert.equal(pr.body.status,'catalog_write_prepared',JSON.stringify(pr.body));
    const a=pr.body.actions[0].result;
    const create=make('确认 '+a.intentId,a.preparedMessageId);
    const ok=save('newFixtureCard',await turn(create));
    assert.equal(ok.body.status,'catalog_write_committed',JSON.stringify(ok.body));
    const pid=ok.body.productId;
    assert.equal(ok.body.productVersion,1);
    const without=save('beforeMaterialApproval',await turn(make('准备两种风格，先别制作',create.messageId)));
    assert.equal(first(without)?.status,'needs_source',JSON.stringify(without.body));
    assert.deepEqual(count(f),zero);

    await stop();stop=null;
    trace.provision=JSON.parse(run(process.execPath,[join(own,'d3-provision.mjs'),cfgFile,create.messageId]));
    assert.equal(trace.provision.productId,pid);assert.equal(trace.provision.productVersion,2);
    trace.catalogAtD3Start=scopes(f);
    assert.deepEqual(trace.catalogAtD3Start,[{productId:pid,productVersion:2}]);
    stop=await start(f,trace);
    if(process.env.N22_D3_DESKTOP==='1'){
      trace.desktop=JSON.parse(run(py,['-B',join(own,'D3UI-桌面实跑.py'),f,pid],{input:cookie,timeout:115000}));
      assert.equal(trace.desktop.phase,'complete');assert.deepEqual(count(f),one);
      assert.deepEqual(scopes(f),[{productId:pid,productVersion:2}]);
      trace.database=count(f);trace.result='passed';return;
    }
    const prepare=()=>make('准备卡号 '+pid+' 的两种风格，先别制作');
    const toCancel=prepare();
    const canceledDraft=action(save('preparedForCancel',await turn(toCancel)),'content_prepare','drafts_ready');
    assert.equal(canceledDraft.plans.length,2);
    assert.deepEqual(count(f),zero);
    action(save('cancel',await turn(make('取消',toCancel.messageId))),'content_cancel','cancelled');
    const canceled=save('confirmCanceled',await turn(make('确认按第一版做',toCancel.messageId)));
    assert.equal(canceled.body.code,'CANCELED',JSON.stringify(canceled.body));
    const expires=prepare();
    action(save('prepareForExpiry',await turn(expires)),'content_prepare','drafts_ready');
    const changedMaterial=prepare();
    action(save('prepareForChangedBytes',await turn(changedMaterial)),'content_prepare','drafts_ready');
    assert.deepEqual(trace.afterCancel=count(f),zero);
    await stop();stop=null;
    expiryFixture(f,expires.messageId);
    const damaged=Buffer.from([1,2,3]);
    const original=swapFixtureBlob(f,cfg,keys[0],damaged);
    stop=await start(f,trace);
    const invalidSource=save('changedBytes',await turn(make('确认按第一版做',changedMaterial.messageId)));
    assert.equal(invalidSource.body.code,'STALE_VERSION',JSON.stringify(invalidSource.body));
    assert.deepEqual(trace.afterAssetChange=count(f),zero);
    await stop();stop=null;
    assert.deepEqual(swapFixtureBlob(f,cfg,keys[0],original),damaged);
    stop=await start(f,trace);
    const expired=save('expired',await turn(make('确认按第一版做',expires.messageId)));
    assert.equal(expired.body.code,'D3_CONFIRMATION_EXPIRED',JSON.stringify(expired.body));
    assert.deepEqual(trace.afterExpiry=count(f),zero);
    const draft=make('准备两种风格，先别制作',expires.messageId);
    const ready=action(save('prepareActual',await turn(draft)),'content_prepare','drafts_ready');
    assert.equal(ready.plans.length,2);
    assert.deepEqual(new Set(ready.plans[1].shots.map(s=>s.assetId)),new Set(keys));
    const ambiguous=save('unselected',await turn(make('确认按这个分镜做',draft.messageId)));
    assert.equal(ambiguous.body.code,'D3_EXACT_PLAN_REQUIRED',JSON.stringify(ambiguous.body));
    assert.deepEqual(count(f),zero);
    const select={referenceMessageId:draft.messageId,productId:pid,productVersion:2,draftSetId:ready.draftSetId,
      draftSetVersion:ready.draftSetVersion,planId:ready.plans[1].planId,planVersion:ready.plans[1].planVersion};
    const picked=save('select',await http('/api/n22/content/d3/selection',{cookie,body:select}));
    assert.equal(picked.body.status,'selected',JSON.stringify(picked.body));
    const switched=save('attemptReplacePinnedPlan',await http('/api/n22/content/d3/selection',{cookie,body:{
      ...select,planId:ready.plans[0].planId,planVersion:ready.plans[0].planVersion}}));
    assert.equal(switched.status,409);assert.equal(switched.body.error.code,'D3_SELECTION_ALREADY_PINNED');
    const confirm=make('确认按这个分镜做',draft.messageId);
    const response=save('confirm',await turn(confirm));
    const outcome=action(response,'content_confirm','awaiting_approval');
    assert.equal(outcome.planId,select.planId);assert.equal(outcome.planVersion,select.planVersion);
    assert.match(outcome.previewUrl,/^\/api\/n22\/content\/d3\/works\//u);
    assert.equal(outcome.deliveryStatus,'not_submitted');
    assert.deepEqual(trace.afterConfirm=count(f),one);
    const replay=save('replayExact',await turn(confirm));assert.equal(replay.body.replay,true);assert.deepEqual(first(replay).result,outcome);
    const onceMore=action(save('repeatDifferentRequest',await turn(make('确认按这个分镜做',draft.messageId))),'content_confirm','awaiting_approval');
    assert.deepEqual(onceMore.workRef,outcome.workRef);assert.equal(onceMore.taskId,outcome.taskId);
    assert.deepEqual(trace.afterRepeat=count(f),one);
    const range=await http(outcome.previewUrl,{cookie,range:'bytes=0-31'});
    const full=await get(outcome.previewUrl);const anon=await http(outcome.previewUrl);
    assert.equal(range.status,206);assert.equal(range.body.length,32);assert.equal(full.status,200);
    assert.equal(anon.status,401);assert.equal(hash(full.body),outcome.sha256);
    assert.deepEqual(range.body,full.body.subarray(0,32));
    const wrong=await get(outcome.previewUrl.replace(confirm.messageId,randomUUID()));assert.equal(wrong.status,404);
    const copy=join(f,'D3-http-observed.mp4');writeFileSync(copy,full.body,{flag:'wx'});
    const probe=JSON.parse(run('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height:format=duration','-of','json',copy]));
    assert.equal(probe.streams.length,1);assert.equal(probe.streams[0].codec_name,'h264');
    assert.ok(Number(probe.format.duration)>4);
    trace.media={http:full.status,range:range.status,contentRange:range.h.get('content-range'),anonymous:anon.status,wrongMessage:wrong.status,
      sha256:hash(full.body),bytes:full.body.length,probe};
    const adopt=make('采用这版，不要发布',confirm.messageId);
    const chosen=action(save('adopt',await turn(adopt)),'content_adopt','adopted');
    assert.deepEqual(chosen.workRef,outcome.workRef);assert.equal(chosen.deliveryStatus,'not_submitted');
    stop&&await stop();stop=null;stop=await start(f,trace);
    const restored=save('restoreAfterRestart',await get('/api/n22/messages/'+adopt.messageId));
    assert.deepEqual(first(restored).result,chosen);
    const reopened=await get(chosen.previewUrl);assert.equal(reopened.status,200);assert.equal(hash(reopened.body),outcome.sha256);
    trace.reopenedMedia={http:reopened.status,sha256:hash(reopened.body)};
    const stale=prepare();
    action(save('prepareBeforeVersionChange',await turn(stale)),'content_prepare','drafts_ready');
    const update=await turn(make('把卡号 '+pid+' 的尺寸改为 17 mm'));
    assert.equal(update.body.status,'catalog_write_prepared',JSON.stringify(update.body));
    const up=update.body.actions[0].result;
    const advanced=await turn(make('确认 '+up.intentId,up.preparedMessageId));
    assert.equal(advanced.body.productVersion,3,JSON.stringify(advanced.body));
    const bad=save('confirmStaleVersion',await turn(make('确认按第一版做',stale.messageId)));
    assert.equal(bad.body.code,'D3_STALE_OR_WRONG_CARD',JSON.stringify(bad.body));
    assert.equal((await get(chosen.previewUrl)).status,409);
    assert.equal((await get('/api/n22/messages/'+adopt.messageId)).status,409);
    assert.deepEqual(trace.afterVersionChange=count(f),one);
    trace.catalogFinal=scopes(f);assert.deepEqual(trace.catalogFinal,[{productId:pid,productVersion:3}]);
    const {openState}=await import(pathToFileURL(join(f,'run','backend','state.mjs')).href);
    const ownState=openState(cfg);
    try{const installed=ownState.list();assert.equal(installed.length,1);assert.equal(ownState.revoke(installed[0].installationId).revoked,true);}
    finally{ownState.close();}
    const revoked=save('oldInstallationAfterRevoke',await get('/api/n22/messages/'+adopt.messageId));
    assert.equal(revoked.status,401);
    const next=await pair(f);
    assert.equal(save('differentInstallation',await http('/api/n22/messages/'+adopt.messageId,{cookie:next})).status,404);
    trace.result='passed';
  }catch(e){trace.result='failed';trace.failure=e.message;throw e;}
  finally{
    try{if(stop)await stop();}
    finally{
      trace.finished=new Date().toISOString();
      const out=join(f,'D3-ordinary-proof.json');writeFileSync(out,JSON.stringify(trace,null,2));
      console.log('D3 proof: '+out);
    }
  }
});
