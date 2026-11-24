import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const sha = v => createHash('sha256').update(v).digest('hex');
const workRef = w => ({workId:w.workId,workVersion:w.workVersion});
const cmd = (bin,args,encoding='utf8') => {
  const p=spawnSync(bin,args,{encoding,windowsHide:true,timeout:45000,maxBuffer:4*1024*1024});
  assert.equal(p.status,0,String(p.stderr||p.error));
  return p.stdout;
};

test('Approved selection survives new draft and restart; exact HTTP bytes, B isolation, and desktop decode', {timeout:180000}, async t => {
  const run=mkdtempSync(path.join(tmpdir(),'desktop-video-readback-'));
  const data=mkdtempSync(path.join(run,'http-store-'));
  t.after(async()=>{try{await stop()}finally{rmSync(run,{recursive:true,force:true,maxRetries:5})}});
  const code=randomUUID(), logs=[];
  let child,base,cookie;
  async function stop(){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const exited=once(child,'exit');
    child.kill();await exited;
  }
  async function start(){
    cookie=undefined; base=undefined;
    child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),windowsHide:true,env:{...process.env,
      WORKBENCH_DATA:data,WORKBENCH_SHOP:'public-test-fixture',PORT:'0',WORKBENCH_REQUIRE_LOGIN:'1',WORKBENCH_PILOT_CODE:code},stdio:['ignore','pipe','pipe']});
    let seen='';
    child.on('error',e=>logs.push(String(e)));
    child.stdout.on('data',v=>{logs.push(String(v)); seen+=String(v);base=seen.match(/LOCAL (http:\/\/127\.0\.0\.1:\d+)/)?.[1];});
    child.stderr.on('data',v=>logs.push(String(v)));
    for(let n=0;n<150&&!base&&child.exitCode===null;n++)await wait(100);
    assert.ok(base,logs.join(''));
    const r=await fetch(base+'/api/pilot/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({requestId:rid(),code})});
    assert.equal(r.status,200);cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
    await r.arrayBuffer();
  }
  const rid=()=>randomUUID();
  const request=(url,options={})=>fetch(base+url,{...options,headers:{...(options.auth===false?{}:{Cookie:cookie}),...options.headers}});
  async function json(url,body,status=200){
    const r=await request(url,body===undefined?{}:{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const payload=await r.json();assert.equal(r.status,status,JSON.stringify(payload));return payload;
  }
  async function take(url,{method='GET',range,status=200,auth=true}={}){
    const r=await request(url,{method,auth,headers:range?{Range:range}:{}});
    assert.equal(r.status,status,method+' '+url+' '+range);
    const bytes=Buffer.from(await r.arrayBuffer()),headers=Object.fromEntries(r.headers);
    return {bytes,headers,status};
  }
  await start();
  cmd(process.env.ALBUM_PYTHON||'python',['-B','-c',
    'from PIL import Image, ImageDraw\nimport os,sys\nfor i,c in enumerate([(212,53,41),(34,74,211),(30,174,82)]):\n im=Image.new("RGB",(96,96),c); ImageDraw.Draw(im).ellipse((18,18,78,78),outline=(240,240,233),width=4); im.save(os.path.join(sys.argv[1],str(i)+".png"))',data]);
  const batch=await json('/api/import',{requestId:rid(),files:[0,1,2].map(i=>readFileSync(path.join(data,i+'.png')).toString('base64'))});
  assert.equal(batch.pendingAssetIds.length,3);
  const xs=batch.items.map(x=>x.assetId);
  await json('/api/resolve',{requestId:rid(),taskId:batch.taskId,groups:[{assetIds:xs.slice(0,2)},{assetIds:xs.slice(2)}]});
  const cards=await json('/api/cards');assert.equal(cards.length,2);
  const A=cards.find(c=>c.assetIds.includes(xs[0])), B=cards.find(c=>c.assetIds.includes(xs[2]));
  assert.deepEqual(A.assetIds,xs.slice(0,2));assert.deepEqual(B.assetIds,xs.slice(2));
  const a='/api/cards/'+A.productId, b='/api/cards/'+B.productId;
  const copy=await json(a+'/copy',{requestId:rid(),expectedVersion:A.productVersion,text:'Synthetic demo'});
  const pv=copy.productVersion;
  async function choose(assetIds){
    const choice=await json(a+'/video/setup',{requestId:rid(),expectedVersion:pv,assetIds,rightsConfirmed:true,style:'portrait_card'});
    return json(a+'/video',{requestId:rid(),expectedVersion:pv,choiceId:choice.choiceId});
  }
  async function queue(assetIds){
    const task=await choose(assetIds);
    assert.equal(task.outcome,'queued');assert.equal(task.deliveryStatus,'not_submitted');
    assert.equal(task.productId,A.productId);assert.ok(task.taskId);
    return {url:'/api/video/tasks/'+task.taskId,taskId:task.taskId};
  }
  async function render(task){
    const work=await json(task.url+'/render',{requestId:rid()});assert.equal(work.status,'awaiting_approval');
    return {...task,work};
  }
  const first=await render(await queue(xs.slice(0,2)));
  const w1=first.work, ref1=workRef(w1);
  const rel='/works/'+w1.workId, v1=a+rel+'/1/play', v2=a+rel+'/2/play', pr2=a+rel+'/2/preview';
  // The request endpoint is reuse-first and has no force-new intent.
  const queuedSecond=await queue(xs.slice(0,2).reverse());
  const confirmed=await json(first.url+'/confirm',{requestId:rid(),workVersion:1});
  assert.equal(confirmed.status,'approved');assert.deepEqual(workRef(confirmed),ref1);
  const before=await take(v1);assert.equal(sha(before.bytes),w1.sha256);
  const second=await render(queuedSecond); const w2=second.work;
  assert.notEqual(second.taskId,first.taskId);assert.equal(w2.workId,w1.workId);assert.equal(w2.workVersion,2);
  assert.notEqual(w2.sha256,w1.sha256);
  assert.equal(sha((await take(pr2)).bytes),w2.sha256);
  const badConfirm=await json(second.url+'/confirm',{requestId:rid(),workVersion:1},409);
  assert.equal(badConfirm.error.code,'VERSION_CONFLICT');
  await stop();await start();
  const aList=await json(a+'/video'), bList=await json(b+'/video');
  assert.deepEqual(aList.works.map(w=>[w.workVersion,w.status,w.playUrl??null]),[[2,'awaiting_approval',null],[1,'approved',v1]]);
  assert.equal(aList.tasks.length,2);assert.deepEqual(bList.works,[]);assert.deepEqual(bList.tasks,[]);
  const saleRequest={requestId:rid(),sessionId:'fixture-consultation',productId:A.productId,question:'请给我看这条的视频'};
  const sale=await json('/api/sales/ask',saleRequest);
  assert.equal(sale.video.outcome,'existing_available');assert.equal(sale.video.productId,A.productId);assert.equal(sale.video.productVersion,pv);
  assert.equal(sale.video.deliveryStatus,'not_submitted');assert.equal(sale.video.retrievalStatus,'playable');assert.deepEqual(sale.video.workRef,ref1);
  const cardDemand=await json(a+'/video',{requestId:rid(),expectedVersion:pv});
  assert.deepEqual(cardDemand.workRef,ref1);assert.equal(cardDemand.outcome,'existing_available');
  const saleB=await json('/api/sales/ask',{...saleRequest,requestId:rid(),productId:B.productId});
  assert.equal(saleB.video.productId,B.productId);assert.equal(saleB.video.outcome,'needs_review');assert.equal(saleB.video.workRef,undefined);
  for(const url of [v2,b+rel+'/1/play',b+rel+'/2/preview',a+rel+'/3/play'])await take(url,{range:'bytes=0-31',status:404});
  const approvedCardVersion=String(pv);
  const pinned=v1+'?productVersion='+approvedCardVersion;
  assert.equal(aList.works.find(w=>w.workVersion===1).pinnedPlayUrl,pinned);
  const pinnedBytes=await take(pinned,{range:'bytes=0-31',status:206});
  const legacyBytes=await take(v1,{range:'bytes=0-31',status:206});
  assert.deepEqual(pinnedBytes.bytes,legacyBytes.bytes);
  await take(v1+'?productVersion='+(Number(approvedCardVersion)+1),{range:'bytes=0-31',status:409});
  await take(v1+'?productVersion=invalid',{range:'bytes=0-31',status:400});
  await take(pinned+'&productVersion='+approvedCardVersion,{range:'bytes=0-31',status:400});
  await take(v1,{range:'bytes=0-31',status:401,auth:false});

  const head=await take(v1,{method:'HEAD'}), n=Number(head.headers['content-length']);
  assert.equal(head.bytes.length,0);assert.equal(n,before.bytes.length);
  assert.equal(head.headers['accept-ranges'],'bytes');assert.equal(head.headers['content-type'],'video/mp4');
  const cut=Math.floor(n/2);
  const left=await take(v1,{range:'bytes=0-'+(cut-1),status:206}), right=await take(v1,{range:'bytes='+cut+'-',status:206}),
    tail=await take(v1,{range:'bytes=-16',status:206}), invalid=await take(v1,{range:'bytes='+n+'-',status:416});
  for(const [segment,lo,hi] of [[left,0,cut-1],[right,cut,n-1],[tail,n-16,n-1]]){
    assert.equal(segment.headers['content-range'],'bytes '+lo+'-'+hi+'/'+n);
    assert.equal(Number(segment.headers['content-length']),hi-lo+1);
    assert.deepEqual(segment.bytes,before.bytes.subarray(lo,hi+1));
  }
  assert.equal(invalid.headers['content-range'],'bytes */'+n);assert.equal(invalid.bytes.length,0);
  const assembled=Buffer.concat([left.bytes,right.bytes]);assert.equal(sha(assembled),w1.sha256);
  const sample=path.join(run,'A-v1.from-ranges.mp4');writeFileSync(sample,assembled);

  const probeArgs=['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,nb_frames,duration','-of','json',sample];
  const probe=JSON.parse(cmd('ffprobe',probeArgs)).streams[0];
  const decodeArgs=['-hide_banner','-v','error','-xerror','-err_detect','explode','-i',sample,'-map','0:v:0','-fps_mode','passthrough','-progress','pipe:1','-nostats','-f','null','-'];
  const decoded=cmd('ffmpeg',decodeArgs);
  assert.equal(probe.codec_name,'h264');assert.equal(probe.nb_frames,'48');assert.equal(probe.width,360);assert.equal(probe.height,640);assert.equal(Number(probe.duration),4);
  assert.equal([...decoded.matchAll(/^frame=(\d+)\r?$/gm)].at(-1)?.[1],'48');assert.match(decoded,/progress=end/);
  const explicitAfterApproval=await choose([xs[0]]);
  assert.equal(explicitAfterApproval.outcome,'existing_available');
  assert.deepEqual(explicitAfterApproval.workRef,ref1);
  assert.equal(explicitAfterApproval.taskId,undefined);
  const finalCard=await json(a+'/video');
  assert.equal(finalCard.choice.status,'ready');
  assert.equal(finalCard.tasks.length,2);
});
