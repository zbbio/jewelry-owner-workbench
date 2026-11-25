import {isDeepStrictEqual} from 'node:util';
import {readPlanPins} from '../content/c2-plan-prep.mjs';
import {validateCaptionPlan} from '../content/caption-policy.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function createPlanVersionStore(db){
 db.exec('CREATE TABLE IF NOT EXISTS n22_c2_plan_versions(shop TEXT NOT NULL,actor TEXT NOT NULL,draft TEXT NOT NULL,version INTEGER NOT NULL,state_json TEXT NOT NULL,PRIMARY KEY(shop,actor,draft,version))');
 const add=db.prepare('INSERT OR IGNORE INTO n22_c2_plan_versions(shop,actor,draft,version,state_json) VALUES (?,?,?,?,?)');
 const get=db.prepare('SELECT state_json FROM n22_c2_plan_versions WHERE shop=? AND actor=? AND draft=? AND version=?');
 const last=db.prepare('SELECT state_json FROM n22_c2_plan_versions WHERE shop=? AND actor=? AND draft=? ORDER BY version DESC LIMIT 1');
 const tuple=(ctx,id)=>{if(ctx?.role!=='owner'||!ctx.shopId||!ctx.actorId||!id)fail('C2_SCOPE_DENIED');return [ctx.shopId,ctx.actorId,id];};
 // Internal only: record the result of the trusted prepare/edit/cancel functions.
 function record(ctx,state){
  const scope=tuple(ctx,state?.draftSetId);
  if(scope[0]!==state.shopId||scope[1]!==state.actorId)fail('C2_SCOPE_DENIED');
  if(!Number.isSafeInteger(state.version)||state.version<1||!['editable','canceled'].includes(state.state)||!state.plans?.length)fail('C2_INVALID_VERSION');
  for(const plan of state.plans){
    readPlanPins({...state,state:'editable'},plan);
    if(state.state==='editable')validateCaptionPlan(plan,state.captionProfile);
  }
  add.run(...scope,state.version,JSON.stringify(state));
  const pinned=JSON.parse(get.get(...scope,state.version).state_json);
  if(!isDeepStrictEqual(pinned,state))fail('C2_VERSION_CONFLICT');
  return pinned;
 }
 function getVersion(ctx,id,version){const row=get.get(...tuple(ctx,id),version);return row?JSON.parse(row.state_json):null;}
 function getActive(ctx,id,version){
  const row=last.get(...tuple(ctx,id));
  if(!row)fail('C2_APPROVED_PLAN_REQUIRED');
  const state=JSON.parse(row.state_json);
  if(state.state!=='editable')fail('C2_SET_CANCELED');
  if(state.version!==version)fail('C2_VERSION_CONFLICT');
  return state;
 }
 return Object.freeze({record,getVersion,getActive});
}
