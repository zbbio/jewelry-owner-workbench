import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mapBatch,viewAlbumRow} from './album-map.mjs';

const src=fileURLToPath(new URL('.',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const batchId='0123456789abcdef0123456789abcdef';
async function poll(check){for(let i=0;i<90;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw Error('missing completed receipt');}

test('homepage/chat + versioned album/filters + existing-card projection, no external calls', {timeout:25000}, async()=>{
 const tmp=await mkdtemp(path.join(tmpdir(),'jewelry-mvp-'));
 const demo=path.join(tmp,'demo'), version=path.join(tmp,'demo-20261127-ac');
 const save=(p,data)=>writeFile(p,JSON.stringify(data)+'\n');
 const listener=createServer();
 await new Promise((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));
 const port=listener.address().port;
 await new Promise(resolve=>listener.close(resolve));
 const env={...process.env,PORT:String(port),MVP_DATA_DIR:tmp,MVP_SOURCE_DIR:path.join(tmp,'source'),
   MVP_ALBUM_V2_DIR:version,MVP_AUTH_REQUIRED:'0',MVP_FIXTURE:'1'};
 delete env.DEEPSEEK_API_KEY;
 let server;
 try {
  const python=process.env.MVP_PYTHON || (process.platform==='win32'?'python':'python3');
  execFileSync(python,['-X','utf8',path.join(src,'create-demo-data.py')],{env});
  const file=path.join(version,'分类结果.json');
  const album=JSON.parse(await readFile(file,'utf8')), index=path.join(demo,'商品卡索引.json');
  const originalIndex=await readFile(index);
  const pins=album.items.slice(0,3).map(r=>({file:r.file,sha256:r.sha256,category:r.group,type:''}));
  const mapped=mapBatch({batchId,rows:pins});
  const items=mapped.items.map((r,i)=>({...album.items[i],...r}));
  const groups=Object.fromEntries(items.map(r=>[r.group,1]));
  const snapshot={batchId,taxonomyVersion:mapped.taxonomyVersion,evidence:mapped.evidence,
    items,groups,fileCount:items.length,sourceRoot:album.sourceRoot,classificationMode:'deepseek_vision' /* synthetic transport fixture */};
  await save(file,snapshot);
  const first=items[0], imageDir=path.join(version,'分类结果','版本',batchId,first.group);
  await mkdir(imageDir,{recursive:true});
  await copyFile(first.source,path.join(imageDir,first.file));
  const bindings={indexSha256:sha(originalIndex),items:items.map(r=>({file:r.file,sha256:r.sha256,cardId:path.parse(r.file).name}))};
  await save(path.join(version,'已核单图货号.json'),bindings);
  assert.ok(viewAlbumRow(first,snapshot).classification.evidenceRefs.length);
  assert.deepEqual(await readFile(index),originalIndex);
  assert.equal(sha(await readFile(first.source)),first.sha256);
  server=spawn(process.execPath,['server.mjs'],{cwd:src,env,stdio:['ignore','pipe','inherit']});
  const started=Promise.race([once(server.stdout,'data').then(([chunk])=>String(chunk)),once(server,'exit').then(([code])=>{throw Error('server exit '+code);})]);
  const base=(await started).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base);
  const page=async route=>{
   const r=await fetch(base+route);assert.equal(r.status,200,route);return r.text();
  };
  const home=await page('/');
  assert.match(home,/珠宝/);
  assert.match(home,/说说你想做什么/);
  const gallery=await page('/gallery');
  assert.match(gallery,/共 3 张照片/);
  assert.match(gallery,/颜色（看图）/);
  const filtered=await page('/gallery?material='+encodeURIComponent('示意图'));
  assert.match(filtered,/共 2 张照片/);
  const image='/gallery/image?'+new URLSearchParams({group:first.group,file:first.file,batch:batchId});
  const media=await fetch(base+image);assert.equal(media.status,200);
  assert.equal(sha(Buffer.from(await media.arrayBuffer())),first.sha256);
  assert.equal((await fetch(base+image.replace(batchId,'f'.repeat(32)))).status,404);
  const card=await page('/catalog?id=DEMO103');
  assert.match(card,/DEMO103/);
  assert.match(card,/240/);
  const chat=async text=>{
   const r=await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
   assert.equal(r.status,200);const data=await r.json();assert.equal(data.mode,'fixture');return data;
  };
  assert.match(home,/销售接待/);
  assert.match(await page('/album-intent.mjs'),/isCatalogIntent/);
  const post=(payload)=>fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const catalogJobId=randomBytes(32).toString('hex');
  const text='根据刚才的分类结果，自动为每件建立一个结构化商品卡 JSON 文件，字段包括颜色、品类、类型、材质、形态，先保存草稿';
  const payload={text,catalogJobId};
  const unknown=await post({text,catalogJobId,sourceAlbumJobId:'0'.repeat(64)});
  assert.equal(unknown.status,409);
  assert.equal((await unknown.json()).code,'album_not_ready');
  const reply=await post(payload); assert.equal(reply.status,202);
  assert.equal((await reply.json()).job.id,catalogJobId);
  assert.equal((await fetch(base+'/api/album-jobs/'+catalogJobId)).status,404);
  await poll(async ()=>{
   const {job}=await (await fetch(base+'/api/catalog-jobs/'+catalogJobId)).json();
   assert.notEqual(job.status,'failed',job.code);
   if(job.status!=='completed')return false;
   assert.deepEqual(job,{id:catalogJobId,status:'completed',batchId,total:3});
   return true;
  });
  const projection=path.join(version,'商品分类展示.json');
  const written=await readFile(projection);
  const retry=await post(payload);assert.equal(retry.status,202);
  assert.equal((await retry.json()).job.status,'completed');
  assert.deepEqual(await readFile(projection),written);
  assert.equal(JSON.parse(written).batchId,batchId);
  assert.deepEqual(await readFile(index),originalIndex);
  assert.equal((await chat('查看商品卡')).tool,'catalog_create_or_read_card');
  assert.equal((await chat('客人问有没有证书，帮我回复')).receipt.result.sent,false);
  const content=await chat('想看戴起来多大，给我列三个镜头，先别做片');
  assert.equal(content.receipt.result.produced,false);
  assert.equal(content.receipt.result.shots.length,3);
 } finally {
  if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  await rm(tmp,{recursive:true,force:true});
 }
});

test('store sends two answers to the original session and synchronizes only its paired owner', {timeout:20000}, async()=>{
 const tmp=await mkdtemp(path.join(tmpdir(),'public-reception-'));
 const env={...process.env,PORT:'0',MVP_DATA_DIR:tmp,MVP_AUTH_REQUIRED:'0',MVP_FIXTURE:'0',DEEPSEEK_API_KEY:'synthetic-test-key',ANRAN_CLOUD_DB_DIR:path.join(tmp,'reception'),ALBUM_JOBS_DB_DIR:path.join(tmp,'jobs')};
 let child;
 try{
   const python=process.env.MVP_PYTHON || (process.platform==='win32'?'python':'python3');
  execFileSync(python,['-X','utf8',path.join(src,'create-demo-data.py')],{env});
 const provider="globalThis.fetch = async ()=>Response.json({id:'synthetic-provider',choices:[{message:{tool_calls:[{function:{name:'sales_prepare_reply',arguments:JSON.stringify({topic:'price'})}}]}}]});";
  // Refuse all outbound traffic from the fixture server by replacing its only model transport.
  const inject='data:text/javascript,'+encodeURIComponent(provider);
  // Reserve a real port because the production startup log prints the configured value.
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));env.PORT=String(listener.address().port);await new Promise(r=>listener.close(r));
  child=spawn(process.execPath,['--import',inject,'server.mjs'],{cwd:src,env,stdio:['ignore','pipe','inherit']});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('server exit '+code);})]);
  const base='http://127.0.0.1:'+env.PORT;
  const call=async (route,{cookie,body}={})=>fetch(base+route,{redirect:'manual',...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
    headers:{'content-type':'application/json',origin:base,...(cookie?{cookie}:{})}});
  const start=await call('/demo/api/start',{body:{}});assert.equal(start.status,200);
  const owner=start.headers.get('set-cookie').split(';')[0],{shop}=await start.json();
  const invite=await call(shop);assert.equal(invite.status,303);
  const guest=invite.headers.get('set-cookie').split(';')[0],storeUrl=invite.headers.get('location');
  assert.match(await (await call(storeUrl,{cookie:guest})).text(),/data-view="guest".*data-sku="DEMO105"/s);
  assert.equal((await call('/demo/api/owner',{cookie:guest})).status,403);
  let previous;
  for(let i=1;i<=2;i++){
   const body={id:randomUUID(),text:i===1?'这件多少钱':'那么售价是多少',sku:'DEMO105'};
   assert.equal((await call('/demo/api/message',{cookie:guest,body})).status,202);
   await poll(async ()=>{
    const actual=await (await call('/demo/api/guest',{cookie:guest})).json(),m=actual.messages.at(-1);
    if(m?.role!=='assistant'||actual.messages.length<2*i)return false;
    assert.equal(m.status,'sent');assert.match(m.text,/260 元/);
    if(previous)assert.equal(actual.id,previous);previous=actual.id;
    const data=await (await call('/demo/api/owner?watch=1',{cookie:owner})).json();
    assert.equal(data.latestReply.threadId,actual.id);assert.equal(data.latestReply.messageId,m.id);
    return true;
   });
   assert.match(await (await call(storeUrl,{cookie:guest})).text(),/data-view="guest"/);
  }
 }finally{
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  await rm(tmp,{recursive:true,force:true,maxRetries:4});
 }
});