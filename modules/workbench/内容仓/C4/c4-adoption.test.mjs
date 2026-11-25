import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {makeRoom,ctx,ids,initial,edited,confirm,sha} from '../C3/fixture-room.mjs';
import {createAdoption} from './adoption.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));
const receiptRoot=process.env.N22_ASSET_REGRESSION==='1'?join(here,'..','C2','素材补核','C4联验'):here;
const pin=work=>({productId:ids.C,productVersion:1,...work});
const mint=(allowed,work,q)=>{
 const x={...pin(work),requestId:'adopt-'+q,confirmationId:'owner-adopt-'+q};
 allowed.set(x.confirmationId,{...ctx,...x,active:true,purpose:'adopt_selected_work'});return x;
};
const setup=(r,allowed,readWorkPlanProof=r.production.readWorkPlanProof)=>createAdoption({studio:r.studio,
 getProductVersion:(c,p)=>c.shopId===ctx.shopId&&[ids.C,ids.B].includes(p)?1:undefined,
 authorizeAdoption:(c,k)=>c.shopId===ctx.shopId?allowed.get(k):null,readWorkPlanProof});

test('C4 preview exact version, explicit adoption, protect previous approved version, and SQLite reopen',()=>{
 const dir=join(receiptRoot,'证据','fixture-'+randomUUID());mkdirSync(dir,{recursive:true});
 const confirmed=new Map(), allowed=new Map(), observed={render:0};
 let first,second,firstArtifact,secondArtifact,adopted,state0,state1,state2,state3;
 let r=makeRoom(dir,confirmed,{observed});
 try{
  const c4=setup(r,allowed);
  state0=r.count();
  first=r.production.run(ctx,confirm(confirmed,'fixture-render-first',initial()));
  assert.equal(first.workRef.workVersion,1);
  const firstPreview=c4.preview(ctx,pin(first.workRef));
  assert.equal(firstPreview.sha256,first.sha256);assert.equal(r.count().approved,0);
  assert.throws(()=>c4.reopen(ctx,pin(first.workRef)),{code:'WORK_NOT_AVAILABLE'});
  const allow1=mint(allowed,first.workRef,'first');
  c4.adopt(ctx,allow1);
  state1=r.count();assert.deepEqual([state1.approved,state1.files],[1,1]);

  second=r.production.run(ctx,confirm(confirmed,'fixture-render-second',edited()));
  assert.equal(second.workRef.workId,first.workRef.workId);assert.equal(second.workRef.workVersion,2);
  // A pending v2 has not replaced the last approved v1.
  assert.equal(c4.reopen(ctx,pin(first.workRef)).sha256,first.sha256);
  assert.throws(()=>c4.reopen(ctx,pin(second.workRef)),{code:'WORK_NOT_AVAILABLE'});
  assert.throws(()=>c4.preview(ctx,{...pin(second.workRef),productId:ids.B}),{code:'WORK_NOT_AVAILABLE'});
  assert.throws(()=>c4.preview(ctx,{...pin(second.workRef),productVersion:2}),{code:'C4_PRODUCT_VERSION_CHANGED'});
  assert.throws(()=>c4.preview(ctx,{...pin(second.workRef),workVersion:3}),{code:'WORK_NOT_AVAILABLE'});
  const pending=c4.preview(ctx,pin(second.workRef));assert.equal(sha(pending.bytes),second.sha256);
  assert.notEqual(second.sha256,first.sha256);
  const allow2=mint(allowed,second.workRef,'second');
  state2=r.count();assert.deepEqual([state2.approved,state2.files],[1,2]);
  const noPins=setup(r,allowed,(c,x)=>({...r.production.readWorkPlanProof(c,x),assetPinsDigest:null}));
  assert.throws(()=>noPins.preview(ctx,pin(second.workRef)),{code:'C4_WORK_SOURCE_UNVERIFIED'});
  assert.throws(()=>noPins.adopt(ctx,allow2),{code:'C4_WORK_SOURCE_UNVERIFIED'});
  assert.throws(()=>c4.adopt(ctx,{...allow2,workVersion:1}),{code:'C4_ADOPTION_NOT_CONFIRMED'});
  assert.deepEqual(r.count(),state2);
  adopted=c4.adopt(ctx,allow2);assert.equal(adopted.status,'adopted');assert.equal(adopted.deliveryStatus,'not_submitted');
  assert.deepEqual(adopted.workRef,second.workRef);
  assert.deepEqual(c4.adopt(ctx,allow2),adopted);
  state3=r.count();assert.equal(state3.studio_receipts,state2.studio_receipts+1);assert.equal(state3.files,state2.files);
  firstArtifact=r.inspect(first.workRef);secondArtifact=r.inspect(second.workRef);
 }finally{r.close();}
 r=makeRoom(dir,confirmed,{observed});
 try{
  const c4=setup(r,allowed), reopened=c4.reopen(ctx,pin(second.workRef));
  assert.equal(reopened.sha256,secondArtifact.sha256);assert.equal(sha(reopened.bytes),secondArtifact.sha256);
  assert.ok(reopened.bytes.equals(readFileSync(secondArtifact.file)));
  assert.throws(()=>c4.reopen(ctx,pin(first.workRef)),{code:'WORK_NOT_AVAILABLE'});
  assert.throws(()=>c4.reopen(ctx,{...pin(second.workRef),productId:ids.B}),{code:'WORK_NOT_AVAILABLE'});
  assert.throws(()=>c4.reopen({...ctx,shopId:'wrong-shop'},pin(second.workRef)),{code:'C4_PRODUCT_VERSION_CHANGED'});
  const view=r.studio.listWorks(ctx,ids.C);
  assert.deepEqual(view.map(x=>[x.workVersion,x.recordedStatus]),[[2,'approved'],[1,'superseded']]);
  assert.deepEqual(r.count(),state3);assert.equal(observed.render,2);
  const result={module:'C4',scope:'self-owned geometry fixtures only; fixture other item is not original B',before:state0,
   afterFirstAdopt:state1,preSecondAdopt:state2,postSecondAdoptAndRestart:state3,explicitAdopt:adopted,
   artifactV1:firstArtifact,artifactV2:secondArtifact,artifactV1StillRetained:true,previewBytesAndSHA:true,secondPendingDidNotReplaceFirst:true,
   oldPinAfterAdoption:'rejected',crossProduct:'rejected',restartReadIdentical:true,renderInvocations:2,
   unpinnedWorkRejectedBeforeAdoption:true,adoptAddedTasks:0,adoptAddedFiles:0,published:0,paid:0,works:[[2,'approved'],[1,'superseded']]};
  writeFileSync(join(receiptRoot,'模块回执.json'),JSON.stringify(result,null,2)+'\n');console.log('C4_RESULT '+JSON.stringify(result));
 }finally{r.close();}
});
