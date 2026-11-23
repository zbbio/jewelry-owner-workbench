import {createCatalog} from '../catalog/index.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createAlbum} from '../album/index.mjs';

const ctx={shopId:'testShop',actorId:'testOwner'};
function setup(family){
  const stream=execFileSync(process.env.ALBUM_PYTHON||'python',['-B',
    fileURLToPath(new URL('./draw-test-pieces.py',import.meta.url)),family],{windowsHide:true,timeout:30000,maxBuffer:6<<20});
  const frames=[];
  for(let offset=0;offset<stream.length;){const n=stream.readUInt32BE(offset);offset+=4;assert.ok(n>0&&offset+n<=stream.length);frames.push(stream.subarray(offset,offset+n));offset+=n}
  assert.equal(frames.length,6);
  const db=new DatabaseSync(':memory:');let album;
  const catalog=createCatalog({db,hasAsset:(c,id)=>album.hasAsset(c,id)});
  const reopen=()=>album=createAlbum({db,catalog});reopen();
  const byFrame=new Map(),cards=()=>catalog.list(ctx),cardOf=i=>cards().find(p=>p.assetIds.includes(byFrame.get(i)));
  async function send(order,key){
    const req={requestId:key,files:order.map(i=>({bytes:frames[i]}))};
    const out=await album.importBatch(ctx,req);reopen();
    assert.deepEqual(await album.importBatch(ctx,req),out,'replayed request after reopening must return same receipt');
    assert.equal(out.analysis.note,undefined);
    assert.equal(out.items.filter(x=>x.status==='duplicate').length,order.length-new Set(order).size);
    out.items.forEach((x,j)=>{
      assert.ok(['kept','duplicate'].includes(x.status));
      const id=x.assetId||x.duplicateOf;
      if(byFrame.has(order[j]))assert.equal(id,byFrame.get(order[j]));
      byFrame.set(order[j],id);
    });
    return out;
  }
  return {db,cards,cardOf,byFrame,send,get album(){return album}};
}

test('small off-centre textured pieces: mixed first import yields two correct cards, both later views return to their own card',async()=>{
  const f=setup('tiny_seal');try{
    const first=await f.send([3,0,2,1,0],'mixed');
    assert.equal(first.receipts.length,2);assert.deepEqual(first.pendingAssetIds,[]);assert.equal(f.cards().length,2);
    const a=f.cardOf(0),b=f.cardOf(1);assert.ok(a&&b);assert.notEqual(a.productId,b.productId);
    const groups=[[0,2],[1,3]].map(g=>g.map(i=>f.byFrame.get(i)).sort());
    assert.deepEqual([...a.assetIds].sort(),groups[0]);assert.deepEqual([...b.assetIds].sort(),groups[1]);
    assert.equal(first.analysis.pairs.filter(p=>p.level===2&&p.reason==='subject_internal_agreement').length,2);
    for(const [i,old] of [[4,a],[5,b]]){
      const next=await f.send([i],'extra'+i);
      assert.equal(next.pendingAssetIds.length,0);assert.equal(next.receipts.length,1);assert.equal(next.receipts[0].outcome,'images_added');
      assert.equal(next.receipts[0].productId,old.productId);assert.equal(f.cardOf(i).productId,old.productId);
      assert.equal(next.receipts[0].productVersion,old.productVersion+1);
    }
    assert.deepEqual(f.cards().map(c=>c.assetIds.length),[3,3]);
    assert.equal(f.db.prepare('select count(*) n from alb_asset').get().n,6);
  }finally{f.db.close()}
});

test('uniform twins in one recess: board texture cannot create a card or attract later photos to either confirmed card',async()=>{
  const f=setup('recess_twins');try{
    const first=await f.send([3,0,2,1,0],'mixed');
    assert.equal(first.receipts.length,0);assert.equal(f.cards().length,0);assert.equal(first.pendingAssetIds.length,4);
    assert.equal(first.analysis.pairs.length,6);
    assert.ok(first.analysis.pairs.every(p=>p.level!==2&&p.reason.startsWith('subject_')));
    // These two base cards are deliberately owner-established, never counted as automatic.
    const req={taskId:first.taskId,requestId:'owner-reference',groups:[[0,2],[1,3]].map(g=>({assetIds:g.map(i=>f.byFrame.get(i))}))};
    const confirmed=await f.album.resolve(ctx,req);
    assert.deepEqual(await f.album.resolve(ctx,req),confirmed);assert.equal(confirmed.receipts.length,2);
    const original=f.cards();assert.equal(original.length,2);
    for(const i of [4,5]){
      const extra=await f.send([i],'extra'+i);
      assert.equal(extra.receipts.length,0);assert.deepEqual(extra.pendingAssetIds,[f.byFrame.get(i)]);
      assert.equal(f.cardOf(i),undefined);assert.deepEqual(f.cards(),original);
    }
    assert.equal(f.db.prepare('select count(*) n from alb_asset').get().n,6);
  }finally{f.db.close()}
});
