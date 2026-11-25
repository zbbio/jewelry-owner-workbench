import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createAlbum} from '../album/index.mjs';
const {createCatalog}=await import(new URL('../catalog/index.mjs',import.meta.url)).catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return import(new URL('../../../../店主工作台/catalog/index.mjs',import.meta.url))});
import {visionCore,recognitionMethod} from '../album/vision.mjs';

const py=process.env.ALBUM_PYTHON||'python';
const fixture=String.raw`
import struct
def material(seed):
    stone=np.random.default_rng(seed).integers(15,163,(43,55),np.uint8)
    t=cv.resize(stone,(252,190),interpolation=cv.INTER_CUBIC)
    return np.uint8(np.stack([t*.72+32,t*.62+51,t*.83+27],axis=2))
def sample(item,angle,operation=None):
    r=material(83921)
    itemtex=material(53192+item)
    y,x=np.indices(r.shape[:2]); zone=((x-67.)/36)**2+((y-117.)/34)**2<1.
    r[zone]=itemtex[zone]
    if operation=="cover": r[zone]=[75,89,82]
    if operation=="relight":r=np.uint8(np.clip(1.07*r+8,0,255))
    pad=np.full((320,400,3),224,np.uint8);pad[65:255,74:326]=r
    T=cv.getRotationMatrix2D((200,160),angle,.97);T[:,2]+=[angle/3,-angle/6]
    pad=cv.warpAffine(pad,T,(400,320),borderValue=(224,224,224))
    buf=io.BytesIO();Image.fromarray(pad).save(buf,"JPEG",quality=90)
    return buf.getvalue()
frames=[sample(i,a) for i,a in [(0,1),(1,-2),(0,16),(1,-17),(0,-11),(1,10)]]+[sample(0,4,"cover"),sample(0,-7,"relight")]
`;
function python(src,input){return execFileSync(py,['-B','-c',src],{input,windowsHide:true,timeout:60000,maxBuffer:8<<20})}
let stream=python('import sys,io\nimport cv2 as cv,numpy as np\nfrom PIL import Image\n'+fixture+String.raw`
for b in frames: sys.stdout.buffer.write(struct.pack(">I",len(b))+b)
`), images=[];
for(let i=0;i<stream.length;){const n=stream.readUInt32BE(i);images.push(stream.subarray(i+4,i+4+n));i+=n+4;}
const toFiles=(...items)=>items.map(i=>({bytes:images[i]})),ctx={shopId:'synthetic',actorId:'owner'};

test('off-centre replaceable stone: rotation, relight, opposite evidence and uncertain occlusion',t=>{
  const got=JSON.parse(python(visionCore+fixture+String.raw`
fs=[inspect(v)["f"] for v in frames]
def pairs():
    tests={"same":(0,2),"relit":(0,7),"different":(0,3),"covered":(0,6)}
    report={k:[compare_detail(fs[i],fs[j]),compare_detail(fs[j],fs[i])] for k,(i,j) in tests.items()}
    report["legacy"]=compare_detail(fs[0][:2],fs[2])
    report["unknown"]=compare_detail([*fs[0][:2],{"v":42}],fs[2])
    report["badEncoding"]=compare_detail([*fs[0][:2],{"v":2,"data":"*"*len(fs[0][2]["data"])}],fs[2])
    report["extraBytes"]=len(json.dumps(fs[0][2]));return report
print(json.dumps(pairs()))
`).toString());
  t.diagnostic(JSON.stringify(got));
  for(const k of ['same','relit'])assert.ok(got[k].every(x=>x[0]===2&&x[3]==='surface_agreement'));
  assert.ok(got.different.every(x=>x[0]===0&&x[3]==='local_surface_conflict'));
  assert.ok(got.covered.every(x=>x[0]!==2));
  for(const k of ['legacy','unknown','badEncoding'])assert.deepEqual([got[k][0],got[k][3]],[1,'missing_current_subject']);
  assert.ok(got.extraBytes<=20000);
});

