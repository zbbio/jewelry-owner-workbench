import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD3ContentAdapter} from '../d3-content.mjs';
import {createD3CaptionEditor} from './edit-caption.mjs';
import {projectD3CaptionIssue,scopedD3ContentReceipt} from '../../../销售仓/d3-display.mjs';
import {ctx as fixtureOwner,ids,material,source,readFixtureAsset} from '../../C2/fixture.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));
const ctx={...fixtureOwner,sessionId:'c2text-local-owner'};
const card={shopId:ctx.shopId,productId:ids.C,productVersion:1};
const photos=material.slice(0,2);
const physical=['n22_plan_jobs','n22_d3_render_intents','content_tasks','studio_choices','studio_works','studio_receipts','mp4'];
const nonproduction=n=>{for(const k of physical)assert.equal(n[k],0,k);};
const differentShot=(base,after,text)=>{
 assert.equal(after.draftSetId,base.draftSetId);
 assert.equal(after.draftSetVersion,base.draftSetVersion+1);
 assert.equal(after.plans.length,2);
 assert.deepEqual(after.plans[0],base.plans[0],'first plan must be byte-for-byte structurally equal');
 const [p,q]=[base.plans[1],after.plans[1]];
 assert.equal(q.planId,p.planId);
 assert.deepEqual(q,{...p,planVersion:p.planVersion+1,
   shots:p.shots.map((s,i)=>i?{...s}:{...s,caption:text})});
};
function make(t){
 const dir=mkdtempSync(join(here,'case-'));
 const messages=new Map(),grants=new Map();
 let version=1;
 const inSession=c=>c.shopId===ctx.shopId&&c.sessionId===ctx.sessionId&&c.actorId===ctx.actorId;
 const dbFile=join(dir,'d3-content.sqlite');
 const d3=createD3ContentAdapter({dataDir:dir,isolatedStoreId:ctx.shopId,isWritableTestStore:inSession,
  catalog:{get:(c,id)=>inSession(c)&&id===card.productId?{...card,productVersion:version}:null,
    getSummary:()=>assert.fail('Studio must not start')},
  album:{readAsset:()=>assert.fail('Studio media path must not start')},
  readMessage:(c,m)=>inSession(c)?messages.get(m):null,
  readPlanningSource:(c,q)=>({...source(q.messageId),assets:source().assets.slice(0,2)}),
  readApprovedAsset:readFixtureAsset,
  readConfirmation:(c,id)=>inSession(c)?grants.get(id):null,
  checkpoint:()=>assert.fail('C3 checkpoint must not start'),
 });
 t.after(()=>d3.close());
 const edit=createD3CaptionEditor({contentD3:d3});
 const turn=(messageId,referenceMessageId=null)=>{
  messages.set(messageId,card);
  return {...card,requestId:'r-'+messageId,messageId,referenceMessageId};
 };
 function counts(){
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{
   const tables=['n22_c2_plan_versions','n22_d3_ops',...physical.filter(x=>x!=='mp4')];
   const data=Object.fromEntries(tables.map(k=>[k,db.prepare('SELECT count(*) AS n FROM '+k).get().n]));
   const media=join(dir,'media');
   return {...data,mp4:existsSync(media)?readdirSync(media).filter(p=>p.endsWith('.mp4')).length:0};
  }finally{db.close();}
 }
 function pinHistory(r){
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{return db.prepare('SELECT state_json FROM n22_c2_plan_versions WHERE draft=? ORDER BY version').all(r.draftSetId)
   .map(row=>JSON.parse(row.state_json))
   .map(x=>({version:x.version,assetPinsDigest:x.assetPinsDigest,assetPins:x.assetPins}));}
  finally{db.close();}
 }
 const setVersion=v=>{version=v;};
 return {d3,edit,turn,counts,pinHistory,dir,grants,setVersion,messages};
}
const byDisplay=(q,caption,more)=>({...q,planOrdinal:2,shotOrdinal:1,caption,...more});
const d3pin=(r,p)=>({draftSetId:r.draftSetId,draftSetVersion:r.draftSetVersion,
 planId:r.plans[p].planId,planVersion:r.plans[p].planVersion});

