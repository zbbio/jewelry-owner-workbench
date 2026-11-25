import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const env=process.env;
const out=resolve(env.ALBUM_A1_RUN_DIR);
const r2=resolve(env.ALBUM_A1_R2), own='app/a/b/c/相册仓/backend/';
assert.equal(resolve(out,'r2-source'),r2);
const source=k=>import(pathToFileURL(join(r2,k)).href);
const sha=b=>createHash('sha256').update(b).digest('hex');
const selfRequire=createRequire(import.meta.url);
const packageInfo=JSON.parse(readFileSync(env.ALBUM_A1_SDK,'utf8'));
assert.equal(packageInfo.version,'0.22.0');
// Same function implementation exported by @openai/agents, without loading its
// provider/realtime umbrella. This non-billing test only needs tool and RunContext.
const core=resolve(env.ALBUM_A1_SDK_CORE,'dist');
const {tool}=await import(pathToFileURL(join(core,'tool.mjs')).href);
const {RunContext}=await import(pathToFileURL(join(core,'runContext.mjs')).href);

const {createAlbumRoute,BATCH_ROOT}=await source(own+'http.mjs');
const {createAlbumClassifyBatch,albumClassifyBatchToolDefinition,VERSION}=await source(own+'album-classify-tool.mjs');
const {createProductRead}=await source('backend/product-read.mjs');
const {createP2Review}=await source('backend/G1HANDOFF/p2-review.mjs');
const {canReadPhoto}=await source('backend/G1HANDOFF/p2-authority.mjs');
const {createLocalPixelVision}=await source('backend/pixel-vision.mjs');
const {createMessageLedger}=await source('backend/message-ledger.mjs');
const {createCatalog}=await source('app/店主工作台/catalog/index.mjs');
const r2ui=selfRequire(join(r2,'n22-ui/n22-app.js'));
const TURN='/api/n22/turn';
const now=()=>new Date().toISOString();
const imageFixture=JSON.parse(execFileSync(env.ALBUM_A1_PYTHON,['-I','-B','-c',
  'import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])["fixtures"]()))',env.ALBUM_A1_FIXTURE],
  {encoding:'utf8',timeout:10000,maxBuffer:5*1024*1024,windowsHide:true}));
assert(imageFixture.length>=3);

