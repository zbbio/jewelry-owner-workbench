import type {DatabaseSync} from "node:sqlite";
import {isAbsolute} from "node:path";
import {makeSharedRunner,sha256,type Binding,type Ports,type Policy} from "./shared-runner.js";

type Slot={shopId:string;actorId:string;conversationId:string;productId:string;productVersion:number;textSha256:string};
export type Release={releaseId:string;notBeforeMs:number;expiresAtMs:number;modelId:"deepseek-flash";slots:Slot[]};
export type LiveOptions={db:DatabaseSync;release:Release;verifyOperatorRelease:(r:Release)=>boolean;
  getApiKey:()=>Promise<string|null>|string|null;now?:()=>number};
const ids=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const ver=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const exact=(x:any,k:string[])=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(a=>Object.hasOwn(x,a));
const slotKeys=["shopId","actorId","conversationId","productId","productVersion","textSha256"] as const;
const slotMatch=(s:Slot,b:Binding,t:string)=>s.shopId===b.shopId&&s.actorId===b.actorId&&s.conversationId===b.conversationId&&
  s.productId===b.productId&&s.productVersion===b.productVersion&&s.textSha256===sha256(t);
function valid(r:Release){
  return exact(r,["releaseId","notBeforeMs","expiresAtMs","modelId","slots"])&&ids(r.releaseId)&&ver(r.notBeforeMs)&&ver(r.expiresAtMs)&&
    r.expiresAtMs>r.notBeforeMs&&r.expiresAtMs-r.notBeforeMs<=900000&&r.modelId==="deepseek-flash"&&Array.isArray(r.slots)&&
    r.slots.length>=1&&r.slots.length<=2&&r.slots.every(s=>exact(s,[...slotKeys])&&ids(s.shopId)&&ids(s.actorId)&&ids(s.conversationId)&&
     ids(s.productId)&&ver(s.productVersion)&&typeof s.textSha256==="string"&&/^[a-f0-9]{64}$/.test(s.textSha256))&&
    new Set(r.slots.map(s=>JSON.stringify(slotKeys.map(k=>s[k])))).size===r.slots.length;
}
/**
 * Reuses N22 G2PREP's persist-before-network approach, not its A/B QA gate.
 * Private server-owned on-disk budget, separate from the P1 message database.
 * Restart with the same release does NOT restore eligibility, even if no result had been received.
 */
export function openS1ProviderBudget({db,release,verifyOperatorRelease,now=Date.now}:Omit<LiveOptions,"getApiKey">){
  const r=structuredClone(release);
  if(!valid(r)||now()<r.notBeforeMs||now()>=r.expiresAtMs||verifyOperatorRelease(structuredClone(r))!==true)return null;
  const file=(db.prepare("PRAGMA database_list").all() as {name:string;file:string}[]).find(x=>x.name==="main")?.file;
  if(!file||!isAbsolute(file))return null;
  db.exec("PRAGMA busy_timeout=4000; PRAGMA synchronous=FULL;"+
    "CREATE TABLE IF NOT EXISTS n99_s1_release(r TEXT PRIMARY KEY, expires INTEGER NOT NULL, pin TEXT NOT NULL);"+
    "CREATE TABLE IF NOT EXISTS n99_s1_spend(r TEXT NOT NULL, slot INTEGER NOT NULL, binding TEXT NOT NULL, "+
    "http INTEGER NOT NULL DEFAULT 0 CHECK(http>=0 AND http<=2), PRIMARY KEY(r,slot), UNIQUE(r,binding));");
  const rid=sha256("n99-s1:"+r.releaseId);
  if(db.prepare("INSERT INTO n99_s1_release(r,expires,pin) VALUES(?,?,?) ON CONFLICT DO NOTHING")
    .run(rid,r.expiresAtMs,sha256(JSON.stringify(r))).changes!==1)return null;
  const ck=()=>now()>=r.notBeforeMs&&now()<r.expiresAtMs;
  const claim=db.prepare("INSERT INTO n99_s1_spend(r,slot,binding) VALUES(?,?,?) ON CONFLICT DO NOTHING");
  const spend=db.prepare("UPDATE n99_s1_spend SET http=http+1 WHERE r=? AND slot=? AND binding=? AND http<2");
  const count=db.prepare("SELECT count(*) AS business, coalesce(sum(http),0) AS http FROM n99_s1_spend WHERE r=?");
  return Object.freeze({
    claim(b:Readonly<Binding>,text:string){
      if(!ck())return null;
      const slot=r.slots.findIndex(s=>slotMatch(s,b,text));
      if(slot<0)return null;
      const binding=sha256(JSON.stringify([b.shopId,b.actorId,b.conversationId,b.messageId,b.requestId]));
      if(claim.run(rid,slot,binding).changes!==1)return null;
      return ()=>{
        if(!ck()||spend.run(rid,slot,binding).changes!==1)return false;
        const left=r.expiresAtMs-now();return left>0?AbortSignal.timeout(left):false;
      };
    },
    counters(){return count.get(rid) as {business:number;http:number};}
  });
}
export function createS1LiveRunner(ports:Ports,options?:LiveOptions){
  // A production mount never takes an HTTP fixture, URL, API key value or browser setting.
  if(!options||typeof options.getApiKey!=="function"||!options.db||!options.release||typeof options.verifyOperatorRelease!=="function")
    return {state:"off" as const,run:makeSharedRunner(ports),counters:()=>({business:0,http:0})};
  let budget;
  try{budget=openS1ProviderBudget(options);}catch{budget=null;}
  if(!budget)return {state:"off" as const,run:makeSharedRunner(ports),counters:()=>({business:0,http:0})};
  const active=budget;
  const policy:Policy={mode:"provider",modelId:"deepseek-flash",async open(b,text){
    const reserve=active.claim(b,text);
    if(!reserve)throw new Error("LIVE_RELEASE_SCOPE_OR_REPLAY");
    const key=await options.getApiKey();
    if(typeof key!=="string"||!key.trim())throw new Error("MODEL_NOT_CONFIGURED");
    return {key:key.trim(),reserve};
  }};
  return {state:"release-armed" as const,run:makeSharedRunner(ports,policy),counters:active.counters};
}
