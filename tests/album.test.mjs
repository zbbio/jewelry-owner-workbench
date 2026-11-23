import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID as uid} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {createAlbum} from '../album/index.mjs';

const gen=String.raw`
from PIL import Image
import sys,struct,io,numpy as np
def send(im):
    f=io.BytesIO();im.save(f,"PNG");b=f.getvalue();sys.stdout.buffer.write(struct.pack(">I",len(b))+b)
def texture(seed):
    a=np.random.default_rng(seed).integers(25,165,(62,82,3),dtype=np.uint8)
    return Image.fromarray(a).resize((300,218),Image.Resampling.BICUBIC)
def shot(seed,angle):
    im=Image.new("RGB",(440,370),"white");im.paste(texture(seed),(70,76))
    return im.rotate(angle,Image.Resampling.BICUBIC,fillcolor="white")
for seed,angle in [(137,0),(961,0),(137,14),(961,-16),(137,-9),(961,8)]: send(shot(seed,angle))
send(Image.new("RGB",(90,90),"gray"))
for seed in (21,56):
    bg=texture(27).resize((440,370));bg.paste(texture(seed),(70,76));send(bg)
`;
const stream=execFileSync(process.env.ALBUM_PYTHON||'python',['-B','-c',gen],{maxBuffer:8<<20,windowsHide:true});
const images=[];for(let i=0;i<stream.length;){const n=stream.readUInt32BE(i);i+=4;images.push(stream.subarray(i,i+n));i+=n}
const ctx={shopId:uid(),actorId:uid()}, other={shopId:uid(),actorId:uid()};
const files=(...ii)=>ii.map(i=>({bytes:images[i]}));
function fixture(db=new DatabaseSync(':memory:')){
  let album,once=false,conflict=false;
  const cards=new Map(),byReq=new Map(),groups=new Map(),calls=[];
  const catalog={
    get:(c,p)=>cards.get(p)?.shop===c.shopId?structuredClone(cards.get(p)):null,
    list:c=>[...cards.values()].filter(p=>p.shop===c.shopId).map(x=>structuredClone(x)),
    async acceptGroup(c,b){
      calls.push(structuredClone(b));
      const keys=['requestId','taskId','groupId','groupVersion','keptAssetIds','decisionSource','evidenceRef'];
      if(b.targetProductId)keys.push('targetProductId','expectedVersion');
      assert.deepEqual(Object.keys(b).sort(),keys.sort());
      assert.ok(b.keptAssetIds.every(a=>album.hasAsset(c,a)));
      const key=JSON.stringify([c.shopId,b.requestId]);
      if(byReq.has(key)){const [body,reply]=byReq.get(key);assert.deepEqual(b,body);return reply}
      const old=b.targetProductId&&catalog.get(c,b.targetProductId);
      if(conflict||(b.targetProductId&&b.expectedVersion!==old?.productVersion)){
        conflict=false;throw Object.assign(new Error('conflict'),{code:'version_conflict',httpStatus:409})}
      const prev=groups.get(b.groupId);assert.equal(b.groupVersion,(prev?.groupVersion||0)+1);
      if(prev)assert.ok(prev.keptAssetIds.every(i=>b.keptAssetIds.includes(i)));
      const p=old||{shop:c.shopId,productId:uid(),productVersion:0,assetIds:[]};
      const added=b.keptAssetIds.filter(x=>!p.assetIds.includes(x));p.assetIds.push(...added);
      if(added.length)p.productVersion++;cards.set(p.productId,p);groups.set(b.groupId,b);
      const reply={status:'committed',requestId:b.requestId,taskId:b.taskId,groupId:b.groupId,groupVersion:b.groupVersion,
        productId:p.productId,productVersion:p.productVersion,linkedAssetIds:[...p.assetIds],addedAssetIds:added,
        outcome:!old?'created':added.length?'images_added':'unchanged'};
      byReq.set(key,[structuredClone(b),reply]);
      if(once){once=false;throw Object.assign(new Error('ack lost'),{code:'transport_timeout',httpStatus:503})}
      return reply;
    }
  };
  function reopen(next=db){db=next;album=createAlbum({db,catalog});return album}
  reopen();return {get a(){return album},calls,cards,db,reopen,lose:()=>{once=true},race:()=>{conflict=true}};
}

