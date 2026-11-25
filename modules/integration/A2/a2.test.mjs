import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {classificationReceipt,a2View,a2ConversationAlbum}=require('./源码/n22-ui/n22-app.js');
const dir=process.env.A2_VERIFIED_RUN;
const log=JSON.parse(readFileSync(join(dir,'桌面回执.json'),'utf8'));
const manual=JSON.parse(readFileSync(join(dir,'独立人工来源回读.json'),'utf8'));
const sources=readFileSync(join(dir,'实际S1适配回执.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const r=log.requests.find(x=>x.label==='ordinary no-card classification').body;
const batch=log.requests.find(x=>x.path==='/api/n22/album/batches').body;
const p=classificationReceipt(r,batch,r);
function row(e){
 const ref=Object.fromEntries(['messageId','requestId','conversationId','runId'].map(k=>[k,e.result[k]]));
 return {...ref, ...(e.result.status==='needs_photos'?{code:'NEEDS_PHOTOS'}:{}),assistant:{...ref,actions:[
  {tool:e.toolName,callId:e.callId,toolVersion:'n99-a1.album-classify-batch/1.0.0',...e.publicAction}]}};
}

test('ordinary desk classifications preserve distinct same-category photos and aggregate separate real sources',()=>{
 const v=a2View(batch,p,r), idx=i=>v.byItem.get(batch.items[i].itemId);
 assert.equal(v.byItem.size,5);
 assert.equal(idx(0).effective.category,'bangle');assert.equal(idx(1).effective.category,'bangle');
 assert.equal(idx(2).effective.category,'bracelet');assert.notEqual(batch.items[0].assetId,batch.items[1].assetId);
 assert.equal(idx(3).status,'pending');assert.equal(idx(4).status,'duplicate');
 assert.equal(v.counts.original_label,2);assert.equal(v.counts.human,0);assert.equal(v.counts.image_inference,0);
 const patched=manual.shown, latest=a2View(batch,classificationReceipt(patched,batch,r),patched);
 const before=v.byItem.get(batch.items[1].itemId), after=latest.byItem.get(batch.items[1].itemId);
 assert.deepEqual(before.evidence,after.evidence.slice(0,2));
 assert.equal(after.effective.source,'human');assert.equal(after.effective.category,'ring');assert.equal(latest.counts.human,1);
});
test('A2 consumes a real S1 summary without exposing photos on false references, absent receipt, or another topic',()=>{
 const [,s]=sources, m=row(s), current={shopId:r.shopId,conversationId:r.conversationId};
 const authorized={receiptId:s.receiptId,callId:s.callId,toolName:s.toolName,result:r,batch};
 assert.equal(a2ConversationAlbum(m,current,authorized).status,'classified');
 assert.deepEqual(a2ConversationAlbum(row(sources[0]),current,null),{status:'needs_photos'});
 assert.equal(a2ConversationAlbum(m,{...current,conversationId:'other'},authorized),null);
 for(const v of [null,{...authorized,receiptId:'wrong'},{...authorized,result:{...r,runId:'wrong'}},
                   {...authorized,result:{...r,shopId:'other'}}])
   assert.equal(a2ConversationAlbum(m,current,v).status,'unavailable');
 assert.equal(a2ConversationAlbum({...m,assistant:{...m.assistant,messageId:'wrong'}},current,authorized),null);
});
test('altered assets, sources or formal writes fail closed; valid denied row exposes no category',()=>{
 const idx=1, a=p.items[idx], clone=x=>({...p,items:p.items.map((e,j)=>j===idx?x:e)});
 for(const bad of [clone({...a,assetId:'wrong'}),clone({...a,thumbnailRef:'https://example.invalid/photo'}),
                    {...p,effects:{...p.effects,catalogUpdated:1}},clone({...a,assetSha256:'0'.repeat(64)})])
   assert.equal(a2View(batch,bad,r),null);
 const revoked=clone({itemId:a.itemId,assetId:null,category:null,source:null,status:'not_authorized'});
 const v=a2View(batch,revoked,r);assert.equal(v.byItem.get(a.itemId).status,'not_authorized');
 assert.deepEqual(v.byItem.get(a.itemId).evidence,[]);
});
