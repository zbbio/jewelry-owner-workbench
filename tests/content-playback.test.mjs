import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createContent} from '../content/index.mjs';
import {makeSyntheticMedia} from './synthetic-media.mjs';
let host,mediaRoot;
before(()=>{host=fs.mkdtempSync(path.join(os.tmpdir(),'owner-content-n1-'));mediaRoot=path.join(host,'media');makeSyntheticMedia(mediaRoot);});
after(()=>{if(host)fs.rmSync(host,{recursive:true,force:true});});
const ctx={shopId:'A',actorId:'owner'}, req={requestId:'1',productId:'card',productVersion:3,demand:'看视频'};
const baseAsset={kind:'product_shot',assetId:'synthetic',digest:'fixture',productId:'card',shopId:'A',rights:'usable'};
function setup(t) {
  const tmp=fs.mkdtempSync(path.join(host,'test-'));
  const data={version:3,records:[],assets:[{...baseAsset}],read:true};
  let db, service;
  function open(extra={}) {
    db=new DatabaseSync(path.join(tmp,'content.sqlite'));
    service=createContent({db,getProduct:(ctx,id)=>ctx.shopId==='A' && data.read && id==='card'?{shopId:'A',productId:id,productVersion:data.version}:null,
      listOldVideos:()=>data.records, resolveInputs:()=>({assets:data.assets,copyId:'C',copyVersion:1,preferenceSnapshot:{},preferenceVersion:1}),
      probeVideo:v=>v.ok===true,...extra});return service;
  }
  t.after(()=>{if(db?.isOpen)db.close();fs.rmSync(tmp,{recursive:true,force:true});});
  return {data,open,close:()=>db.close(),sql:()=>db};
}
test('seed-1 independent: v3 queued receipt immutable; v4 live task after SQLite reopen requires review',t=>{
  const f=setup(t);let svc=f.open(), receipt=svc.requestVideo(ctx,req);assert.equal(receipt.outcome,'queued');
  f.close();f.data.version=4;svc=f.open();
  assert.deepEqual(svc.requestVideo(ctx,req),receipt);
  const task=svc.getTask(ctx,receipt.taskId);assert.equal(task.productVersion,3);assert.equal(task.status,'needs_review');assert.equal(task.currentProductVersion,4);assert.equal(task.recordedStatus,'queued');
  assert.equal(svc.requestVideo(ctx,{...req,requestId:'2'}).outcome,'needs_review');
  assert.equal(f.sql().prepare('select count(*) as n from content_tasks').get().n,1);
  f.data.read=false;assert.throws(()=>svc.getTask(ctx,receipt.taskId),e=>e.code==='TASK_NOT_FOUND');
});
test('old clip withdrawn after receipt: replay gives no usable reference; immutable history preserved',t=>{
  const f=setup(t),svc=f.open(),v={workId:'W',workVersion:1,productId:'card',shopId:'A',rights:'usable',ok:true};
  f.data.records=[v];const history=svc.requestVideo(ctx,req);
  assert.equal(history.outcome,'existing_available');v.withdrawn=true;
  const now=svc.requestVideo(ctx,req);assert.equal(now.outcome,'needs_review');assert.equal(now.workRef,undefined);
  assert.deepEqual(JSON.parse(f.sql().prepare('select receipt_json from content_requests').get().receipt_json),history);
});
import {createLocalVideoStore} from '../content/local-video.mjs';
const clip=()=>({workId:'W',workVersion:7,productId:'card',shopId:'A',rights:'usable',mediaKey:'valid.mp4',mediaSha256:createHash('sha256').update(fs.readFileSync(path.join(mediaRoot,'valid.mp4'))).digest('hex')});
test('real synthetic image MP4: eight H264 frames; corrupt payload, truncated, non-video and remote keys closed',()=>{
  const store=createLocalVideoStore(mediaRoot), playable=store.readPlayable('valid.mp4');
  assert.equal(playable.frames,8);assert.equal(playable.durationSeconds,1);assert.equal(playable.codec,'h264');
  assert.deepEqual(playable.bytes,fs.readFileSync(path.join(mediaRoot,'valid.mp4')));
  for(const key of ['corrupt.mp4','truncated.mp4','text.mp4','missing.mp4','https://test.invalid/x.mp4','../valid.mp4','file:///outside.mp4','\\\\server\\share\\clip.mp4','CON.mp4'])assert.equal(store.readPlayable(key),null,key);
});
test('exact retrieval revalidates shop, product, work version, rights and bytes; same request never queues again',t=>{
  const f=setup(t),svc=f.open({mediaRoot}),v=clip();
  const ref={productId:'card',workId:'W',workVersion:7};f.data.records=[v];
  assert.equal(svc.requestVideo(ctx,req).outcome,'existing_available');
  assert.equal(svc.openOldVideo(ctx,ref).frames,8);
  const reject=(ctx2=ctx,ref2=ref)=>assert.throws(()=>svc.openOldVideo(ctx2,ref2),e=>e.code==='WORK_NOT_AVAILABLE');
  reject({...ctx,shopId:'B'});reject(ctx,{...ref,productId:'else'});reject(ctx,{...ref,workVersion:8});
  for(const [field,bad] of [['rights','unknown'],['withdrawn',true],['shopId',undefined],['shopId','B'],['productId','else'],['mediaSha256',undefined],['mediaSha256','a'.repeat(64)],['mediaKey','https://no.invalid/xx.mp4'],['mediaKey','truncated.mp4']]){
    f.data.records=[{...v,[field]:bad}];reject();assert.equal(svc.requestVideo(ctx,req).outcome,'needs_review');
  }
  assert.equal(f.sql().prepare('select count(*) n from content_tasks').get().n,0);
  f.data.records=[v];assert.equal(svc.openOldVideo(ctx,ref).sha256,svc.openOldVideo(ctx,ref).sha256);
  f.data.read=false;reject();
});
test('foreign or withdrawn production source never enters queue; queued request replay immutable and conflicting body stops',t=>{
  const f=setup(t),svc=f.open({mediaRoot});
  for(const [k,val] of [['shopId','B'],['withdrawn',true],['rights','unknown']]){
    f.data.assets=[{...baseAsset,[k]:val}];assert.equal(svc.requestVideo(ctx,{...req,requestId:k}).outcome,'needs_review');
  }
  f.data.assets=[baseAsset];const a=svc.requestVideo(ctx,req);assert.equal(a.outcome,'queued');assert.deepEqual(svc.requestVideo(ctx,req),a);
  assert.throws(()=>svc.requestVideo(ctx,{...req,demand:'换文案'}),e=>e.code==='REQUEST_BODY_CONFLICT');
  assert.equal(f.sql().prepare('select count(*) n from content_tasks').get().n,1);
});
