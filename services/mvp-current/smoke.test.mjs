import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mapBatch,viewAlbumRow} from './album-map.mjs';

const src=fileURLToPath(new URL('.',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const batchId='0123456789abcdef0123456789abcdef';

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
    items,groups,fileCount:items.length,sourceRoot:album.sourceRoot,classificationMode:'synthetic-test'};
  await save(file,snapshot);
  const first=items[0], imageDir=path.join(version,'分类结果','版本',batchId,first.group);
  await mkdir(imageDir,{recursive:true});
  await copyFile(first.source,path.join(imageDir,first.file));
  const bindings={indexSha256:sha(originalIndex),items:items.map(r=>({file:r.file,sha256:r.sha256,cardId:path.parse(r.file).name}))};
  await save(path.join(version,'已核单图货号.json'),bindings);
  assert.ok(viewAlbumRow(first,snapshot).classification.evidenceRefs.length);
  // The underlying product tool publishes the projection; no model or vision process is involved.
  execFileSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {executeToolAsync} from './tools.mjs';
    const r=await executeToolAsync('catalog_create_or_read_card',{mode:'vision'});
    assert.equal(r.result.classificationSource,'album_snapshot');
    assert.equal(r.result.total,3);
    assert.equal(r.result.visionCalls,0);
  `],{cwd:src,env});
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
  assert.equal((await chat('整理相册')).tool,'album_classify_batch');
  assert.equal((await chat('建商品卡')).tool,'catalog_create_or_read_card');
  assert.equal((await chat('客人问有没有证书，帮我回复')).receipt.result.sent,false);
  const content=await chat('想看戴起来多大，给我列三个镜头，先别做片');
  assert.equal(content.receipt.result.produced,false);
  assert.equal(content.receipt.result.shots.length,3);
 } finally {
  if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  await rm(tmp,{recursive:true,force:true});
 }
});
