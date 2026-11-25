import {canReadPhoto} from './G1HANDOFF/p2-authority.mjs';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createProductRead} from './product-read.mjs';
import {createMessageLedger} from './message-ledger.mjs';
import {createLocalPixelVision} from './pixel-vision.mjs';
import {mountG2} from './g2-service.mjs';
import {createC1SoloTurn} from './c1-solo.mjs';
import {createP1ReadTurn} from './p1-read-turn.mjs';

const spec={
  catalog_products:['shop_id','product_id','product_version','fields_json'],
  catalog_product_assets:['shop_id','asset_id','product_id','ordinal'],
  catalog_inventory:['shop_id','product_id','status','quantity','verified_at','verified_by','evidence_ref'],
  catalog_copy_versions:['shop_id','product_id','copy_id','version','product_version','body','confirmed_by','confirmed_at'],
  catalog_receipts:['shop_id','operation','request_id','body_json','receipt_json']
};
const hash=b=>createHash('sha256').update(b).digest('hex');
function object(x){return x&&typeof x==='object'&&!Array.isArray(x);}
export async function createN22Wire(cfg,serverOnly={}){
  const stockModule=Object.hasOwn(cfg,'n22StockFixture')?await import('./stock-scope.mjs'):null;
  const stockFile=stockModule?.stockFixturePath(cfg,serverOnly);
  if(cfg.n22S4RevocationTrial&&(!stockFile||!['index','no_index'].includes(cfg.n22S4RevocationTrial)))throw Error('S4_REVOCATION_TRIAL_ONLY');
  let stockScope=null;
  const writeCode=cfg.n22WriteFixture===true?await import('./p34-write.mjs'):null;
  const cardFlow=cfg.n22CardPage!=null||cfg.n22PlanGrant!=null;
  if(cardFlow&&(!writeCode||!cfg.n22CardPage||!cfg.n22PlanGrant||cfg.n22D3Fixture!==true||cfg.n22D2Fixture||cfg.n22StockFixture||
     cfg.n22G1Handoff||cfg.modelPolicy!=='disabled'||cfg.modelSecretFile||cfg.n22Adapters?.sales||serverOnly.g2||
     typeof serverOnly.isCurrentOwner!=='function'))throw Error('PLANGRANT_PROFILE_DENIED');
  if(Object.hasOwn(cfg,'n22C2TextTrial')&&(!cardFlow||cfg.n22C2TextTrial!==true))throw Error('C2TEXT_ISOLATED_PROFILE_ONLY');
  if(writeCode)writeCode.assertP34Fixture(cfg);
  if(cfg.n22D2Fixture===true&&(!writeCode||typeof serverOnly.isCurrentOwner!=='function'))throw Error('D2_REQUIRES_ISOLATED_WRITE_PROFILE');
  if(cfg.n22D3Fixture===true&&!writeCode)throw Error('D3_REQUIRES_ISOLATED_WRITE_PROFILE');
  const sliceBytes=readFileSync(cfg.n22CatalogSlice);
  if(hash(sliceBytes)!==cfg.n22CatalogSha256)throw Error('N22_CATALOG_DIGEST_MISMATCH');
  const slice=JSON.parse(sliceBytes.toString('utf8'));
  if(slice.storeId!==cfg.storeRef||!object(slice.rows)||!object(slice.aliases))throw Error('N22_CATALOG_SCOPE');
  const {createCatalog}=await import(pathToFileURL(cfg.n22CatalogSource).href);
  const dbFile=writeCode?join(cfg.stateDir,'n22-write-catalog.sqlite'):':memory:';
  const db=new DatabaseSync(dbFile);
  if(cfg.n22G1Handoff===true&&(!serverOnly.g1Review||writeCode||cfg.allowAndroidHost!==false||cfg.modelPolicy!=='disabled'||cfg.modelSecretFile||
     !Number.isInteger(Number(String(cfg.origin).split(':').at(-1)))||!/^http:\/\/127\.0\.0\.1:\d{5}$/u.test(cfg.origin)))
     throw Error('P2_REVIEW_ISOLATED_PROFILE_REQUIRED');
  const labels=cfg.n22OriginalLabelSource;
  if(Object.hasOwn(cfg,'n22OriginalLabelSource')&&(!(cfg.n22G1Handoff===true||cfg.n22D2Fixture===true&&writeCode)||
     labels?.enabled!==true||labels.shopId!==cfg.storeRef||cfg.modelPolicy!=='disabled'||cfg.modelSecretFile))
    throw Error('P2_LABEL_EXPLICIT_PROFILE_REQUIRED');
  let write=null,p2Review=null,planningGrant=null;
  const actual=createCatalog({db,hasAsset:(ctx,id)=>write?.isApprovedAsset(ctx,id)===true});
  function importRows(schema){for(const [table,keys] of Object.entries(schema)){
    const insert=db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')');
    if(!Array.isArray(slice.rows[table]))throw Error('N22_CATALOG_ROWS');
    for(const row of slice.rows[table]){
      if(row.length!==keys.length||row[0]!==cfg.storeRef)throw Error('N22_CATALOG_ROW_SCOPE');
      insert.run(...row);
    }
  }}
  importRows(spec);
  const catalog=Object.freeze({list:actual.list,get:actual.get,getSummary:actual.getSummary});
  const adapters={};
  for(const owner of ['album','sales','content']){
    const x=cfg.n22Adapters?.[owner];
    if(!x)continue;
    if(!object(x)||!isAbsolute(x.file)||typeof x.export!=='string')throw Error('N22_ADAPTER_CONFIG');
    // Operator pin only, no dynamic import from a network URL or from a request.
    const allowed=resolve(cfg.n22Root,{album:'相册仓',sales:'销售仓',content:'内容仓'}[owner]);
    const tail=relative(allowed,x.file);
    if(tail==='..'||tail.startsWith('..'+sep)||isAbsolute(tail)||!existsSync(x.file))throw Error('N22_ADAPTER_PATH');
    if(hash(readFileSync(x.file))!==x.sha256)throw Error('N22_ADAPTER_DIGEST_MISMATCH');
    const mod=await import(pathToFileURL(x.file).href);
    if(typeof mod[x.export]!=='function')throw Error('N22_ADAPTER_FACTORY');
    adapters[owner]={mod,file:x.file,factory:mod[x.export]};
  }
  const messages=createMessageLedger(join(cfg.stateDir,'n22-messages.sqlite'));
  const deployed={}, albumDb=adapters.album?new DatabaseSync(join(cfg.stateDir,'n22-album.sqlite')):null;
  let contentHealth=null;
  const joined=cfg.n22D2Fixture===true;
  if(adapters.album)deployed.album=adapters.album.factory({db:albumDb,dataDir:cfg.stateDir,
    ...(labels?{originalLabelSource:labels}:{}),...(joined?{
    authorizeBatchReference:(c,x)=>write?.ownsBatch(c,x.batchId,x.messageId)===true,
    catalogRead:{list:c=>write.catalogRead.list(c),get:(c,id)=>write.catalogRead.get(c,id)},
    authorizeDelivery:(c,x)=>write.authorizeDelivery(c,x),catalogWrite:{acceptGroup:(c,x)=>write.acceptDraftHandoff(c,x)}
  }:{})});
  if(adapters.content){
    const {createStudio}=await import(pathToFileURL(cfg.n22StudioSource).href);
    const archive=JSON.parse(readFileSync(cfg.contentArchive,'utf8')), sources=JSON.parse(readFileSync(join(cfg.materialDir,'materials.json'),'utf8'));
    if(archive.shopId!==cfg.storeRef||sources.storeId!==cfg.storeRef||!isAbsolute(archive.privateMedia?.absolutePath))
      throw Error('N22_ORIGINAL_CONTENT_SCOPE');
    const shots=new Map(Object.values(sources.cards).flat().map(x=>[x.assetId,x]));
    const albumRead=Object.freeze({readAsset(c,id){
      if(c.shopId!==cfg.storeRef||!shots.has(id))return null;
      const p=shots.get(id),bytes=readFileSync(join(cfg.materialDir,'assets',id));
      return hash(bytes)===p.sha256?{bytes,mime:p.mime}:null;
    }});
    const studio=createStudio({db,catalog,album:albumRead,mediaRoot:dirname(archive.privateMedia.absolutePath)});
    importRows({
      studio_choices:['shop','id','product','pver','version','template','shots','confirmed_by','confirmed_at','revoked'],
      studio_works:['shop','product','pver','work','version','task','choice','media_key','digest','status','info','approved_by','approved_at']
    });
    const studioRead={listWorks:studio.listWorks,openOldVideo:studio.openOldVideo};
    deployed.content=adapters.content.factory({studio:studioRead,authorizeMessage:messages.authorize,deadlineMs:18000});
    if(cfg.n22ContentDoctor===true){
      const {checkContentReadiness}=await import(pathToFileURL(join(cfg.n22Root,'内容仓','C4SHIP','content-doctor.mjs')).href);
      const {createInstalledClipProbe}=await import('./content-probe.mjs');
      const detail=await checkContentReadiness({enableProduction:false,probeExisting:createInstalledClipProbe({
        origin:cfg.origin,shopId:slice.storeId,makeReader:adapters.content.factory,studio:studioRead,
        catalog,aliases:slice.aliases,materials:sources,archive})});
      contentHealth=Object.freeze({readProbe:detail.oldClip.readProbe,
        ready:detail.oldClip.ready===true&&detail.oldClip.readProbe==='passed',production:'disabled'});
    }
  }
  if(cfg.n22ContentDoctor===true&&!contentHealth)contentHealth=Object.freeze({ready:false,readProbe:'not_configured',production:'disabled'});
  if(writeCode){
    if(!deployed.album)throw Error('P34_FIXTURE_ALBUM_REQUIRED');
    if(joined&&(!deployed.album.draftTurn||!deployed.album.draft?.checkMessageGroup||!deployed.album.draft?.handoff))
      throw Error('D2_ACTUAL_DRAFT_ADAPTER_REQUIRED');
    write=writeCode.createP34Write({db,catalog:actual,album:deployed.album,storeId:cfg.storeRef,readReference:messages.reference,readMessage:messages.restore,draftJoin:joined,planPairMode:cardFlow,isCurrentOwner:serverOnly.isCurrentOwner});
  }else db.exec('PRAGMA query_only=ON');
  // The only live visual adapter reads bytes via this authenticated batch. Never delegate to a remote model.
  const localVision=await createLocalPixelVision({readAuthorizedAsset:deployed.album?.readAuthorizedAsset,
    python:cfg.n22PixelPython});
  let refVision=null;
  if(cfg.n22ReferencePolicySha256){
    if(cfg.origin!=='http://127.0.0.1:17872'||cfg.allowAndroidHost!==false||cfg.n22WriteFixture||
       cfg.modelPolicy!=='disabled'||cfg.modelSecretFile||
       !resolve(cfg.stateDir).startsWith(resolve(cfg.n22Root,'商品仓','仅本机只读')+sep+'test-g1-'))
      throw Error('G1_ISOLATED_REFERENCE_PROFILE_REQUIRED');
    const worker=resolve(cfg.n22Root,'商品仓','G1HOLD','reference-vision.mjs');
    if(hash(readFileSync(worker))!==cfg.n22ReferenceAdapterSha256)throw Error('G1_ADAPTER_SHA_MISMATCH');
    const {createReferenceVision}=await import(pathToFileURL(worker).href);
    refVision=await createReferenceVision({readAuthorizedAsset:deployed.album?.readAuthorizedAsset,
      python:cfg.n22PixelPython,freezeSha:cfg.n22ReferencePolicySha256});
  }
  const readLabelStatus=()=>{
    const view=deployed.album?.originalLabelSourceStatus?.();
    return labels&&view?.state!=='ready'?{...view,state:'unavailable',sourceVersion:labels.sourceVersion}:view;
  };
  if((joined||cfg.n22G1Handoff===true)&&deployed.album){
    if(typeof deployed.album.readLabel!=='function'||typeof deployed.album.readAuthorizedAsset!=='function'||
       typeof deployed.album.originalLabelSourceStatus!=='function')throw Error('P2_LABEL_ALBUM_PORTS_REQUIRED');
    const {createP2Review}=await import('./G1HANDOFF/p2-review.mjs');
    p2Review=createP2Review({db:albumDb,storeId:cfg.storeRef,messages,album:deployed.album,batchAuthority:joined?write:null,
      isCurrentOwner:serverOnly.isCurrentOwner,readLabelStatus});
  }
  const channelRead=Object.hasOwn(cfg,'n22ExternalRead')?(await import('./channel-read.mjs')).createLocalChannelRead({
    cfg,catalog,isCurrentOwner:serverOnly.isCurrentOwner,enabled:serverOnly.externalTrial}):null;
  const product=createProductRead({catalog,channelRead,aliases:ctx=>ctx.shopId===slice.storeId?slice.aliases:{},
    readReference:messages.reference,
    readAuthorizedBatch:async(...a)=>{
      if(!deployed.album?.readAuthorizedBatch)throw Error('N22_AUTHORIZED_BATCH_NOT_MOUNTED');
      if((joined||cardFlow)&&!write.ownsBatch(a[0],a[1])||p2Review&&!p2Review.ownsBatch(a[0],a[1]))return null;
      const read=await deployed.album.readAuthorizedBatch(...a);
      return read?{...read,assets:read.assets.map(x=>({...x,status:x.status==='failed'?'unreadable':x.status}))}:read;
    },readLabel:(...a)=>deployed.album?.readLabel?.(...a),readLabelStatus,readVision:(refVision??localVision).readVision,
    authorizeP2Asset:p2Review?(c,p)=>p2Review.ownsBatch(c,p.batchId)&&canReadPhoto(deployed.album,c,p):undefined,
    readHuman:p2Review?.readHuman,
    verifyDuplicate:(c,x)=>{const f=deployed.album?.readAuthorizedAsset?.(c,x.batchId,x.assetId);return !!f?.bytes&&hash(f.bytes)===x.sha256;}});
  if(cfg.n22D3Fixture===true){
    const {mountD3,fixturePolicy}=await import('./d3-fixture.mjs');
    if(cardFlow){
      const f=join(cfg.n22Root,cfg.n22PlanGrant.relative);
      if(hash(readFileSync(f))!==cfg.n22PlanGrant.sha256)throw Error('PLANGRANT_SOURCE_PIN');
      const {createProductPlanningGrant}=await import(pathToFileURL(f).href);
      planningGrant=createProductPlanningGrant({db,catalog:actual,album:deployed.album,messages,p34:write,
        storeId:cfg.storeRef,policy:fixturePolicy(cfg),isCurrentOwner:serverOnly.isCurrentOwner});
    }
    deployed.d3=await mountD3({cfg,db,catalog,album:deployed.album,product,messages,
      ...(planningGrant?{readPlanningGrant:planningGrant.readContentPlanningGrant,isCurrentOwner:serverOnly.isCurrentOwner}:{})});
  }
  const g2=adapters.sales&&serverOnly.g2?await mountG2({cfg,ports:serverOnly.g2,sales:adapters.sales,catalog,
    aliases:slice.aliases,hasContent:!!deployed.content}):null;
  if(stockFile&&typeof adapters.sales?.mod?.stockReminderIntent!=='function')throw Error('S3_SALES_ADAPTER_REQUIRED');
  const isSalesOwner=c=>c?.role==='owner'&&c.shopId===slice.storeId&&!!c.sessionId&&
    (!serverOnly.isCurrentOwner||serverOnly.isCurrentOwner(c.sessionId)===true);
  const evidenceTrial=cfg.n22S4RevocationTrial?
    (await import('./s4-trial.mjs')).openS4Trial({cfg,sales:adapters.sales?.mod,isSalesOwner}):null;
  const evidenceIndex=evidenceTrial?evidenceTrial.index??undefined:serverOnly.evidenceIndex;

  const stockDb=stockFile?new DatabaseSync(stockFile):null;
  if(adapters.sales){
    deployed.sales=adapters.sales.factory({product,catalog,c1:deployed.content,evidenceIndex,
      ...(evidenceTrial?.supplemental?{supplemental:evidenceTrial.supplemental}:{}),
      networkPolicy:g2?.handle?.networkPolicy??'disabled',g2Provider:g2?.handle,
      ...(stockDb?{stockReminders:{db:stockDb,isolatedStoreId:slice.storeId,
        isWritableTestStore:c=>c?.role==='owner'&&c.shopId===slice.storeId&&serverOnly.isCurrentOwner(c.sessionId)===true}}:{}),
      ...(write?{quote:{async run(pin){return {state:pin.price?'known':'unknown',price:pin.price,
        receipt:{mode:'fixture_catalog_direct',productId:pin.productId,productVersion:pin.productVersion,modelTurns:0,providerHttpAttempts:0}};}}}:{}),
      messageLedger:{bind:(c,x,p,acts)=>messages.setProduct(c,x.messageId,p,acts.includes('old_video')),
        pin:(c,x,w)=>messages.setWork(c,x.messageId,w),authorize:messages.authorize,read:messages.reference,
        restore:messages.restore,isDraftSourceCanceled:messages.isDraftSourceCanceled},
      canUse:isSalesOwner});
  }
  if(stockDb){
    if(!deployed.sales?.listTasks||!deployed.sales?.assertStockAccess)throw Error('S3_SALES_ADAPTER_REQUIRED');
    stockScope=stockModule.createStockScope({db:stockDb,messages,stock:deployed.sales,product});
  }
  const p1Turn=createP1ReadTurn({catalog,product,messages});
  const c1Solo=deployed.sales?null:createC1SoloTurn({catalog,product,c1:deployed.content,messages});
  const status=()=>({product:'mounted',...(evidenceTrial?{s4Evidence:evidenceTrial.index?'isolated_index':'authority_unmounted'}:{}),...(channelRead?{channelRead:'local_file_read_only'}:{}),album:deployed.album?'mounted':'not_mounted',
    sales:deployed.sales?'mounted':'not_mounted',content:deployed.content?'mounted':'not_mounted',
    stockReminders:stockScope?'mounted_in_isolated_stock_fixture':'not_mounted',
    ...(stockScope?{stockFixtureShop:slice.storeId}:{}),
    ...(planningGrant?{contentPlanningMode:'same_message_prepare_only'}:{}),
    ...(deployed.d3?{contentD3:'mounted_in_isolated_write_fixture'}:{}),
    model:g2?.status().model??'disabled',pixelRule:localVision.status,authenticated:true,
    ...(joined?{albumDrafts:'mounted_shared_group_fixture'}:{}),
    ...(p2Review?{p2CategoryReview:'owner_batch_only',originalLabelSource:deployed.album.originalLabelSourceStatus()}:{}),
    ...(refVision?{referenceVision:refVision.status}:{}),...(write?{catalogWrite:'isolated_fixture_only'}:{})});
  // Browser-only projection, after the raw scoped turn is durably saved.
  async function present(c,hit,recheck=true){
    if(!hit)return null;
    if(stockModule?.stockTaskReceipt(hit)){
      if(!stockScope)throw Object.assign(Error('STOCK_REMINDER_NOT_MOUNTED'),{code:'STOCK_REMINDER_NOT_MOUNTED',httpStatus:503});
      await deployed.sales.assertStockAccess(c);
    }
    let view=hit;
    if(p2Review&&hit.status==='human_review_recorded')return p2Review.presentReview(c,hit);
    if(recheck&&hit.actions?.some(a=>a.action==='classify')){
      const k=hit.actions.find(a=>a.action==='classify');
      if(p2Review){
        if(k.result?.storeId!==c.shopId||hit.shopId!==c.shopId||!p2Review.ownsBatch(c,k.batchId))
          throw Object.assign(Error('P2_ASSET_SCOPE_NOT_AVAILABLE'),{code:'P2_ASSET_SCOPE_NOT_AVAILABLE',httpStatus:404});
        const live=await product.classify(c,{requestId:hit.requestId,messageId:hit.messageId,batchId:k.batchId});
        if(live.status!=='classified_read_only')throw Object.assign(Error('P2_ASSET_SCOPE_NOT_AVAILABLE'),{code:'P2_ASSET_SCOPE_NOT_AVAILABLE',httpStatus:404});
        view={...hit,actions:hit.actions.map(a=>a===k?{...k,status:live.status,result:live}:a)};
      }else if(k.result?.items?.some(i=>i.originalLabelStatus||i.evidence?.originalLabel||i.evidence?.humanCorrection)){
        // A deployment without this authority cannot return a saved old label/human as current.
        throw Object.assign(Error('P2_EVIDENCE_VIEW_NOT_AVAILABLE'),{code:'P2_EVIDENCE_VIEW_NOT_AVAILABLE',httpStatus:503});
      }
    }
    if(planningGrant&&hit.status==='planning_grant_committed'){
      // Preserve the durable receipt; expose live permission separately so a history
      // refresh cannot offer the buttons for a revoked or superseded grant.
      const note=hit.actions?.find(a=>a.action==='planning_grant_committed')?.result;
      const grant=note&&planningGrant.readContentPlanningGrant(c,hit);
      const current=grant?.consentMessageId===hit.messageId&&['active','revoked','expired'].includes(grant.status)
        ?grant.status:'unavailable';
      view={...hit,planningGrantCurrent:current};
    }
    if(hit.actions?.some(a=>['reply_draft','knowledge','store_rule'].includes(a.action))){
      // Same read-only presenter on first receipt, restored receipt and cached execute.
      // When the authority is absent the presenter still runs; never serve the raw ledger.
      view=await deployed.sales?.presentMessage?.(c,{messageId:hit.messageId,requestId:hit.requestId,replay:hit.replay},
        {restoreScoped:messages.restore});
      if(!view||view.shopId!==c.shopId||view.messageId!==hit.messageId||view.requestId!==hit.requestId||
        (hit.replay===true&&view.replay!==true))
        throw Object.assign(Error('MESSAGE_VIEW_NOT_AVAILABLE'),{code:'MESSAGE_VIEW_NOT_AVAILABLE',httpStatus:503});
      view={...view,messageView:'s4-current'};
    }
    const source=view.draftSource;
    if(source?.kind==='owner_provided_quote'&&messages.isDraftSourceCanceled(c,source.originMessageId)){
      const {draftSource,...history}=view;
      return {...history,draftSourceRevoked:true};
    }
    return view;
  }
  async function route(p,m,ctx,read,json,req,res,origin){
    if(deployed.d3&&p.startsWith('/api/n22/content/d3/works/')&&await deployed.d3.route(req,res,ctx))return true;
    if(deployed.d3&&p==='/api/n22/content/d3/selection'){
      if(m!=='POST'){json(405,{error:{code:'METHOD_NOT_ALLOWED'}});return true;}
      try{json(200,deployed.d3.select(ctx,await read()));}
      catch(e){if(!e.httpStatus)throw e;json(e.httpStatus,{error:{code:e.code}});}
      return true;
    }
    if(deployed.content&&(p.startsWith('/api/content/')||p.startsWith('/api/n22/content/'))&&await deployed.content.route(req,res,ctx))return true;
    if(!p.startsWith('/api/n22/'))return false;
    if(p==='/api/n22/capabilities'&&m==='GET'){json(200,status());return true;}
    if(p==='/api/n22/product/channel-offers'){
      const plain={'Cache-Control':'no-store'};
      if(!product.readChannelOffers){json(404,{error:{code:'CHANNEL_READ_NOT_MOUNTED'}},plain);return true;}
      if(m!=='POST'){json(405,{error:{code:'METHOD_NOT_ALLOWED'}},plain);return true;}
      // No message persistence/cached replay: a duplicate lookup sees current affairs, including revoke.
      try{const a=product.readChannelOffers(ctx,await read());json(200,a,{...plain,'X-N22-Request-Id':a.requestId});}
      catch(e){if(!e.httpStatus)throw e;json(e.httpStatus,{error:{code:e.code??'INVALID_REQUEST'}},plain);}
      return true;
    }
    const stockPath=/^\/api\/n22\/sales\/tasks(?:\/(confirm|cancel))?$/u.exec(p);
    if(stockPath){
      if(!stockScope){json(404,{error:{code:'STOCK_REMINDER_NOT_MOUNTED'}});return true;}
      const kind=stockPath[1];
      if(m!==(kind?'POST':'GET')){json(405,{error:{code:'METHOD_NOT_ALLOWED'}});return true;}
      try{
        const v=kind?await turn(ctx,stockModule.controlInput(kind,await read())):
          {shopId:ctx.shopId,tasks:await stockScope.list(ctx)};
        json(200,v,v.requestId?{'X-N22-Request-Id':v.requestId}:undefined);
      }catch(e){if(!e.httpStatus)throw e;json(e.httpStatus,{error:{code:e.code??'INVALID_REQUEST'}});}
      return true;
    }
    const saved=/^\/api\/n22\/messages\/([\w.:-]{1,128})$/u.exec(p);
    if(saved&&m==='GET'){
      const liveHeaders={'Cache-Control':'no-store'};
      try{const hit=await present(ctx,(deployed.d3?await deployed.d3.restore(ctx,saved[1]):messages.restore(ctx,saved[1]))??
          (joined?deployed.album.restoreDraft(ctx,saved[1]):null));
        json(hit?200:404,hit??{error:{code:'MESSAGE_NOT_FOUND'}},liveHeaders);}
      catch(e){if(!e.httpStatus)throw e;json(e.httpStatus,{error:{code:e.code}},liveHeaders);}
      return true;
    }
    if(p.startsWith('/api/n22/album/')&&deployed.album?.route){
      if(joined&&p==='/api/n22/album/drafts/handoff'){
        json(403,{error:{code:'D2_CONFIRM_IN_ORDINARY_TURN'}});return true;
      }
      if((joined||cardFlow||p2Review)&&m==='GET'&&p.startsWith('/api/n22/album/batches/')){
        const batch=p.split('/')[5];
        if(!(p2Review??write).ownsBatch(ctx,batch)){json(404,{error:{code:'BATCH_NOT_IN_SESSION'}});return true;}
      }
      if((write||p2Review)&&m==='POST'&&p==='/api/n22/album/batches'){
        // Capture only the server-generated album receipt, after the normal album validation.
        const head=res.writeHead,end=res.end;let success=null;
        res.writeHead=function(status,...rest){if(status===200){success=rest;return this;}return head.call(this,status,...rest);};
        res.end=function(data,...rest){
          if(success){
            try{(p2Review??write).noteBatch(ctx,JSON.parse(String(data)));head.call(this,200,...success);}
            catch(e){head.call(this,e.httpStatus??500,{'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'});
              data=JSON.stringify({error:{code:e.code??'BATCH_SCOPE_FAILED'}});}
          }
          return end.call(this,data,...rest);
        };
        try{return await deployed.album.route({req,res,pathname:p,ctx,origin});}
        finally{res.writeHead=head;res.end=end;}
      }
      return deployed.album.route({req,res,pathname:p,ctx,origin});
    }
    async function turn(c,x){
      const isDraft=typeof x?.text==='string'&&deployed.sales&&adapters.sales.mod.parseS4Text?.(x.text);
      if(serverOnly.originalTrialReadOnly&&!isDraft&&typeof x?.text==='string'&&
        /^(?:确认|取消)(?:\s+[a-f0-9-]{36})?[。！!]*$|^(?:把|用).{0,450}(?:建档|补到卡号|的(?:售价|零售价|尺寸)\s*(?:改为|改成|设为))/u.test(x.text.normalize('NFKC').trim()))
        throw Object.assign(Error('ORIGINAL_STORE_READ_ONLY'),{code:'ORIGINAL_STORE_READ_ONLY',httpStatus:403});
      const listed=stockScope&&!isDraft&&stockModule.stockListIntent(x?.text);
      const stock=stockScope&&!isDraft&&!listed&&adapters.sales.mod.stockReminderIntent(x?.text);
      if(listed||stock){
        if(x.batchId!==undefined)throw Object.assign(Error('BATCH_ACTION_UNSUPPORTED'),{code:'BATCH_ACTION_UNSUPPORTED',httpStatus:400});
        await deployed.sales.assertStockAccess(c);
        if(['confirm','cancel'].includes(stock))await stockScope.checkControl(c,x);
      }
      let editLease;
      const raw=await messages.execute(c,x,async()=>{
        editLease=deployed.d3?.beginOrdinaryTurn(c,x);
        // Literal customer words are data, not album, pricing, or write commands.
        if(isDraft){
          if(x.batchId!==undefined)throw Object.assign(Error('DRAFT_TEXT_ONLY'),{code:'DRAFT_TEXT_ONLY',httpStatus:400});
          return deployed.sales.executeTurn(c,{requestId:x.requestId,messageId:x.messageId,text:x.text,replyToMessageId:x.replyToMessageId});
        }
        if(listed)return stockScope.listTurn(c,x);
        if(stock)return stockScope.prepared(c,await deployed.sales.executeTurn(c,
          {requestId:x.requestId,messageId:x.messageId,text:x.text,replyToMessageId:x.replyToMessageId}));
        if(planningGrant){const answer=planningGrant.turn(c,x);if(answer)return answer;}
        if(cardFlow&&['把本条两张练习图建档','确认这项商品变更','取消这项商品变更'].includes(x.text.trim().replace(/[。！？!]+$/u,''))){
          const result=await write.execute(c,x), r=result?.receipt;
          if(!result)throw Error('PLANGRANT_PRODUCT_ROUTING_REQUIRED');
          if(r)messages.setProduct(c,x.messageId,r,false);
          return {shopId:c.shopId,requestId:x.requestId,messageId:x.messageId,status:'catalog_write_'+result.status,
            ...(r?{productId:r.productId,productVersion:r.productVersion}:{}),actions:[{action:'catalog_write',result}]};
        }
        if(deployed.d3){const answer=await deployed.d3.turn(c,x,editLease);if(answer)return answer;}
        if(joined){const answer=await deployed.album.draftTurn(c,x);if(answer)return answer;}
        if((!serverOnly.practiceOnly||p2Review)&&/(?:按|依照|依)\s*(?:品类|类别|种类).{0,8}(?:分|整)|品类分类|类别分类/u.test(x.text)&&!/(?:不要|别|不用)\s*(?:按品类分|分类)/u.test(x.text)){
          const info={shopId:c.shopId,requestId:x.requestId,messageId:x.messageId};
          if(!x.batchId)return {...info,status:'needs_photos',actions:[]};
          if(p2Review&&!p2Review.isBatchReference(c,x.batchId,x.replyToMessageId??x.messageId))
            throw Object.assign(Error('BATCH_NOT_IN_SESSION'),{code:'BATCH_NOT_IN_SESSION',httpStatus:404});
          // Association from the real album batch is verified before handing off to P2.
          const category=await product.classify(c,{requestId:x.requestId,messageId:x.messageId,batchId:x.batchId});
          return {...info,status:category.status==='classified_read_only'?'completed':'failed',
            actions:[{...info,action:'classify',batchId:x.batchId,status:category.status,result:category}]};
        }
        if(write){
          const result=await write.execute(c,x);
          if(result){
            const r=result.receipt;
            if(r)messages.setProduct(c,x.messageId,r,false);
            return {shopId:c.shopId,requestId:x.requestId,messageId:x.messageId,status:'catalog_write_'+result.status,
              ...(r?{productId:r.productId,productVersion:r.productVersion}:{}),
              actions:[{action:'catalog_write',result}]};
          }
        }
        // Pure P1 is a peer of sales, not a fallback that requires it to be mounted.
        const facts=await p1Turn(c,x);if(facts)return facts;
        if(serverOnly.practiceOnly)return {shopId:c.shopId,requestId:x.requestId,messageId:x.messageId,
          status:'unsupported',code:'PRACTICE_ACTION_NOT_ALLOWED',actions:[],
          message:'隔离练习只接受整理本次照片、准备或确认商品变更，以及本店练习卡读回。'};
        if(x.batchId!==undefined)throw Object.assign(Error('BATCH_ACTION_UNSUPPORTED'),{code:'BATCH_ACTION_UNSUPPORTED',httpStatus:400});
        if(c1Solo)return c1Solo(c,x);
        return deployed.sales.executeTurn(c,{requestId:x.requestId,messageId:x.messageId,text:x.text,replyToMessageId:x.replyToMessageId});
      });
      if(editLease&&!raw.replay)deployed.d3.completeOrdinaryTurn(c,editLease,raw);
      return present(c,cardFlow&&raw.replay===true?deployed.d3.checkCurrentView(c,raw):raw,raw.replay===true);
    }
    const invoke=p==='/api/n22/product/category-review'&&p2Review?p2Review.correct:
      p==='/api/n22/product/resolve'?product.resolve:
      p==='/api/n22/product/classify'?product.classify:p==='/api/n22/turn'?turn:null;
    if(!invoke){
      json(404,{error:{code:'NOT_FOUND'}});return true;
    }
    if(m!=='POST'){json(405,{error:{code:'METHOD_NOT_ALLOWED'}});return true;}
    const headers=p==='/api/n22/turn'?{'Cache-Control':'no-store'}:{};
    try{const answer=await invoke(ctx,await read());json(200,answer,
      {...headers,...(answer?.requestId?{'X-N22-Request-Id':answer.requestId}:{})});}
    catch(e){const st=e.httpStatus??e.status;if(st)json(st,{error:{code:e.code??'INVALID_REQUEST'}},headers);else throw e;}
    return true;
  }
  return {status,route,contentReadiness:()=>contentHealth,g2Operator:g2?.operate,quiesce:g2?.quiesce,
    close:()=>{g2?.close();evidenceTrial?.close();stockDb?.close();deployed.d3?.close();refVision?.close();messages.close();albumDb?.close();db.close();}};
}