test('real D3/C2, same session: second plan first shot, idempotency, 57 reject and 56 on same draft',t=>{
 const x=make(t), {d3,edit,turn,counts}=x, initial=counts();
 const r0=d3.prepare(ctx,turn('shown-prepared'));
 assert.equal(r0.status,'drafts_ready');assert.equal(r0.plans.length,2);
 assert.deepEqual(r0.plans[1].shots.map(s=>s.assetId),photos.map(s=>s.assetId).reverse());
 const line=byDisplay(turn('edit-sentence',r0.messageId),'先看珠纹');
 const edited=edit(ctx,{...line,shots:[{assetId:'untrusted-replacement'}],planId:'untrusted-plan'});
 assert.equal(edited.status,'drafts_ready');assert.deepEqual(edited.editTarget,
  {...d3pin(r0,1),referenceMessageId:r0.messageId,planOrdinal:2,shotOrdinal:1});
 differentShot(r0,edited,line.caption);
 const afterEdit=counts();
 const exact=edit(ctx,line);
 assert.deepEqual(exact,edited);assert.deepEqual(counts(),afterEdit);
 assert.throws(()=>edit(ctx,{...line,caption:'另一个正文'}),{code:'D3_REQUEST_CONFLICT'});
 const oldEdit=edit(ctx,byDisplay(turn('new-at-old',r0.messageId),'用旧版试改'));
 assert.equal(oldEdit.status,'stale_version');
 assert.equal(oldEdit.code,'C2_VERSION_CONFLICT');
 assert.throws(()=>d3.preflightCaption(ctx,{messageId:r0.messageId,...d3pin(r0,1),caption:'仍是旧版'}),{code:'C2_VERSION_CONFLICT'});
 // Fixture-only grant merely reaches the old-version guard; no live approval is issued.
 const confirmOld={...turn('try-old-confirm',r0.messageId),...d3pin(r0,1),confirmationId:'synthetic-old-grant'};
 x.grants.set(confirmOld.confirmationId,{...confirmOld,actorId:ctx.actorId,sessionId:ctx.sessionId,
  purpose:'render_selected_plan',active:true,expiresAt:'2099-01-01T00:00:00Z',revokedAt:null,canceledAt:null});
 const oldConfirm=d3.confirm(ctx,confirmOld);
 assert.equal(oldConfirm.status,'stale_version');
 assert.equal(oldConfirm.code,'C2_VERSION_CONFLICT');nonproduction(counts());

 const long='文'.repeat(55)+'😀',short='文'.repeat(54)+'😀';
 assert.deepEqual([long.length,short.length],[57,56]);
 const tooLong=byDisplay(turn('too-long',edited.messageId),long);
 const blocked=edit(ctx,tooLong);
 assert.equal(blocked.status,'needs_review');
 assert.equal(blocked.code,'CAPTION_TOO_LONG');
 assert.strictEqual(blocked.captionCheck.used,57);assert.strictEqual(blocked.captionCheck.excess,1);
 assert.strictEqual(blocked.captionCheck.shotIndex,1);
 assert.strictEqual(blocked.captionCheck.countRule,'utf16_code_units');
 const cap=projectD3CaptionIssue(tooLong,blocked);
 assert.ok(cap);assert.equal(cap.captionCheck.excess,1);
 const rejectView=d3.readTurn(ctx,{messageId:tooLong.messageId});
 assert.equal(rejectView.status,'failed');assert.equal(rejectView.actions[0].result.captionCheck.shotIndex,1);
 const afterReject=counts();
 assert.equal(afterReject.n22_c2_plan_versions,afterEdit.n22_c2_plan_versions,'57 must not save a draft version');
 assert.deepEqual(edit(ctx,tooLong),blocked);
 assert.deepEqual(counts(),afterReject);
 const retryOnFailure=edit(ctx,byDisplay(turn('wrong-failure-anchor',tooLong.messageId),short));
 assert.equal(retryOnFailure.code,'D3_CAPTION_EDIT_REFERENCE_REQUIRED');
 const retry=byDisplay(turn('shortened-56',edited.messageId),short);
 const fixed=edit(ctx,retry);
 assert.equal(fixed.status,'drafts_ready');assert.equal(fixed.editTarget.draftSetVersion,2);
 assert.ok(scopedD3ContentReceipt(retry,fixed));
 differentShot(edited,fixed,short);
 const finalView=d3.readTurn(ctx,{messageId:retry.messageId});
 assert.equal(finalView.actions[0].action,'content_prepare');
 assert.deepEqual(finalView.actions[0].result.plans,fixed.plans);
 const pinHistory=x.pinHistory(r0);
 assert.deepEqual(pinHistory.map(x=>x.version),[1,2,3]);
 for(const p of pinHistory.slice(1)){
  assert.deepEqual(p.assetPins,pinHistory[0].assetPins);
  assert.equal(p.assetPinsDigest,pinHistory[0].assetPinsDigest);
 }
 const final=counts();nonproduction(final);
 const out=join(x.dir,'原始回执.json');
 writeFileSync(out,JSON.stringify({
  scope:'new isolated service-level run, synthetic read ports and two existing self-drawn PNG fixtures; no HTTP/browser',
  trace:{prepare:r0,edited,exactReplay:exact,rejectOldEdit:oldEdit,rejectOldConfirm:oldConfirm,
    overLength:blocked,salesCaptionProjection:cap,failedReadTurn:rejectView,shortened:fixed,shortenedReadTurn:finalView},
  counts:{initial,afterEdit,afterReject,final},pinHistory,renderCalls:0,
 },null,2)+'\n','utf8');
 console.log('EVIDENCE '+JSON.stringify({path:out,initial,afterEdit,afterReject,final}));
});

test('wrong plan/shot, unrelated card, canceled draft, moved card version or separate session cannot edit',t=>{
 const x=make(t), r=x.d3.prepare(ctx,x.turn('prepared-guard'));
 const e=(name,over)=>byDisplay(x.turn(name,r.messageId),'不应写入',over);
 assert.equal(x.edit(ctx,e('no-third-plan',{planOrdinal:3})).code,'D3_CAPTION_EDIT_TARGET_NOT_FOUND');
 assert.equal(x.edit(ctx,e('no-third-shot',{shotOrdinal:3})).code,'D3_CAPTION_EDIT_TARGET_NOT_FOUND');
 assert.equal(x.edit(ctx,e('other-card',{productId:ids.B})).code,'D3_CAPTION_EDIT_REFERENCE_REQUIRED');
 assert.throws(()=>x.edit({...ctx,sessionId:'other'},e('other-session')),{code:'D3_STORE_NOT_ENABLED'});
 const cancel=x.d3.cancel(ctx,{...x.turn('cancel',r.messageId),draftSetId:r.draftSetId,draftSetVersion:r.draftSetVersion});
 assert.equal(cancel.status,'cancelled');
 assert.equal(x.edit(ctx,e('canceled')).status,'canceled');
 x.setVersion(2);
 assert.equal(x.edit(ctx,e('advanced-card')).code,'D3_PRODUCT_VERSION_CHANGED');
 assert.equal(x.counts().n22_c2_plan_versions,2,'only prepare and cancel versions');
 nonproduction(x.counts());
 console.log('GUARDS '+JSON.stringify({counts:x.counts(),tested:['target_not_found','wrong_card','other_session','canceled','card_version_changed']}));
});
