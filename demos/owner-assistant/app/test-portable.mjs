import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline-only relocation check: no API key, no existing conversation DB, no paid calls.
const temp = await mkdtemp(path.join(tmpdir(), 'jewelry-portable-'));
const app = path.join(temp, '换台电脑 中文空格', 'app');
await cp(fileURLToPath(new URL('.',import.meta.url)), app, {recursive:true, filter:p=>!p.includes('__pycache__')});
const data=path.join(app,'..','data'),demo=path.join(data,'demo'),source=path.join(data,'source');
await mkdir(path.join(demo,'分类结果','项链'),{recursive:true}); await mkdir(path.join(demo,'商品卡'),{recursive:true}); await mkdir(source,{recursive:true});
const file='DEMO105.jpg', image=Buffer.from('/9j/2Q==','base64');
await writeFile(path.join(source,file),image); await writeFile(path.join(demo,'分类结果','项链',file),image);
const old='E:\\unavailable-old-pc\\'+file;
await writeFile(path.join(demo,'分类结果.json'),JSON.stringify({groups:{'项链':1},items:[{group:'项链',file,source:old,classified_copy:old}],classificationMode:'deepseek_vision'}));
const card={cardId:'DEMO105',status:'draft',name:'便携测试商品',sourceImage:old,price:123,color:'黄色',category:'项链'};
await writeFile(path.join(demo,'商品卡索引.json'),JSON.stringify({cards:[card]}));
await writeFile(path.join(demo,'商品卡','DEMO105.json'),JSON.stringify(card));
const env={...process.env,PORT:'34257',MVP_SALES_PORT:'34259',MVP_MAIN_PORT:'34257',DEEPSEEK_API_KEY:'',MVP_FIXTURE:'1'};
for(const key of ['MVP_DATA_DIR','MVP_SOURCE_DIR','MVP_PRICE_SOURCE','ANRAN_DB'])delete env[key];
const children=[];
function launch(file){const c=spawn(process.execPath,[file],{cwd:app,env,stdio:['ignore','pipe','pipe']});children.push(c);return c;}
async function ready(url){for(let n=0;n<100;n++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Not ready: '+url);}
const main='http://127.0.0.1:34257',guest='http://127.0.0.1:34259',owner='http://localhost:34259';
try{
  const mainProcess=launch('server.mjs'); const sales=launch('anran-server.mjs');
  await ready(main);await ready(owner+'/demo/api/owner');
  const home=await fetch(main).then(r=>r.text());
  assert.ok(home.includes(guest+'/demo/shop?sku=DEMO105'));
  assert.ok(home.includes(owner+'/demo/owner'));assert.ok(home.includes('anran-sales-dialog'));assert.ok(!home.includes('__SALES_'));
  assert.equal((await fetch(main+'/gallery')).status,200);
  assert.equal((await fetch(main+'/gallery/image?group='+encodeURIComponent('项链')+'&file='+file)).status,200);
  assert.equal((await fetch(main+'/catalog/image?id=DEMO105')).status,200,'old absolute image path rebased');
  assert.equal((await fetch(main+'/catalog?id=DEMO105')).status,200);
  assert.equal((await fetch(guest+'/demo/product-image?sku=DEMO105')).status,200);
  assert.deepEqual(await fetch(owner+'/demo/api/owner').then(r=>r.json()),[],'fresh database');
  assert.equal((await fetch(guest+'/demo/api/owner')).status,404);
  assert.equal((await fetch(owner+'/demo/api/guest',{method:'POST',headers:{'content-type':'application/json',origin:owner},body:'{}'})).status,403);
  const html=await fetch(guest+'/demo/shop?sku=DEMO105').then(r=>r.text());assert.ok(html.includes('data-view="guest"'));
  const js=await fetch(owner+'/demo/anran-support.js').then(r=>r.text());assert.ok(js.includes('http://127.0.0.1:34257'));assert.ok(!js.includes('__MAIN_PORT__'));
  const view=await fetch(owner+'/demo/owner');assert.ok(view.headers.get('content-security-policy').includes('34257'));
  const created=await fetch(guest+'/demo/api/guest',{method:'POST',headers:{origin:guest,'content-type':'application/json'},body:'{}'});
  assert.equal(created.status,200);const cookie=created.headers.get('set-cookie').split(';')[0];const thread=await created.json();assert.equal(thread.messages.length,0);
  sales.kill();await new Promise(r=>sales.once('exit',r));launch('anran-server.mjs');await ready(owner+'/demo/api/owner');
  const restored=await fetch(guest+'/demo/api/guest',{headers:{cookie}}).then(r=>r.json());assert.equal(restored.id,thread.id,'new demo session survives service restart');
  const result=await fetch(main+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'相册整理'})}).then(r=>r.json());
  assert.equal(result.mode,'fixture');assert.ok(result.reply.includes('/gallery'));
  await Promise.all(children.filter(c=>c.exitCode===null && c.signalCode===null).map(c=>new Promise(r=>{c.once('exit',r);c.kill();})));
  env.MVP_PREVIEW='1';launch('server.mjs');launch('anran-server.mjs');await ready(main);await ready(owner+'/demo/api/owner');
  const blocked=await fetch(main+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'相册整理'})});
  assert.equal(blocked.status,503);assert.equal((await blocked.json()).mode,'preview');
  const blockedMessage=await fetch(guest+'/demo/api/message',{method:'POST',headers:{origin:guest,'content-type':'application/json',cookie},body:'{}'});
  assert.equal(blockedMessage.status,503);assert.equal((await blockedMessage.json()).preview,true);
  assert.equal((await fetch(main+'/gallery')).status,200);assert.equal((await fetch(main+'/catalog')).status,200);
  console.log('PASS portable: relocated Unicode/space path; default ../data; gallery/catalog original bytes; custom ports; latest dual-window DOM; CSP/origin isolation; fresh SQLite; session restart; offline fixture explicitly labelled; preview blocks chat and message writes before fixture/model.');
  console.log('NOT TESTED: live DeepSeek/vision and browser interaction. No paid call made. Temporary evidence: '+temp);
}finally{for(const c of children)c.kill();}