test('automatic grouping, partial failure, exact originals, scoped replay and both supplement paths',async()=>{
  const f=fixture();try{
    const req={requestId:uid(),files:[...files(1,0,3,2,0,6),{bytes:Buffer.from('invalid')}]};
    const [t,replay]=await Promise.all([f.a.importBatch(ctx,req),f.a.importBatch(ctx,req)]);
    assert.deepEqual(t,replay);assert.equal(t.receipts.length,2);assert.equal(f.cards.size,2);
    const [b,a,b2,a2,dup,unc,bad]=t.items;
    assert.equal(dup.duplicateOf,a.assetId);assert.equal(dup.assetId,undefined);assert.equal(bad.status,'failed');
    assert.deepEqual(t.pendingAssetIds,[unc.assetId]);assert.equal(t.pendingTask.parentTaskId,t.taskId);
    assert.equal(f.a.getTask(ctx,t.pendingTask.taskId).parentTaskId,t.taskId);
    const got=(x,y)=>t.receipts.find(r=>r.linkedAssetIds.length===2&&[x,y].every(i=>r.linkedAssetIds.includes(i.assetId)));
    const A=got(a,a2),B=got(b,b2);assert.ok(A&&B&&A.productId!==B.productId);
    assert.equal(f.a.readAsset(ctx,a.assetId).mime,'image/png');assert.deepEqual(f.a.readAsset(ctx,a.assetId).bytes,images[0]);
    assert.equal(f.a.getTask(other,t.taskId),null);assert.equal(f.a.readAsset(other,a.assetId),null);
    assert.equal(f.a.hasAsset(other,a.assetId),false);assert.deepEqual(f.a.listTasks(other),[]);
    await assert.rejects(f.a.importBatch(ctx,{...req,files:files(0)}),{code:'idempotency_conflict'});
    const s=await f.a.importBatch(ctx,{requestId:uid(),files:files(4),targetProductId:A.productId,expectedVersion:1});
    const m=await f.a.importBatch(ctx,{requestId:uid(),files:files(5)});
    for(const [r,old] of [[s.receipts[0],A],[m.receipts[0],B]]){
      assert.equal(r.groupId,old.groupId);assert.equal(r.groupVersion,2);assert.equal(r.productId,old.productId);
      assert.equal(r.productVersion,2);assert.equal(r.linkedAssetIds.length,3);assert.equal(r.addedAssetIds.length,1);
    }
    assert.equal(f.calls.at(-1).decisionSource,'system_checked');assert.equal(f.cards.size,2);
    await assert.rejects(f.a.importBatch(ctx,{requestId:uid(),files:files(4),targetProductId:A.productId,expectedVersion:1}),{code:'version_conflict'});
    const replay2=await f.reopen().importBatch(ctx,req);assert.deepEqual(replay2,t);
    const again=await f.a.importBatch(ctx,{requestId:uid(),files:files(4,5)});assert.equal(again.receipts.length,0);
    assert.ok(again.items.every(i=>i.status==='duplicate'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM alb_asset').get().n,7);
    const separated=await f.a.importBatch(other,{requestId:req.requestId,files:files(0)});
    assert.notEqual(separated.items[0].assetId,a.assetId);
  }finally{f.db.close()}
});

test('shared background is not identity; scope, race, manual confirmation and uncertain commit recovery',async()=>{
  const f=fixture();try{
    const t=await f.a.importBatch(ctx,{requestId:uid(),files:files(7,8)});assert.equal(t.receipts.length,0);
    assert.equal(t.pendingAssetIds.length,2);const [a,b]=t.pendingAssetIds;
    const req={requestId:uid(),taskId:t.pendingTask.taskId,groups:[{assetIds:[a]}]};
    await assert.rejects(f.a.resolve(other,req),{code:'not_found'});
    f.lose();await assert.rejects(f.a.resolve(ctx,req),{code:'transport_timeout'});
    assert.equal(f.cards.size,1);assert.equal(f.a.getTask(ctx,t.taskId).receipts.length,0);
    const v=await f.reopen().resolve(ctx,req),r=v.receipts[0];assert.equal(r.outcome,'created');
    assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.calls[0].taskId,t.taskId);
    assert.equal(f.calls[0].decisionSource,'owner_confirmed');assert.ok(f.calls[0].evidenceRef);
    assert.deepEqual(v.pendingAssetIds,[b]);assert.deepEqual(await f.a.resolve(ctx,req),v);
    const attach={assetIds:[b],targetProductId:r.productId,expectedVersion:r.productVersion};
    f.race();await assert.rejects(f.a.resolve(ctx,{requestId:uid(),taskId:t.taskId,groups:[attach]}),{code:'version_conflict'});
    assert.deepEqual(f.a.getTask(ctx,t.taskId).pendingAssetIds,[b]);
    const done=await f.a.resolve(ctx,{requestId:uid(),taskId:t.taskId,groups:[attach]});
    assert.deepEqual(done.pendingAssetIds,[]);assert.equal(done.receipts.at(-1).groupId,r.groupId);
    assert.equal(f.a.listTasks(ctx).filter(x=>x.kind==='group_review').length,0);
    await assert.rejects(f.a.resolve(ctx,{...req,requestId:uid()}),{code:'asset_not_pending'});
  }finally{f.db.close()}
});

test('lost import receipt does not block the second group; retry preserves the original outcome',async()=>{
  const f=fixture();try{
    const req={requestId:uid(),files:files(2,1,0,3)};let t;
    f.lose();await assert.rejects(f.a.importBatch(ctx,req),e=>{t=e.taskId;return e.code==='transport_timeout'});
    assert.equal(f.cards.size,2);assert.equal(f.a.getTask(ctx,t).receipts.length,1);
    const recovered=await f.reopen().importBatch(ctx,req);
    assert.equal(recovered.taskId,t);assert.equal(recovered.receipts.length,2);
    assert.ok(recovered.receipts.every(r=>r.outcome==='created'&&r.productVersion===1));
    assert.deepEqual(f.calls[0],f.calls[2]);assert.equal(f.cards.size,2);
  }finally{f.db.close()}
});

test('disk database close/reopen preserves task, bytes and exact import response',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'album-')),path=join(dir,'test.sqlite');
  let db=new DatabaseSync(path);
  try{
    const f=fixture(db),req={requestId:uid(),files:files(6)},t=await f.a.importBatch(ctx,req);
    const choice={requestId:uid(),taskId:t.taskId,groups:[{assetIds:t.pendingAssetIds}]};
    const confirmed=await f.a.resolve(ctx,choice),count=f.calls.length;
    db.close();db=new DatabaseSync(path);f.reopen(db);
    assert.deepEqual(await f.a.importBatch(ctx,req),t);
    assert.deepEqual(await f.a.resolve(ctx,choice),confirmed);assert.equal(f.calls.length,count);
    assert.deepEqual(f.a.getTask(ctx,t.taskId).receipts,confirmed.receipts);
    assert.deepEqual(f.a.getTask(ctx,t.taskId).pendingAssetIds,[]);
    assert.deepEqual(f.a.readAsset(ctx,t.items[0].assetId).bytes,images[6]);
  }finally{db.close();unlinkSync(path);rmdirSync(dir)}
});
