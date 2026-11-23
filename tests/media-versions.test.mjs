import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCatalog} from '../catalog/index.mjs';
import {createAlbum} from '../album/index.mjs';
import {createSales} from '../sales/index.mjs';
import {createStudio} from '../content/studio.mjs';

const ctx={shopId:'isolated-n3-media-test',actorId:'test-owner',role:'owner'};
const other={...ctx,shopId:'another-shop'},staff={...ctx,role:'staff'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const ec=c=>e=>e.code===c;
const run=(bin,args,opts={})=>{
  const r=spawnSync(bin,args,{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024,...opts});
  assert.equal(r.status,0,r.stderr?.toString()||String(r.error));return r;
};
const opts={encoding:'utf8'};
let sequence=0;
function rid(){return 'n3-'+(++sequence);}
async function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'n3-media-')),mediaRoot=path.join(dir,'media'),file=path.join(dir,'isolated.sqlite');
  let db,catalog,album,studio;
  function open(){db=new DatabaseSync(file);catalog=createCatalog({db,hasAsset:(s,a)=>album.hasAsset(s,a)});
    album=createAlbum({db,catalog});studio=createStudio({db,catalog,album,mediaRoot});}
  open();t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const gen=run(process.env.ALBUM_PYTHON||'python',['-B','-c',`
import os,sys
from PIL import Image,ImageDraw
for i,c in enumerate([(212,53,41),(34,74,211),(30,174,82)]):
 im=Image.new("RGB",(96,96),c); d=ImageDraw.Draw(im); d.ellipse((18,18,78,78),outline=(240,240,233),width=4)
 im.save(os.path.join(sys.argv[1],str(i)+".png"))
`,dir]);assert.equal(gen.status,0);
  const files=[0,1,2].map(i=>({bytes:readFileSync(path.join(dir,i+'.png'))}));
  const b=await album.importBatch(ctx,{requestId:rid(),files});
  assert.equal(b.items.length,3);assert.equal(b.pendingAssetIds.length,3,'setup requires manually confirmed synthetic cards');
  const ids=b.items.map(i=>i.assetId);
  await album.resolve(ctx,{requestId:rid(),taskId:b.taskId,groups:[{assetIds:ids.slice(0,2)},{assetIds:ids.slice(2)}]});
  const cards=catalog.list(ctx),A=cards.find(p=>p.assetIds.includes(ids[0])).productId,B=cards.find(p=>p.assetIds.includes(ids[2])).productId;
  assert.notEqual(A,B);assert.deepEqual(catalog.get(ctx,A).assetIds,ids.slice(0,2));
  return {dir,ids,A,B,get db(){return db;},get cat(){return catalog;},get s(){return studio;},get a(){return album;},mediaRoot,
    restart(){db.close();open();},
    copy(pid,text='店主确认的本件图文介绍；无售价或库存承诺。'){return catalog.saveCopy(ctx,{requestId:rid(),productId:pid,expectedVersion:catalog.get(ctx,pid).productVersion,text});},
    choice(pid,assetIds){return studio.saveChoice(ctx,{requestId:rid(),productId:pid,productVersion:catalog.get(ctx,pid).productVersion,assetIds,template:'portrait_card',grantOriginalUse:true});},
    ask(pid,b={}){return studio.requestVideo(ctx,{requestId:rid(),productId:pid,productVersion:catalog.get(ctx,pid).productVersion,demand:'请看本件视频',...b});},
    count(table){return db.prepare('SELECT COUNT(*) n FROM '+table).get().n;}
  };
}
test('confirmed copy: provenance preserved, immutable revisions, stale write/field spoof denied, no other-card mutations',async t=>{
  const f=await fixture(t),{cat,A,B,ids}=f;
  const first=cat.getSummary(ctx,A);assert.equal(first.copyId,null);
  const req={requestId:rid(),expectedVersion:1,productId:A,text:'第一版'};
  assert.throws(()=>cat.saveCopy(staff,req),ec('OWNER_REQUIRED'));
  const v=cat.saveCopy(ctx,req);assert.equal(v.productVersion,2);assert.equal(v.copyVersion,1);
  assert.deepEqual(cat.saveCopy(ctx,req),v);assert.equal(f.copy(A,req.text).productVersion,2);
  assert.throws(()=>cat.saveCopy(ctx,{...req,text:'冲突'}),ec('IDEMPOTENCY_CONFLICT'));
  assert.throws(()=>cat.saveCopy(ctx,{...req,requestId:rid(),text:'旧版覆盖'}),ec('VERSION_CONFLICT'));
  assert.throws(()=>cat.saveCopy(other,req),ec('PRODUCT_NOT_FOUND'));
  assert.throws(()=>cat.update(ctx,{requestId:rid(),productId:A,expectedVersion:2,changes:[{field:'copyText',source:'manual',value:'伪造'}]}),ec('INVALID_INPUT'));
  const u=cat.update(ctx,{requestId:rid(),expectedVersion:2,productId:A,changes:[{field:'beadDiameter',value:7,unit:'mm',source:'manual'}]});
  assert.equal(u.productVersion,3);assert.equal(cat.get(ctx,A).copyProductVersion,2);
  assert.throws(()=>f.choice(A,[ids[0]]),ec('COPY_REVIEW_REQUIRED'));
  const c=f.copy(A,req.text);assert.equal(c.copyId,v.copyId);assert.equal(c.copyVersion,2);assert.equal(c.productVersion,4);
  const changed=f.copy(A,'第二版介绍');assert.equal(changed.copyVersion,3);assert.equal(cat.getSummary(ctx,A).copyText,'第二版介绍');
  assert.deepEqual(cat.getSummary(ctx,A).assetRefs,first.assetRefs);assert.equal(cat.get(ctx,B).copyId,null);assert.equal(cat.get(ctx,B).productVersion,1);
  assert.equal(f.count('catalog_copy_versions'),3);
});
test('no implicit license, foreign/mixed photos rejected; immutable single-use grant & request convergence; revoke stops replay',async t=>{
  const f=await fixture(t),{s,A,B,ids}=f;
  assert.equal(f.ask(B).outcome,'needs_review');f.copy(A);f.copy(B);
  const req={requestId:rid(),productId:A,productVersion:2,assetIds:ids.slice(0,2),template:'portrait_card',grantOriginalUse:true};
  assert.throws(()=>s.saveChoice(ctx,{...req,grantOriginalUse:false}),ec('SOURCE_PERMISSION_REQUIRED'));
  assert.throws(()=>s.saveChoice(staff,req),ec('OWNER_REQUIRED'));
  assert.throws(()=>f.choice(A,[ids[0],ids[2]]),ec('NOT_THIS_PRODUCT_SOURCE'));
  assert.throws(()=>f.choice(B,[ids[1]]),ec('NOT_THIS_PRODUCT_SOURCE'));
  assert.deepEqual(s.getChoice(ctx,A),null);assert.equal(f.ask(A).outcome,'needs_review');
  const ch=s.saveChoice(ctx,req);assert.deepEqual(s.saveChoice(ctx,req),ch);assert.equal(ch.choiceVersion,1);assert.equal(f.count('studio_choices'),1);
  assert.throws(()=>s.saveChoice(ctx,{...req,assetIds:ids.slice(0,1)}),ec('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.ask(B,{choiceId:ch.choiceId}).outcome,'needs_review');
  const body={requestId:rid(),choiceId:ch.choiceId},q=f.ask(A,body);assert.equal(q.outcome,'queued');
  assert.deepEqual(f.ask(A,body),q);assert.equal(f.ask(A).taskId,q.taskId);assert.equal(f.count('content_tasks'),1);
  assert.equal(s.getChoice(ctx,A).status,'consumed');assert.equal(s.getChoice(ctx,A).taskId,q.taskId);
  assert.throws(()=>s.getTask(other,q.taskId),ec('TASK_NOT_FOUND'));
  const task=s.getTask(ctx,q.taskId);assert.deepEqual(task.lockedInputs.assets.map(a=>a.digest),ids.slice(0,2).map(a=>sha(f.a.readAsset(ctx,a).bytes)));
  assert.ok(task.lockedInputs.assets.every(a=>a.evidenceRef&&a.groupId&&a.decisionSource==='owner_confirmed'));
  assert.equal(task.lockedInputs.preferenceSnapshot.scope,'this_production_only');
  s.revokeChoice(ctx,{requestId:rid(),productId:A,choiceId:ch.choiceId});assert.equal(s.getChoice(ctx,A),null);
  assert.equal(f.ask(A,body).outcome,'needs_review');assert.equal(s.getTask(ctx,q.taskId).status,'needs_review');
  assert.throws(()=>s.render(ctx,{requestId:rid(),taskId:q.taskId}),ec('TASK_REVIEW_REQUIRED'));
  assert.equal(f.count('studio_works'),0);assert.equal(readdirSync(f.mediaRoot).length,0);
});
test('actual multi-photo FFmpeg render, exact revision approval and playback, restart, stale fact fences',async t=>{
  const f=await fixture(t),{A,B,ids}=f;f.copy(A);f.copy(B);const ch=f.choice(A,ids.slice(0,2));
  const sales=createSales({db:f.db,catalog:f.cat,content:f.s});
  const ask={requestId:rid(),sessionId:'buyer1',productId:A,question:'请给我看本件的视频'};
  const demand=sales.ask(ctx,ask);assert.equal(demand.video?.outcome,'queued');
  const q=f.ask(A);assert.equal(q.taskId,demand.video.taskId);
  const make={requestId:rid(),taskId:q.taskId},w1=f.s.render(ctx,make);assert.equal(w1.status,'awaiting_approval');assert.equal(w1.shotCount,2);
  assert.throws(()=>f.s.openOldVideo(ctx,{...w1}),ec('WORK_NOT_AVAILABLE'));
  assert.throws(()=>f.s.openPreview(staff,w1),ec('OWNER_REQUIRED'));
  assert.throws(()=>f.s.openPreview(other,w1),ec('PRODUCT_NOT_FOUND'));
  const pre=f.s.openPreview(ctx,w1);assert.equal(sha(pre.bytes),w1.sha256);assert.equal(w1.frames,48);
  assert.equal(f.s.render(ctx,make).sha256,w1.sha256);assert.equal(f.s.render(ctx,{...make,requestId:rid()}).workVersion,1);
  const ch2=f.choice(A,[ids[1],ids[0]]);assert.equal(ch2.choiceVersion,ch.choiceVersion+1);
  const q2=f.ask(A,{choiceId:ch2.choiceId});assert.notEqual(q2.taskId,q.taskId);
  const w2=f.s.render(ctx,{requestId:rid(),taskId:q2.taskId});assert.equal(w2.workId,w1.workId);assert.equal(w2.workVersion,2);assert.notEqual(w1.sha256,w2.sha256);
  assert.equal(readdirSync(f.mediaRoot).length,2,'only final MP4s: no temporary font, owner text or extra source copies remain');
  const approve={requestId:rid(),productId:A,workId:w1.workId,workVersion:1};
  assert.throws(()=>f.s.approve(ctx,{...approve,productId:B}),ec('WORK_NOT_AVAILABLE'));
  assert.throws(()=>f.s.approve(ctx,{...approve,workVersion:33}),ec('WORK_NOT_AVAILABLE'));
  const approved=f.s.approve(ctx,approve);assert.equal(approved.status,'approved');assert.deepEqual(f.s.approve(ctx,approve),approved);
  assert.equal(f.ask(A).workRef.workVersion,1);assert.equal(f.ask(B).outcome,'needs_review');assert.equal(f.count('content_tasks'),2);
  assert.throws(()=>f.s.openOldVideo(ctx,{...w1,productId:B}),ec('WORK_NOT_AVAILABLE'));
  f.restart();
  const opened=f.s.openOldVideo(ctx,w1);assert.equal(sha(opened.bytes),w1.sha256);assert.equal(f.s.getTask(ctx,q.taskId).workRef.workVersion,1);
  const accepted=path.join(f.dir,'confirmed-A-v1.mp4');writeFileSync(accepted,opened.bytes);
  const probeArgs=['-v','error','-show_entries','stream=codec_name,width,height,nb_frames,duration','-of','json',accepted],
    decodeArgs=['-hide_banner','-v','error','-xerror','-err_detect','explode','-i',accepted,'-map','0:v:0','-fps_mode','passthrough','-f','null','-','-progress','pipe:1','-nostats'];
  const probe=run('ffprobe',probeArgs,opts),dec=run('ffmpeg',decodeArgs,opts);
  const v=JSON.parse(probe.stdout).streams[0];assert.equal(v.codec_name,'h264');assert.equal(v.width,360);assert.equal(v.height,640);assert.equal(v.nb_frames,'48');assert.match(dec.stdout,/progress=end/);
  const frame=(t,x,y)=>run('ffmpeg',['-v','error','-ss',String(t),'-i',accepted,'-vf',`crop=2:2:${x}:${y},scale=1:1,format=rgb24`,'-frames:v','1','-f','rawvideo','pipe:1']).stdout;
  const first=frame(.3,180,230),second=frame(2.5,180,230);assert.ok(first[0]-first[2]>85&&second[2]-second[0]>85,'both selected originals appear in chosen order');
  const lower=run('ffmpeg',['-v','error','-i',accepted,'-vf','crop=360:138:0:496,format=gray','-frames:v','1','-f','rawvideo','pipe:1']).stdout;
  assert.ok([...lower].filter(v=>v>175).length>250,'the introduction is burned into picture');
  f.s.approve(ctx,{...approve,requestId:rid(),workVersion:2});assert.equal(f.ask(A).workRef.workVersion,2);
  assert.throws(()=>f.s.openOldVideo(ctx,w1),ec('WORK_NOT_AVAILABLE'));assert.equal(f.s.openOldVideo(ctx,w2).sha256,w2.sha256);
  f.cat.update(ctx,{requestId:rid(),productId:A,expectedVersion:2,changes:[{field:'price',source:'manual',value:99,unit:'元'}]});
  assert.equal(f.s.listWorks(ctx,A).every(w=>w.status==='stale'),true);assert.equal(f.ask(A).outcome,'needs_review');
  assert.throws(()=>f.s.openOldVideo(ctx,w2),ec('WORK_NOT_AVAILABLE'));assert.throws(()=>f.s.approve(ctx,{...approve,requestId:rid()}),ec('TASK_REVIEW_REQUIRED'));
  assert.throws(()=>f.s.render(ctx,make),ec('TASK_REVIEW_REQUIRED'));
  assert.equal(f.count('studio_works'),2);assert.equal(f.count('content_tasks'),2);assert.equal(f.s.listWorks(ctx,B).length,0);
});
test('damaged or withdrawn published revision is not delivered; a new explicit choice can produce a different task',async t=>{
  const f=await fixture(t),{A,ids}=f;f.copy(A);const ch=f.choice(A,[ids[0]]),q=f.ask(A),w=f.s.render(ctx,{taskId:q.taskId,requestId:rid()});
  f.s.approve(ctx,{...w,requestId:rid()});assert.equal(f.ask(A).outcome,'existing_available');
  const file=path.join(f.mediaRoot,readdirSync(f.mediaRoot)[0]),original=readFileSync(file);writeFileSync(file,Buffer.from('broken MP4'));
  assert.throws(()=>f.s.openOldVideo(ctx,w),ec('WORK_NOT_AVAILABLE'));assert.equal(f.ask(A).outcome,'needs_review');
  assert.equal(f.s.listWorks(ctx,A)[0].status,'needs_review');writeFileSync(file,original);
  const oldId=rid();assert.equal(f.ask(A,{requestId:oldId}).outcome,'existing_available');
  f.s.revokeChoice(ctx,{productId:A,choiceId:ch.choiceId,requestId:rid()});
  assert.equal(f.ask(A,{requestId:oldId}).outcome,'needs_review');assert.equal(f.ask(A).outcome,'needs_review');
  assert.throws(()=>f.s.openOldVideo(ctx,w),ec('WORK_NOT_AVAILABLE'));
  const renewed=f.choice(A,[ids[1]]),next=f.ask(A);
  assert.equal(next.outcome,'queued');assert.notEqual(next.taskId,q.taskId);assert.notEqual(renewed.choiceId,ch.choiceId);
  assert.throws(()=>f.s.openOldVideo(ctx,w),ec('WORK_NOT_AVAILABLE'));assert.equal(f.count('studio_works'),1);
});