test('店主从同条普通消息要求照片按品类分、不建档：实际 r2 接收、实际 SDK 调用和分类回执',async t=>{
  const db=new DatabaseSync(join(out,'test-album.sqlite'));
  const catDb=new DatabaseSync(join(out,'test-catalog.sqlite'));
  const messages=createMessageLedger(join(out,'test-messages.sqlite'));
  const owner=Object.freeze({shopId:'n99-a1-drawn',actorId:'n99-a1-owner',sessionId:randomUUID(),role:'owner'});
  const f=[imageFixture[0],imageFixture[1],imageFixture[2],imageFixture[0]];
  const hashes=f.map(x=>sha(Buffer.from(x,'base64')));
  const declared={shopId:owner.shopId,sourceVersion:'a1-drawn-v1',approvalRef:'a1-local-drawn-record'};
  const index=Buffer.from(JSON.stringify({schema:'n22-original-label-index/v1',...declared,records:[
    {sha256:hashes[1],status:'approved',objectRef:'synthetic-item-2',category:'bracelet',evidenceRef:'drawn-original-label-2'}
  ]}));
  writeFileSync(join(out,'p2-original-label-index.v1.json'),index,{mode:0o600,flag:'wx'});
  const album=createAlbumRoute({db,dataDir:out,originalLabelSource:{enabled:true,...declared,indexSha256:sha(index)}});
  assert.equal(album.originalLabelSourceStatus().state,'ready');
  const p2=createP2Review({db,storeId:owner.shopId,messages,album,
    isCurrentOwner:s=>s===owner.sessionId,readLabelStatus:album.originalLabelSourceStatus});
  // The r2 read-only host has no approved write asset callback.
  const catalog=createCatalog({db:catDb,hasAsset:()=>false});
  catDb.exec('PRAGMA query_only=ON');
  const vision=await createLocalPixelVision({readAuthorizedAsset:album.readAuthorizedAsset,python:env.ALBUM_A1_PYTHON});
  assert.equal(vision.status.mounted,true);
  let readCount=0,visionCount=0,classificationCount=0,dropAfterRealClassify=false;
  const product=createProductRead({catalog,
    readAuthorizedBatch:(c,b)=>p2.ownsBatch(c,b)?album.readAuthorizedBatch(c,b):null,
    readLabel:album.readLabel,readLabelStatus:album.originalLabelSourceStatus,readHuman:p2.readHuman,
    authorizeP2Asset:(c,r)=>p2.ownsBatch(c,r.batchId)&&canReadPhoto(album,c,r),
    verifyDuplicate:(c,r)=>canReadPhoto(album,c,r),
    readVision:(c,r)=>{visionCount++;return vision.readVision(c,r);}
  });
  const conversationId=randomUUID(), active=new Map(), traces=[], requests=[];
  let origin, server;
  const scope=(c,t)=>c.role===owner.role&&c.shopId===owner.shopId&&c.actorId===owner.actorId&&c.sessionId===owner.sessionId&&
    active.get(t.requestId)?.runId===t.runId&&active.get(t.requestId)?.conversationId===t.conversationId&&
    active.get(t.requestId)?.batchId===t.batchId&&active.get(t.requestId)?.messageId===t.messageId;
  // The r2 P2 batch store really checks shop + actor + installation + source message.
  // Conversation/run admission is isolated test-only; P1/S1 own durable integration.
  const authorizeTurn=(c,t)=>scope(c,t)&&(t.batchId===null||p2.ownsBatch(c,t.batchId,t.messageId));
  const adapter=createAlbumClassifyBatch({
    album:{readAuthorizedBatch:(...a)=>{readCount++;return album.readAuthorizedBatch(...a);}},
    classify:async(c,q)=>{classificationCount++;const x=await product.classify(c,q);if(dropAfterRealClassify)active.delete(q.requestId);return x;},
    authorizeTurn
  });
  const mark=(x,batchId)=>Object.freeze({requestId:x.requestId,messageId:x.messageId,conversationId,runId:randomUUID(),batchId});
  const tallies=()=>({catalog:catDb.prepare('SELECT COUNT(*) AS n FROM catalog_products').get().n,
    links:catDb.prepare('SELECT COUNT(*) AS n FROM catalog_product_assets').get().n,
    catalogReceipts:catDb.prepare('SELECT COUNT(*) AS n FROM catalog_receipts').get().n,
    humanRows:db.prepare('SELECT COUNT(*) AS n FROM n22_p2_review').get().n,
    batches:db.prepare('SELECT COUNT(*) AS n FROM alb_task').get().n,
    originals:db.prepare('SELECT COUNT(*) AS n FROM alb_asset').get().n,
    groups:db.prepare('SELECT COUNT(*) AS n FROM alb_grp').get().n,
    handoffs:db.prepare('SELECT COUNT(*) AS n FROM alb_send').get().n});
  const initial=tallies();
  try {
    server=createServer(async(req,res)=>{
      const respond=(s,body)=>{res.writeHead(s,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
        ...(body.requestId?{'X-N22-Request-Id':body.requestId}:{})});res.end(JSON.stringify(body));};
      try {
        if(req.headers.host!==new URL(origin).host||req.headers.origin!==origin||req.method!=='POST')
          return respond(403,{error:{code:'A1_LOCAL_PROBE_ONLY'}});
        const pathname=new URL(req.url,origin).pathname;
        if(pathname===BATCH_ROOT){
          const end=res.end.bind(res);
          res.end=(chunk,...more)=>{if(res.statusCode===200)p2.noteBatch(owner,JSON.parse(String(chunk)));return end(chunk,...more);};
          await album.route({req,res,pathname,ctx:owner,origin});return;
        }
        if(pathname!==TURN)return respond(404,{error:{code:'NOT_FOUND'}});
        let size=0,chunks=[];
        for await(const buf of req){size+=buf.length;if(size>8192)throw Error('A1 request too long');chunks.push(buf);}
        const x=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // A1 scope: explicit function invocation in this harness; no text routing
        // (text is just data for the genuine r2 ordinary-message ledger).
        const receipt=await messages.execute(owner,x,async()=>{
          const n=mark(x,x.batchId??null);
          active.set(n.requestId,n);
          let actual;
          try{
            const functionTool=adapter.sdkTool({tool,ctx:owner,turn:n,onReceipt:r=>{assert(!actual);actual=r;}});
            assert.equal(functionTool.name,'album_classify_batch');
            assert.equal(functionTool.strict,true);
            assert.deepEqual(functionTool.parameters,albumClassifyBatchToolDefinition.parameters);
            const narrow=JSON.parse(await functionTool.invoke(new RunContext(), '{}'));
            assert(actual,'the installed SDK did not call the genuine adapter');
            traces.push({context:'synthetic A1 local only',requestId:n.requestId,messageId:n.messageId,tool:functionTool.name,
              businessReceipt:actual.status,sdkOutput:narrow,modelRequests:0});
            return actual;
          }finally{active.delete(n.requestId);}
        });
        respond(200,receipt);
      }catch(e){
        if(res.headersSent)return res.end();
        respond(e.httpStatus??500,{error:{code:e.code??'A1_FIXTURE_FAILURE'}});
      }
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    origin='http://127.0.0.1:'+server.address().port;
    const post=async (path,payload,n)=>{
      const j=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const b=await j.json();
      requests.push({n,path,http:j.status,requestId:payload.requestId,messageId:payload.messageId,...(payload.batchId?{batchId:payload.batchId}:{}),
        requestIdHeader:j.headers.get('x-n22-request-id'),body:b});
      assert.equal(j.status,200,JSON.stringify(b));
      assert.equal(j.headers.get('x-n22-request-id'),payload.requestId);
      return b;
    };
    const start=now(),mid=randomUUID(),uploadId=randomUUID();
    const batch=await post(BATCH_ROOT,{requestId:uploadId,messageId:mid,files:f},'current message asks to classify the chosen photos; keep originals');
    assert.equal(batch.messageId,mid);assert.equal(batch.requestId,uploadId);
    assert.deepEqual(batch.counts,{selected:4,kept:3,duplicate:1,failed:0});
    assert.deepEqual(batch.items.map(x=>x.sha256),hashes);
    assert.deepEqual(batch.items.map(x=>x.ordinal),[0,1,2,3]);
    assert.equal(batch.items[3].duplicateOf,batch.items[0].assetId);
    const before=tallies();
    assert.deepEqual(before,{...initial,batches:1,originals:3});
    const q={requestId:randomUUID(),messageId:mid,text:'把这批照片按品类分，先别建档',batchId:batch.batchId};
    const r=await post(TURN,q,'ordinary turn, explicitly dispatching only the bound A1 SDK callback (no model)');
    assert.equal(r.status,'completed');
    assert.equal(r.actions.length,1);assert.equal(r.actions[0].status,'classified_read_only');
    assert.equal(r.actions[0].result.batchOriginMessageId,q.messageId);
    assert(r2ui.classificationReceipt(r,batch,q)===r.actions[0].result,'genuine r2 UI rejects the tool-backed envelope');
    const display=r2ui.classification(r.actions[0].result,batch,r);
    assert.equal(display.size,2,'genuine r2 UI did not project two sourced classifications');
    const items=r.actions[0].result.items;
    assert.deepEqual(items.map(i=>[i.status,i.category,i.source]),[
      ['suggested','bangle','pixel_rule'],['classified','bracelet','original_label'],['pending',null,null],['duplicate',null,null]]);
    assert.equal(items[0].evidence.pixelRule.runtime,vision.status.runtime);
    assert.equal(items[1].evidence.originalLabel.evidenceRef,'drawn-original-label-2');
    assert.equal(items[1].evidence.originalLabel.sourceVersion,'a1-drawn-v1');
    assert.equal(items[2].evidence.pixelRule.decoded,true);
    assert.equal(items[3].duplicateOf,items[0].assetId);
    assert.deepEqual(r.actions[0].result.effects,{catalogCreated:0,catalogUpdated:0,cardAssetLinksAdded:0});
    assert.deepEqual(traces[0].sdkOutput.items,items.map((x,i)=>({ordinal:i+1,status:x.status,category:x.category,source:x.source})));
    assert(!JSON.stringify(traces[0].sdkOutput).includes(items[0].assetId));
    assert(!JSON.stringify(traces[0].sdkOutput).includes('thumbnailRef'));
    assert.deepEqual(tallies(),before);
    const afterReal={readCount,classificationCount,visionCount,traces:traces.length};
    assert.deepEqual(afterReal,{readCount:1,classificationCount:1,visionCount:3,traces:1});
    const saved=messages.restore(owner,mid);assert.deepEqual(saved,r);
    const replay=await post(TURN,q,'existing true r2 message ledger same request');assert.deepEqual(replay,{...r,replay:true});
    assert.deepEqual({readCount,classificationCount,visionCount,traces:traces.length},afterReal);
    const absent=await post(TURN,{requestId:randomUUID(),messageId:randomUUID(),text:q.text},'same ordinary command with no attached photos');
    assert.equal(absent.status,'needs_photos');assert.deepEqual(absent.actions,[]);
    const notThisMessage=await post(TURN,{...q,requestId:randomUUID(),messageId:randomUUID()},'old batch is not this message');
    assert.equal(notThisMessage.code,'BATCH_NOT_IN_SESSION');assert.deepEqual(notThisMessage.actions,[]);
    assert.equal(readCount,afterReal.readCount);assert.equal(classificationCount,afterReal.classificationCount);
    assert.equal(visionCount,afterReal.visionCount);
    const attacks=[];
    const n=mark({requestId:randomUUID(),messageId:mid},batch.batchId);active.set(n.requestId,n);
    for(const [name,c,k] of [
       ['other shop',{...owner,shopId:'n99-a1-other'},n],
       ['other owner actor same shop',{...owner,actorId:'other-actor'},n],
       ['other installation same owner',{...owner,sessionId:randomUUID()},n],
       ['other conversation',{...owner},{...n,conversationId:randomUUID()}],
       ['late old run',{...owner},{...n,runId:randomUUID()}]]){
      const x=await adapter.forTurn(c,k).invoke();
      assert.equal(x.code,'BATCH_NOT_IN_SESSION');assert.deepEqual(x.actions,[]);assert(!JSON.stringify(x).includes(batch.batchId));
      attacks.push({name,status:x.status,code:x.code,noActions:true});
    }
    await assert.rejects(adapter.forTurn(owner,n).invoke({batchId:batch.batchId}),{code:'ALBUM_TOOL_ARGUMENTS_NOT_EMPTY'});
    assert.equal(classificationCount,1);assert.equal(visionCount,3);assert.equal(readCount,1);
    // A read did take place while allowed; a revoke during it suppresses the
    // receipt, including per-photo facts, instead of publishing the late result.
    dropAfterRealClassify=true;
    const late=await adapter.forTurn(owner,n).invoke();
    assert.equal(late.code,'BATCH_NOT_IN_SESSION');assert.deepEqual(late.actions,[]);
    assert.equal(classificationCount,2);assert.equal(visionCount,6);assert.equal(readCount,2);
    const done=tallies();assert.deepEqual(done,before);assert.equal(sha(readFileSync(join(out,'p2-original-label-index.v1.json'))),sha(index));
    const receipt={ticket:'N99-FIVE-M1/A1',exit:0,startedUTC:start,endedUTC:now(),version:VERSION,
      boundary:'real r2 source modules and r2 DOM parser shape; isolated local HTTP and SDK function callback (no Runner/model or device)',
      loopbackOrigin:origin,r2PythonRule:vision.status,counts:{initial,afterActualIntake:before,afterAllTests:done},
      modelRequests:0,deviceOperations:0,requests,sdkReceipts:traces,exactReplayWithoutNewClassification:true,rejections:attacks,
      stalePostReadSuppressed:{status:late.status,code:late.code},extraModelBatchArgumentRejected:true,
      aggregate:{r2Assets:afterReal.visionCount,realClassifications:classificationCount,realPixelCalculations:visionCount},
      ordinaryUI:{admittedEnvelope:true,sourcedRows:display.size,actualBrowser:false}};
    writeFileSync(join(out,'实测回执.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    t.diagnostic('HTTP 200 ×'+requests.length+'; actual SDK @openai/agents '+packageInfo.version+
      '; classifier results suggested/classified/pending/duplicate=1/1/1/1; missing=needs_photos; wrong owner/turn/revoked denied; cards/links/receipts=0');
  }finally{
    if(server?.listening){server.close();server.closeAllConnections();await once(server,'close');}
    messages.close();catDb.close();db.close();
  }
});

test('拒绝失配回执、非零商品副作用、被撤素材伪装及拼入模型提供的其它参数',async()=>{
  const ctx={shopId:'fixture',actorId:'owner',sessionId:'local-installation',role:'owner'};
  const turn={requestId:'request-a',messageId:'message-a',conversationId:'thread-a',runId:'run-a',batchId:'batch-a'};
  const batch={shopId:ctx.shopId,requestId:'original-upload',messageId:turn.messageId,batchId:'batch-a',
    assets:[{assetId:'asset-a',itemId:'item-a',status:'kept'}]};
  const baseline={storeId:ctx.shopId,requestId:turn.requestId,messageId:turn.messageId,batchId:'batch-a',batchOriginMessageId:turn.messageId,
    status:'classified_read_only',items:[{itemId:'item-a',assetId:'asset-a',category:null,source:null,status:'pending'}],
    counts:{classified:0,suggested:0,pending:1,duplicate:0,unreadable:0,not_authorized:0},
    effects:{catalogCreated:0,catalogUpdated:0,cardAssetLinksAdded:0}};
  const fixture=x=>createAlbumClassifyBatch({album:{readAuthorizedBatch:()=>batch},classify:()=>x,authorizeTurn:()=>true});
  const call=x=>fixture(x).forTurn(ctx,turn).invoke();
  assert.equal((await call(baseline)).status,'completed');
  for(const x of [{...baseline,storeId:'wrong'}, {...baseline,batchOriginMessageId:'other'},
      {...baseline,effects:{...baseline.effects,catalogCreated:1}},
      {...baseline,productId:'card-from-nowhere'},
      {...baseline,items:[{...baseline.items[0],assetId:'other'}]},
      {...baseline,items:[{...baseline.items[0],status:'not_authorized'}]},
      {...baseline,items:[{...baseline.items[0],thumbnailRef:'/another-photo'}]}]){
    const r=await call(x);
    assert.equal(r.status,'failed');assert.equal(r.code,'ALBUM_CLASSIFICATION_UNAVAILABLE');assert.deepEqual(r.actions,[]);
  }
  assert.throws(()=>createAlbumClassifyBatch({album:{readAuthorizedBatch:()=>batch},classify:()=>baseline}),TypeError);
  const denied=fixture(baseline);
  assert.throws(()=>denied.forTurn({...ctx,role:'visitor'},turn),{code:'SESSION_REQUIRED'});
  await assert.rejects(denied.forTurn(ctx,turn).invoke({text:'classify'}),{code:'ALBUM_TOOL_ARGUMENTS_NOT_EMPTY'});
  const falseRun=denied.sdkTool({tool,ctx,turn,onReceipt:()=>assert.fail('invalid model args must not reach recording')});
  assert.deepEqual(JSON.parse(await falseRun.invoke(new RunContext(),'{"assetId":"other"}')),
     {status:'failed',code:'ALBUM_TOOL_CALL_REJECTED'});
});
