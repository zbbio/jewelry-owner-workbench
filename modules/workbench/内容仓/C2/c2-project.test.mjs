import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareTwoPlans,editPlan,cancelPlans} from '../content/c2-plan-prep.mjs';
import {ctx,material,source,readFixtureAsset} from './fixture.mjs';
import {saveProject,reopenProject} from './project.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));
const project=key=>join(here,'素材补核','原工程回归',run,key);
const run=randomUUID();
const startFiles=()=>readdirSync(here,{recursive:true}).map(String).filter(x=>!x.startsWith('工具锁')&&!x.startsWith('.npm-cache')&&/\.(mp4|mov|webm)$/iu.test(x));

test('C2 two project files, editable captions and timeline, cancellation makes no media',()=>{
 const before=startFiles(), s=source(), draft=prepareTwoPlans(ctx,s,{readApprovedAsset:readFixtureAsset});
 const [tide,sea]=draft.plans;
 const logs=[];
 for(const [key,p] of [['茶桌v1',tide],['海边v1',sea]]){
  logs.push({project:key,...saveProject(project(key),draft,p,material)});
  assert.equal(reopenProject(project(key),{state:draft,plan:p}).plan.planId,p.planId);
  assert.equal(reopenProject(join(here,'工程',key),{state:draft,plan:p,allowLegacy:true}).adoptionInput,'legacy_revalidated');
 }
 const amended=editPlan(ctx,s,draft,{expectedVersion:1,planId:tide.planId,
   shots:tide.shots.toReversed().map((x,i)=>({...x,durationMs:5000,caption:i===0?'改后字幕：先看第三张':'仅隔离图形样片'}))});
 logs.push({project:'茶桌v2',...saveProject(project('茶桌v2'),amended,amended.plans[0],material)});
 const reload=reopenProject(project('茶桌v2'),{state:amended,plan:amended.plans[0]});
 assert.equal(reload.plan.shots[0].assetId,tide.shots.at(-1).assetId);
 assert.equal(reload.plan.shots[0].caption,'改后字幕：先看第三张');assert.equal(reload.plan.planVersion,2);
 const cs=source('fixture-cancel-only'), cd=prepareTwoPlans(ctx,cs,{readApprovedAsset:readFixtureAsset}), canceled=cancelPlans(ctx,cs,cd,{expectedVersion:1});
 assert.equal(canceled.state,'canceled');assert.throws(()=>saveProject(project('取消后不建'),canceled,canceled.plans[0],material));
 writeFileSync(join(here,'素材补核','原工程回归',run,'取消回执.json'),JSON.stringify({draftSetId:canceled.draftSetId,before:cd.state,after:canceled.state,renderCount:0,published:0},null,2)+'\n');
 assert.deepEqual(startFiles(),before);
 console.log('C2_EVIDENCE '+JSON.stringify({projects:logs,initialProjectState:draft.state,editedVersion:amended.version,changedPlanVersion:2,
  captionReload:true,shotOrderReload:true,cancelState:canceled.state,mediaBefore:before.length,mediaAfter:startFiles().length,render:0,quote:0,publish:0}));
});
