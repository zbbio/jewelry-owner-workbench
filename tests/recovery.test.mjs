import {execFileSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {mkdtempSync, unlinkSync, rmdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAlbum} from '../album/index.mjs';
import {createCatalog} from '../catalog/index.mjs';

// A plain grey square, not a jewelry fixture. The image deliberately needs review.
const bytes=execFileSync(process.env.ALBUM_PYTHON||"python",["-B","-c","from PIL import Image; import sys; Image.new('RGB',(48,48),(160,160,160)).save(sys.stdout.buffer,format='PNG')"],{windowsHide:true});
const serverPath=fileURLToPath(new URL('../server.mjs',import.meta.url));
async function server(dir,shopId){
 const child=spawn(process.execPath,[serverPath],{env:{...process.env,WORKBENCH_DATA:dir,WORKBENCH_SHOP:shopId,PORT:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 const closed=new Promise(res=>child.once('close',res)); let log='';
 child.stderr.on('data',c=>{log+=String(c)});
 let timer;
 const url=await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>{child.kill();reject(new Error('server timed out '+log))},15000);
  let stdout='';
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();const m=stdout.match(/LOCAL (http:\/\/127\.0\.0\.1:\d+)\r?\n/);if(m)resolve(m[1])});
  child.once('error',reject);child.once('exit',n=>reject(new Error('server exited '+n+' '+log)));
 }).finally(()=>clearTimeout(timer));
 return {url,close:async()=>{child.kill();await closed},async call(path,payload){
  const res=await fetch(url+path,payload?{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify(payload)}:{});
  return [res.status,await res.json()];
 }};
}
test('persisted outbox after committed-but-lost receipt: new process /api/retry, only original card/write, duplicate clicks and store isolation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jewelry-ticket-recovery-'));
 const database=join(dir,'workbench.sqlite'),ctx={shopId:'owner',actorId:'employee'};
 let db=new DatabaseSync(database),owner,other;
 try{
  let album;const catalog=createCatalog({db,hasAsset:(c,a)=>album.hasAsset(c,a)});
  album=createAlbum({db,dataDir:dir,catalog:{...catalog,acceptGroup(c,request){
   catalog.acceptGroup(c,request);
   throw Object.assign(new Error('simulate response lost after durable commit'),{code:'SIMULATED_LOST_ACK',httpStatus:503});
  }}});
  const init=await album.importBatch(ctx,{requestId:'select',files:[{bytes}]});
  assert.equal(init.pendingAssetIds.length,1);
  const old={requestId:'owner-decision',taskId:init.taskId,groups:[{assetIds:init.pendingAssetIds}]};
  await assert.rejects(album.resolve(ctx,old),{code:'SIMULATED_LOST_ACK',taskId:init.taskId});
  assert.equal(album.getTask(ctx,init.taskId).status,'awaiting_receipt');
  assert.equal(album.getTask(ctx,init.taskId).receipts.length,0);
  assert.equal(catalog.list(ctx).length,1);const original=catalog.list(ctx)[0];
  const outboxId=db.prepare('SELECT id FROM alb_send').get().id;
  db.close();db=null;

  other=await server(dir,'other-shop');
  assert.equal((await other.call('/api/retry',{requestId:'restore1',taskId:init.taskId}))[0],404);
  assert.equal((await other.call('/api/tasks/'+init.taskId))[0],404);
  await other.close();other=null;
  owner=await server(dir,ctx.shopId);
  const [,pageTask]=await owner.call('/api/tasks/'+init.taskId);
  assert.equal(pageTask.handoffs.filter(h=>h.status==='awaiting_receipt').length,1);
  // The old FileList, requestId, asset selection and product ID are unknown to the new page.
  const minimal={requestId:'restore1',taskId:pageTask.taskId};
  assert.equal((await owner.call('/api/retry',{...minimal,groupId:'do-not-trust'}))[0],400);
  const [a,b]=await Promise.all([owner.call('/api/retry',minimal),owner.call('/api/retry',minimal)]);
  assert.deepEqual(a,b);assert.equal(a[0],200);
  const task=a[1];assert.equal(task.receipts.length,1);
  assert.equal(task.status,'finished');assert.equal(task.receipts[0].requestId,outboxId);assert.equal(task.receipts[0].productId,original.productId);
  const [code,reclicked]=await owner.call('/api/retry',{...minimal,requestId:'other-click'});
  assert.equal(code,200);assert.deepEqual(reclicked.receipts,task.receipts);
  assert.deepEqual((await owner.call('/api/cards'))[1],[original]);
  await owner.close();owner=null;
  db=new DatabaseSync(database);
  for(const table of ['catalog_products','catalog_product_assets','catalog_receipts','alb_send']){
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,1,table+' should have exactly one business row');
  }
  assert.equal(db.prepare('SELECT receipt IS NOT NULL AS recovered FROM alb_send').get().recovered,1);
 }finally{
  if(owner)await owner.close();if(other)await other.close();if(db)db.close();
  for(const suffix of ['','-wal','-shm','-journal'])if(existsSync(database+suffix))unlinkSync(database+suffix);
  rmdirSync(dir);
 }
});
