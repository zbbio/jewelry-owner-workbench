import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {makeRoom,ctx,ids,initial,edited,confirm,sha} from './fixture-room.mjs';
import {cancelPlans} from '../content/c2-plan-prep.mjs';
import {source,readFixtureAsset} from '../C2/fixture.mjs';
import {prepareTwoPlans} from '../content/c2-plan-prep.mjs';
import {reopenProject} from '../C2/project.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));
const receiptRoot=process.env.N22_ASSET_REGRESSION==='1'?join(here,'..','C2','素材补核','C3联验'):here;

test('C3 actual FFmpeg from edited fixture plan; queued restart, committed restart and replay',()=>{
 const folder=join(receiptRoot,'证据','fixture-'+randomUUID());mkdirSync(folder,{recursive:true});
 const confirmations=new Map(), observed={render:0}, plan=edited();
 assert.deepEqual(reopenProject(join(here,'..','C2','工程','茶桌v2'),
   {state:plan,plan:plan.plans[0],allowLegacy:true}).plan,plan.plans[0]);
 const q=confirm(confirmations,'explicit-fixture-confirm-main',plan);
 const swapped=confirm(confirmations,'explicit-fixture-replaced',plan);
 const swappedGrant=confirmations.get(swapped.confirmationId);
 swappedGrant.assets[0].sha256=swappedGrant.assets[1].sha256;
 const cancelSource=source('c3-cancel-only'), beforePlan=prepareTwoPlans(ctx,cancelSource,{readApprovedAsset:readFixtureAsset});
 const cancel=cancelPlans(ctx,cancelSource,beforePlan,{expectedVersion:1});
 const cancelQ=confirm(confirmations,'explicit-fixture-canceled',cancel);
 let r=makeRoom(folder,confirmations,{observed,checkpoint(stage){if(stage==='before_render')throw Error('TEST_AFTER_QUEUE');}});
 let before,queued,rendered,result,after;
 try{
  before=r.count();
  assert.throws(()=>r.production.run(ctx,{...q,confirmationId:'none'}),{code:'C3_CONFIRMATION_NOT_AVAILABLE'});
  assert.throws(()=>r.production.run(ctx,cancelQ),{code:'C2_SET_CANCELED'});
  assert.throws(()=>r.production.run(ctx,{...q,productId:ids.B}),{code:'C3_CONFIRMATION_NOT_AVAILABLE'});
  assert.throws(()=>r.production.run(ctx,swapped),{code:'C3_SOURCE_NOT_APPROVED'});
  assert.deepEqual(r.count(),before);assert.equal(observed.render,0);
  assert.throws(()=>r.production.run(ctx,q),/TEST_AFTER_QUEUE/);
  queued=r.count();assert.deepEqual([queued.content_tasks,queued.studio_works,queued.files],[1,0,0]);
  assert.equal(observed.render,0);
 }finally{r.close();}
 r=makeRoom(folder,confirmations,{observed,checkpoint(stage){if(stage==='after_render')throw Error('TEST_AFTER_COMMIT');}});
 try{
  assert.throws(()=>r.production.run(ctx,q),/TEST_AFTER_COMMIT/);
  rendered=r.count();assert.deepEqual([rendered.content_tasks,rendered.studio_works,rendered.files],[1,1,1]);
  assert.equal(observed.render,1);
 }finally{r.close();}
 r=makeRoom(folder,confirmations,{observed});
 try{
  result=r.production.run(ctx,q);assert.equal(result.status,'awaiting_approval');
  const second=r.production.run(ctx,q);assert.deepEqual(result,second);
  assert.equal(result.planRef.planVersion,2);assert.equal(result.durationSeconds,15);assert.equal(result.frames,180);
  after=r.count();assert.deepEqual(after,rendered);assert.equal(observed.render,1);assert.equal(after.approved,0);
  const item=r.inspect(result.workRef);
  assert.equal(result.sha256,item.sha256);assert.equal(sha(readFileSync(item.file)),item.sha256);
  const probe=spawnSync('ffprobe',['-v','error','-protocol_whitelist','file','-show_entries',
    'stream=codec_name,codec_type,width,height,duration,nb_frames','-of','json',item.file],{encoding:'utf8',timeout:20000,windowsHide:true});
  assert.equal(probe.status,0);const ff=JSON.parse(probe.stdout);assert.equal(ff.streams.length,1);
  assert.deepEqual([ff.streams[0].codec_name,ff.streams[0].codec_type,+ff.streams[0].duration,+ff.streams[0].nb_frames],['h264','video',15,180]);
  // Compare actual decoded frame samples away from text and geometry marks.
  const samples=[];
  for(const second of [1,6,11]){
   const proc=spawnSync('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file','-ss',String(second),'-i',item.file,
     '-map','0:v:0','-frames:v','1','-threads:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{timeout:15000,windowsHide:true,maxBuffer:2*1024*1024});
   assert.equal(proc.status,0);assert.equal(proc.stdout.length,360*640*3);
   samples.push([...proc.stdout.subarray((100*360+30)*3,(100*360+30)*3+3)]);
  }
  const desc=samples.map(rgb=>rgb.indexOf(Math.max(...rgb)));
  assert.deepEqual(desc,[1,2,2]); // fixture source3 green, source2 violet, source1 blue
  assert.ok(samples[1][0]>samples[2][0]+20); // violet and blue differ even with the same dominant channel
  const proof={module:'C3',scope:'self-generated geometry fixture, not shop C/A/B',artifact:item,states:{before,queued,rendered,after},
   confirmedFrozenPlan:result.planRef,result,realRenderInvocations:observed.render,realProbe:ff.streams[0],
   frameSamplesRgb:samples,syntheticFailurePoints:['after queue before rendering','after actual render and Studio commit'],reopenedDbTwice:true,
   recoveredSameTaskAndWork:true,published:0,paid:0};
  writeFileSync(join(receiptRoot,'模块回执.json'),JSON.stringify(proof,null,2)+'\n');console.log('C3_RESULT '+JSON.stringify(proof));
 }finally{r.close();}
});
