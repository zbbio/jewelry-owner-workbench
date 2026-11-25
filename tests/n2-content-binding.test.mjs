// Portable suite: generate two small PNGs by default. The optional project QA uses the first-order
// (not blind) engineering photos, pinned below. Never package the merchant's images.
// Real album bytes and catalog links; the rights register, copy and preferences are fixtures.
import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createCatalog} from '../catalog/index.mjs';
import {createAlbum} from '../album/index.mjs';
import {createContent} from '../content/index.mjs';

const owner={shopId:'sample-shop',actorId:'fixture-owner'}, other={shopId:'outside',actorId:'other'};
const zip=process.env.N2_CONTENT_SAMPLE_ZIP;
const originalHashes=['ccdb68f6b95283474aff04b19c55d9180423e900bf753cb47287a05c69c5290a','6a1df717315f1e9a97b51a938edf19a1f600d577e2ae91a4fd440c20813d0608'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let sourceDb,album,catalog,A,B;
before(async()=>{
  const files=originalHashes.map((h,i)=>{
    if(!zip){
      const bytes=execFileSync(process.env.ALBUM_PYTHON||'python',['-B','-c',`import io,sys
from PIL import Image,ImageDraw
im=Image.new("RGB",(80,80),"white")
ImageDraw.Draw(im).ellipse((12,12,68,68),outline=(65,115,140+int(sys.argv[1])*20),width=8)
buf=io.BytesIO();im.save(buf,format="PNG");sys.stdout.buffer.write(buf.getvalue())`,String(i)],{windowsHide:true});
      return {bytes};
    }
    const name=`0${i+1}.jpg`;
    const raw=execFileSync(process.env.ALBUM_PYTHON||'python',['-B','-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 names=[n for n in z.namelist() if n.split('/')[-1]==sys.argv[2]]
 assert len(names)==1
 sys.stdout.buffer.write(z.read(names[0]))`,zip,name],{windowsHide:true,encoding:'buffer'});
    assert.equal(sha(raw),h);return {bytes:raw};
  });
  console.log(zip?'inputs: first-order real JPEG x2 (pinned bytes; existing regression only)':'inputs: program-generated PNG x2 (portable; no files required)');
  sourceDb=new DatabaseSync(':memory:');catalog=createCatalog({db:sourceDb,hasAsset:(s,id)=>album.hasAsset(s,id)});
  album=createAlbum({db:sourceDb,catalog});
  const input=await album.importBatch(owner,{requestId:'old-seed-import',files});
  assert.equal(input.items.length,2);assert.ok(input.items.every(i=>i.status==='kept'));
  // Reuse the owner's already known separation; not a new recognition or blind result.
  await album.resolve(owner,{requestId:'owner-separate-known-pair',taskId:input.taskId,groups:input.items.map(i=>({assetIds:[i.assetId]}))});
  [A,B]=input.items.map(({assetId},i)=>{
    const p=catalog.list(owner).find(p=>p.assetIds.includes(assetId));
    const digest=sha(files[i].bytes);assert.deepEqual(p.assetIds,[assetId]);assert.equal(sha(album.readAsset(owner,assetId).bytes),digest);
    assert.equal(album.readAsset(other,assetId),null);return {id:p.productId,shot:assetId,hash:digest,version:p.productVersion};
  });assert.notEqual(A.id,B.id);
});
after(()=>sourceDb?.close());

function setup(t,view='get',tune={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const reg=new Map([A,B].map(x=>[x.shot,{kind:'product_shot',rights:'usable',withdrawn:false}]));
  const plan={assets:[]};
  const opts={db,getProduct:catalog[view],listOldVideos:()=>[],probeVideo:()=>false,
    resolveInputs:()=>({assets:plan.assets,copyId:'fixture-copy',copyVersion:1,preferenceSnapshot:{style:'fixture'},preferenceVersion:1}),
    readSourceState:(ctx,id)=>{
      const raw=album.readAsset(ctx,id),rights=reg.get(id);
      return raw && rights ? {assetId:id,shopId:ctx.shopId,digest:sha(raw.bytes),...rights} : null;
    },...tune};
  const c=createContent(opts), ask=(x,r)=>c.requestVideo(owner,{requestId:r,productId:x.id,productVersion:x.version,demand:'看看这条手串的实拍视频'});
  const shot=(actual,label=A)=>({kind:'product_shot',shopId:owner.shopId,productId:label.id,assetId:actual.shot,digest:actual.hash,rights:'usable'});
  const count=()=>db.prepare('select count(*) n from content_tasks').get().n;
  return {c,db,reg,plan,shot,ask,count,opts};
}
function blocked(r,why){assert.equal(r.outcome,why);assert.equal(r.deliveryStatus,'not_submitted');assert.ok(!r.workRef&&!r.taskId);}
for(const view of ['get','getSummary']){
  test(`catalog.${view}: B actual source mislabeled A (alone or mixed with A) never queues`,t=>{
    const {plan,shot,ask,count}=setup(t,view,{readSourceState:undefined});
    for(const [r,candidates] of [['foreign',[shot(B)]],['mixed',[shot(A),shot(B)]]]){
      plan.assets=candidates;blocked(ask(A,r),'needs_review');assert.equal(count(),0);
    }
  });
  test(`catalog.${view}: confirmed A and B only lock their own real bytes; replay only one task per card`,t=>{
    const {plan,shot,ask,c,count}=setup(t,view);
    for(const x of [A,B]){
      plan.assets=[shot(x,x)];const receipt=ask(x,'queue-'+x.id);assert.equal(receipt.outcome,'queued');
      assert.deepEqual(ask(x,'queue-'+x.id),receipt);assert.ok(!receipt.workRef);assert.equal(receipt.deliveryStatus,'not_submitted');
      const task=c.getTask(owner,receipt.taskId);assert.equal(task.status,'queued');assert.equal(task.productId,x.id);
      assert.deepEqual(task.lockedInputs.assets.map(a=>[a.assetId,a.digest]),[[x.shot,sha(album.readAsset(owner,x.shot).bytes)]]);
    }assert.equal(count(),2);
  });
}
test('no shot, style reference only, or explicitly other product: prompt for a shot; no task',t=>{
  const {plan,shot,ask,count}=setup(t);
  for(const [r,as] of [['none',[]],['style',[{...shot(B),kind:'style_reference'}]],['other',[shot(B,B)]]]){
    plan.assets=as;blocked(ask(A,r),'needs_source');
  }assert.equal(count(),0);
});
test('real membership list captured separately from a resolver that accidentally mutates its card',t=>{
  const f=setup(t,'get',{readSourceState:undefined,resolveInputs:(ctx,p)=>{
    p.assetIds.push(B.shot);return {assets:[f.shot(B)],copyId:'C',copyVersion:1,preferenceSnapshot:{},preferenceVersion:1};
  }});blocked(f.ask(A,'resolver-mutated-input'),'needs_review');assert.equal(f.count(),0);
});
test('configured live source lookup: neither wrong file digest nor foreign source relabeled style can enter the queue',t=>{
  const {plan,shot,ask,count}=setup(t);
  for(const [r,as] of [['hash',[{...shot(A),digest:B.hash}]],['style-hide',[shot(A),{...shot(B),kind:'style_reference'}]]]){
    plan.assets=as;blocked(ask(A,r),'needs_review');
  }assert.equal(count(),0);
});
test('configured lookup with no authoritative card membership: never infer membership from a self-label',t=>{
  const f=setup(t,'get',{getProduct:(ctx,id)=>ctx.shopId===owner.shopId?{productId:id,productVersion:1}:null});
  f.plan.assets=[f.shot(B)];blocked(f.ask(A,'absent-list'),'needs_review');assert.equal(f.count(),0);
});
test('authoritative projection explicitly empty/invalid/disagreeing is not an old adapter without a list',t=>{
  for(const extra of [{assetRefs:[]},{assetIds:null},{assetIds:[A.shot],assetRefs:[{assetId:B.shot}]}]){
    const f=setup(t,'get',{readSourceState:undefined,getProduct:()=>({productId:A.id,productVersion:1,...extra})});
    f.plan.assets=[f.shot(A)];blocked(f.ask(A,'bad-projection'),'needs_review');assert.equal(f.count(),0);
  }
});
test('withdrawn, missing or restricted live reference on same card version: history preserved; no actionable inputs',t=>{
  const {plan,shot,ask,reg,c,db,count}=setup(t);plan.assets=[shot(A)];
  const first=ask(A,'granted');assert.equal(first.outcome,'queued');const prior={...reg.get(A.shot)};
  for(const [r,changes] of [['withdraw',{withdrawn:true}],['unknown',{rights:'unknown'}],['missing',null]]){
    if(changes)reg.set(A.shot,{...prior,...changes});else reg.delete(A.shot);
    blocked(ask(A,r),'needs_review');const task=c.getTask(owner,first.taskId);
    assert.equal(task.status,'needs_review');assert.equal(task.recordedStatus,'queued');assert.equal(task.lockedInputs,undefined);
    assert.deepEqual(ask(A,'granted'),first);assert.equal(count(),1);
    assert.deepEqual(JSON.parse(db.prepare('select locked_json from content_tasks where task_id=?').get(first.taskId).locked_json).assets,[shot(A)]);
  }
});
test('off-card secondary asset is not a verified background just because the resolver renamed it',t=>{
  const f=setup(t,'get',{readSourceState:undefined});
  f.plan.assets=[f.shot(A),{...f.shot(B),kind:'style_reference'}];
  blocked(f.ask(A,'no-style-evidence'),'needs_review');assert.equal(f.count(),0);
});
test('independently licensed background may supplement A, never stand in for its missing real shot',t=>{
  const f=setup(t), scene={assetId:'shared-scene',kind:'background',digest:sha(Buffer.from('independent background fixture')),
    rights:'usable',shopId:owner.shopId,withdrawn:false};
  const service=createContent({...f.opts,readSourceState:(ctx,id)=>id===scene.assetId?scene:f.opts.readSourceState(ctx,id)});
  const ask=requestId=>service.requestVideo(owner,{requestId,productId:A.id,productVersion:A.version,demand:'本件镜头和背景'});
  const planned={...scene,productId:A.id};
  f.plan.assets=[planned];blocked(ask('only-background'),'needs_source');
  f.plan.assets=[f.shot(A),planned];const r=ask('with-real-A');assert.equal(r.outcome,'queued');
  assert.deepEqual(service.getTask(owner,r.taskId).lockedInputs.assets,f.plan.assets);assert.equal(f.count(),1);
});
test('reopening an existing queued task with a weaker registry or card projection never restores usage',t=>{
  for(const strict of [true,false]){
    const f=setup(t,'get',strict?{}:{readSourceState:undefined});
    f.plan.assets=[f.shot(A)];const queued=f.ask(A,'strong');assert.equal(queued.outcome,'queued');
    const weakened=createContent({...f.opts,readSourceState:undefined,...(!strict?{getProduct:()=>({productId:A.id,productVersion:A.version})}:{})});
    const task=weakened.getTask(owner,queued.taskId);assert.equal(task.status,'needs_review');
    assert.equal(task.recordedStatus,'queued');assert.equal(task.lockedInputs,undefined);assert.equal(f.count(),1);
  }
});
