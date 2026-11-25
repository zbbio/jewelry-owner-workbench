import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {actionsOf} from './local-read-intent.mjs';
import {createC1SoloTurn,projectC1Receipt} from './c1-solo.mjs';

test('the local intent region is byte-identical to the independently mounted S1 source (LF normalized), no SDK import',()=>{
 const upstream=readFileSync(new URL('../销售仓/s1.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const here=readFileSync(new URL('./local-read-intent.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const from=s=>s.slice(s.indexOf('const quoteWords ='),s.indexOf(s===upstream?'function scopeFor(ctx)':'export {actionsOf};'));
 assert.equal(from(upstream),from(here));
 assert.ok(here.includes(createHash('sha256').update(from(here)).digest('hex')));
 assert.doesNotMatch(here,/^\s*import\s/mu);
 assert.deepEqual(actionsOf('找 A 原来的视频，不问价格'),['old_video']);
 assert.deepEqual(actionsOf('查 A 多少钱，顺便找原来的视频'),['quote','old_video']);
 assert.deepEqual(actionsOf('不要找 A 原来的视频'),[]);
});
const p={shopId:'store',productId:'third-item',productVersion:12};
const id='content-request',messageId='msg';
const base={...p,requestId:id,messageId,action:'content.find_old_video',source:'studio.approved_works',deliveryStatus:'not_submitted',writesPerformed:false};
const url='/api/n22/content/works/other-work/7/play?messageId=msg&productId=third-item&productVersion=12';
const okay={...base,outcome:'existing_available',retrievalStatus:'playable',mime:'video/mp4',workRef:{workId:'other-work',workVersion:7},
 pinnedPlayUrl:url,sha256:'1'.repeat(64),fileBytes:32,durationSeconds:1};
const projection=r=>projectC1Receipt(r,p,id,messageId);
test('projection accepts real C1 contract; rejects mismatched Message, URL, Shop and fake/future results',()=>{
 assert.deepEqual(projection(okay).workRef,{workId:'other-work',workVersion:7});
 assert.equal(projection({...base,outcome:'no_verified_old_clip'}).status,'no_verified_old_clip');
 assert.equal(projection({...base,outcome:'needs_review'}).status,'needs_review');
 assert.deepEqual(projection({...base,outcome:'source_timeout'}),{status:'failed',code:'OLD_VIDEO_TIMEOUT',retryable:true});
 for(const patch of [{requestId:'wrong'},{shopId:'another'},{messageId:'different'},{productVersion:11},{writesPerformed:true},
   {deliveryStatus:'submitted'},{outcome:'created'},{mime:'audio/mpeg'}])
   assert.equal(projection({...okay,...patch}).code,'INVALID_CONTENT_RECEIPT');
 for(const path of [url.replace('msg','other'),url.replace('12','11'),url+'&token=foo','https://wrong.invalid'+url,url.replace('other-work','changed')])
   assert.equal(projection({...okay,pinnedPlayUrl:path}).code,'PLAYBACK_REF_UNPINNED');
});
test('third card version conflict, unbound reply, and clear no-target prevent C1 reads or borrowed works',async()=>{
 const ctx={shopId:'store',actorId:'owner',sessionId:'only'};
 let binds=0,lookups=0,version=12,kind='EXPLICIT_ID';
 const turn=createC1SoloTurn({
  catalog:{get(){return {...p,productVersion:version}}},
  product:{resolve(_c,x){return {storeId:'store',requestId:x.requestId,messageId:x.messageId,status:'matched',reason:kind,total:1,cards:[p]};}},
  messages:{reference(){return null;},setProduct(){binds++;},setWork(){assert.fail('no work should be pinned');}},
  c1:{lookup(_c,x){lookups++;version=13;return {...okay,requestId:x.requestId,messageId:x.messageId};}}
 });
 const x={requestId:'r',messageId,text:'看这个手串的原来的视频'};
 kind='VERIFIED_FIELDS';assert.equal((await turn(ctx,x)).status,'needs_clarification');
 assert.equal((await turn(ctx,{...x,replyToMessageId:'different-installation'})).status,'needs_clarification');
 assert.equal((await turn(ctx,{...x,text:'重做这件的旧片'})).status,'unsupported');
 assert.equal(lookups,0);assert.equal(binds,0);
 kind='EXPLICIT_ID';
 const r=await turn(ctx,{...x,text:'找卡号 third-item 的旧片'});
 assert.equal(r.status,'failed');assert.equal(r.actions[0].code,'PRODUCT_SCOPE_OR_VERSION_CHANGED');
 assert.equal(lookups,1);assert.equal(binds,1);
});
