import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createLocalPixelVision} from './pixel-vision.mjs';
import {createProductRead} from './product-read.mjs';

const ctx={shopId:'own-shop',actorId:'owner'};
const sha=x=>createHash('sha256').update(x).digest('hex');
const req=(assetId,bytes)=>({batchId:'dev-batch',assetId,sha256:sha(bytes)});
const py=process.env.N22_TEST_PYTHON??(process.platform==='win32'?'python':'python3');
test('pixel subprocess receives bytes only; identical image under distinct IDs yields identical geometry',{timeout:40000},async()=>{
  const result=spawnSync(py,['-I','-B',fileURLToPath(new URL('./pixel-dev-fixtures.py',import.meta.url))],{encoding:'utf8'});
  assert.equal(result.status,0);
  const [ring,beads]=JSON.parse(result.stdout).map(x=>Buffer.from(x,'base64'));
  const broken=Buffer.from('invalid png');
  const map={random_1:ring,other_key:ring,random_2:beads,broken};
  const pixel=await createLocalPixelVision({python:py,readAuthorizedAsset:(c,b,a)=>
    c.shopId===ctx.shopId&&b==='dev-batch'&&map[a]?{bytes:map[a],mime:'image/png'}:null});
  assert.equal(pixel.status.mounted,true);
  const a=await pixel.readVision(ctx,req('random_1',ring));
  const b=await pixel.readVision(ctx,req('other_key',ring));
  const c=await pixel.readVision(ctx,req('random_2',beads));
  assert.equal(a.category,'bangle');assert.equal(c.category,'bracelet');
  assert.deepEqual(a.features,b.features);assert.equal(a.reason,b.reason);assert.equal(a.category,b.category);
  assert.notEqual(a.category,c.category);
  assert.equal(await pixel.readVision({...ctx,shopId:'another-shop'},req('random_1',ring)),null);
  assert.equal(await pixel.readVision(ctx,req('random_1',beads)),null);
  const invalid=await pixel.readVision(ctx,req('broken',broken));
  assert.equal(invalid.category,null);assert.equal(invalid.decoded,false);assert.equal(invalid.reason,'PIXEL_DECODE_REJECTED');
});
test('pixel provenance is kept separate; conflict abstains and a genuine human confirmation wins',async()=>{
  const batchId='dev-batch', assetId='dev-photo', sha256='f'.repeat(64);
  const scope={shopId:ctx.shopId,batchId,assetId,sha256,evidenceRef:'fixture-ref'};
  const reader=human=>createProductRead({catalog:{list:()=>[],getSummary:()=>null},
    readAuthorizedBatch:()=>({shopId:ctx.shopId,batchId,assets:[{assetId,sha256,status:'kept'}]}),
    readLabel:()=>({...scope,category:'手串',matched:true}),
    readVision:()=>({...scope,category:'bangle',decoded:true,confidence:'heuristic_strong',analysisKind:'pixel_rule',
      ruleId:'local-shape',ruleVersion:'1.0.0',reason:'PIXEL_SMOOTH_CLOSED_RIM',features:{}}),
    readHuman:()=>human?{...scope,category:'吊坠',confirmed:true}:null});
  const input={requestId:'dev-req',messageId:'dev-msg',batchId};
  const first=(await reader(false).classify(ctx,input)).items[0];
  assert.equal(first.status,'pending');assert.equal(first.reason,'EVIDENCE_DISAGREES');
  assert.equal(first.evidence.pixelRule.category,'bangle');assert.equal(first.evidence.originalLabel.category,'bracelet');
  assert.equal(first.evidence.imageInference,null);
  const confirmed=(await reader(true).classify(ctx,input)).items[0];
  assert.equal(confirmed.category,'pendant');assert.equal(confirmed.source,'human');
  assert.equal(confirmed.evidence.pixelRule.category,'bangle');assert.equal(confirmed.evidence.originalLabel.category,'bracelet');
});