test('same carrier, two actual card receipts; replay + re-open; existing V1 cards upgraded from originals',async()=>{
  const db=new DatabaseSync(':memory:');let album;
  try{
    const catalog=createCatalog({db,hasAsset:(c,id)=>album.hasAsset(c,id)});
    album=createAlbum({db,catalog});
    const req={requestId:'initial',files:toFiles(3,0,1,2,0)};
    const t=await album.importBatch(ctx,req);
    assert.equal(t.analysis.method,recognitionMethod);assert.deepEqual(t.pendingAssetIds,[]);
    assert.deepEqual(await album.importBatch(ctx,req),t);assert.equal(t.receipts.length,2);
    const cardOf=a=>catalog.list(ctx).find(p=>p.assetIds.includes(a)).productId;
    const a=cardOf(t.items[1].assetId),b=cardOf(t.items[0].assetId);
    assert.notEqual(a,b);assert.equal(cardOf(t.items[3].assetId),a);assert.equal(cardOf(t.items[2].assetId),b);
    assert.ok(t.analysis.pairs.filter(x=>x.reason==='local_surface_conflict').length===4);
    for(const row of db.prepare('select id,f from alb_asset').all()){
      db.prepare('update alb_asset set f=? where id=?').run(JSON.stringify(JSON.parse(row.f).slice(0,2)),row.id);
    }
    album=createAlbum({db,catalog});
    const m=await album.importBatch(ctx,{requestId:'extraA',files:toFiles(4)});
    assert.deepEqual(m.pendingAssetIds,[]);assert.equal(m.analysis.legacyReferences,4);assert.equal(m.analysis.legacyUpgraded,4);
    assert.equal(m.receipts[0].productId,a);
    const n=await album.importBatch(ctx,{requestId:'extraB',files:toFiles(5)});
    assert.equal(n.receipts[0].productId,b);
    assert.ok(catalog.list(ctx).every(p=>p.assetIds.length===3));assert.ok(catalog.list(ctx).length===2);
    assert.deepEqual(await album.importBatch(ctx,req),t);
    // Simulate unrecoverable old feature references. A matching carrier alone
    // must not authorize an attach, even when its geometry used to be strong.
    const before=catalog.list(ctx).map(p=>p.productVersion);
    for(const row of db.prepare('select id,f from alb_asset').all()){
      db.prepare('update alb_asset set f=?,b=? where id=?').run(JSON.stringify(JSON.parse(row.f).slice(0,2)),Buffer.from('damaged-asset'),row.id);
    }
    const bad=await album.importBatch(ctx,{requestId:'oldMissing',files:toFiles(7)});
    assert.equal(bad.analysis.legacyReferences,6);assert.equal(bad.analysis.legacyUpgraded,0);
    assert.equal(bad.pendingAssetIds.length,1);assert.equal(bad.receipts.length,0);
    assert.deepEqual(catalog.list(ctx).map(p=>p.productVersion),before);
  }finally{db.close()}
});

test('a mixed historical card cannot attract a new photo by one good reference when another contradicts it',async()=>{
  const db=new DatabaseSync(':memory:');let album;
  try{
    const catalog=createCatalog({db,hasAsset:(c,id)=>album.hasAsset(c,id)});
    album=createAlbum({db,catalog});
    const t=await album.importBatch(ctx,{requestId:'two-different',files:toFiles(0,1)});
    assert.equal(t.pendingAssetIds.length,2);
    const prior=await album.resolve(ctx,{requestId:'historical-owner-decision',taskId:t.taskId,
      groups:[{assetIds:t.pendingAssetIds}]});
    const receipt=prior.receipts[0];
    const m=await album.importBatch(ctx,{requestId:'new-view',files:toFiles(2)});
    assert.deepEqual(m.analysis.pairs.map(x=>x.level).sort(),[0,2]);
    assert.equal(m.receipts.length,0);assert.equal(m.pendingAssetIds.length,1);
    assert.deepEqual(catalog.get(ctx,receipt.productId).assetIds,receipt.linkedAssetIds);
    assert.equal(catalog.get(ctx,receipt.productId).productVersion,receipt.productVersion);
  }finally{db.close()}
});
