import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createStudio} from './studio-work-copy.mjs';
import {createPlanProduction} from './production.mjs';
import {renderConfirmedPlan} from './render-plan.mjs';
import {ctx,ids,material,source,sha,readFixtureAsset} from '../C2/fixture.mjs';
import {prepareTwoPlans,editPlan} from '../content/c2-plan-prep.mjs';
import {createPlanVersionStore} from '../C2/plan-version-store.mjs';

export {ctx,ids,sha};
const authorizedDrafts=new WeakMap();
export const initial=()=>prepareTwoPlans(ctx,source(),{readApprovedAsset:readFixtureAsset});
export const edited=()=>{
 const draft=initial(), p=draft.plans[0];
 return editPlan(ctx,source(),draft,{expectedVersion:1,planId:p.planId,shots:p.shots.toReversed().map((x,i)=>({...x,durationMs:5000,
   caption:i===0?'改后字幕：先看第三张':'仅隔离图形样片'}))});
};
export function confirm(table,confirmationId,draft,which=0){
 const q={confirmationId,productId:ids.C,productVersion:1,draftSetId:draft.draftSetId,
  draftSetVersion:draft.version,planId:draft.plans[which].planId,planVersion:draft.plans[which].planVersion};
 table.set(confirmationId,{...ctx,...q,currentProductVersion:1,active:true,purpose:'render_selected_plan',draftSet:draft,
   assets:source().assets.map(x=>({...x,usage:'render_this_plan',confirmationId}))});
  if(!authorizedDrafts.has(table))authorizedDrafts.set(table,new Map());
  authorizedDrafts.get(table).set(draft.draftSetId+':'+draft.version,structuredClone(draft));
  return q;
}
export function makeRoom(folder,confirmations,{checkpoint,observed={render:0}}={}){
 const mediaRoot=join(folder,'media');mkdirSync(mediaRoot,{recursive:true});
 const db=new DatabaseSync(join(folder,'fixture-only.sqlite'));
 db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000');
 const product={shopId:ctx.shopId,productId:ids.C,productVersion:1,assetIds:material.map(x=>x.assetId),
   copyId:'fixture-copy',copyProductVersion:1,copyVersion:1,copyText:source().confirmedCopy};
 const allows=c=>c?.shopId===ctx.shopId;
 const catalog={
   get(c,p){if(!allows(c))return null; if(p===ids.C)return product;if(p===ids.B)return {...product,productId:p,assetIds:[]};return null;},
   getSummary(c,p){return {assetRefs:p===ids.C&&allows(c)?material.map((x,i)=>({assetId:x.assetId,groupId:'fixture-group',
     groupVersion:1,evidenceRef:'self-owned-generated-'+i,decisionSource:'fixture'})):[]};}
 };
 const album={readAsset(c,id){return allows(c)?material.find(x=>x.assetId===id)??null:null;}};
 let production;
 const studio=createStudio({db,catalog,album,mediaRoot,renderPlan(input){
   const out=renderConfirmedPlan({...input,locked:production.forTask(input)});
   observed.render++;return out;
 }});
 const versionStore=createPlanVersionStore(db);
 production=createPlanProduction({db,studio,resolveConfirmation(c,k){return allows(c)?confirmations.get(k):null;},
   readActivePlanVersion(c,id,v){
     // Fixture owner publishes the prepared versions to the scoped service store.
     for(const draft of authorizedDrafts.get(confirmations)?.values()??[])versionStore.record(ctx,draft);
     return versionStore.getActive(c,id,v);
   },checkpoint});
 const one=(sql,...p)=>db.prepare(sql).get(...p);
 function count(){
  const names=['n22_plan_jobs','content_tasks','studio_works','studio_choices','studio_receipts','content_requests'];
  return {...Object.fromEntries(names.map(n=>[n,one('SELECT count(*) AS n FROM '+n).n])),
   approved:one("SELECT count(*) AS n FROM studio_works WHERE status='approved'").n,
   renderReceipts:one("SELECT count(*) AS n FROM studio_receipts WHERE op='render'").n,
   files:readdirSync(mediaRoot).filter(x=>x.endsWith('.mp4')).length};
 }
 function inspect(work){
  const result=one('SELECT media_key,digest FROM studio_works WHERE shop=? AND work=? AND version=?',ctx.shopId,work.workId,work.workVersion);
  return {file:join(mediaRoot,result.media_key),sha256:result.digest,bytes:readFileSync(join(mediaRoot,result.media_key)).length};
 }
 return {studio,production,count,inspect,close:()=>db.close()};
}
