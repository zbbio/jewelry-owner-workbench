import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,join,resolve} from 'node:path';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';

const sha=b=>createHash('sha256').update(b).digest('hex');
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const opaque='[A-Za-z0-9_-]{1,128}';
const refs=new RegExp('^(?:'+uuid+')(?:[\\s、,，]+(?:'+uuid+')){0,11}$','u');
const error=(code,httpStatus)=>Object.assign(Error(code),{code,httpStatus});
const json=JSON.stringify;
const sort=x=>[...x].sort();
const command=/^(?:把|用)?\s*(?:批次|本批|组|卡号|这件)|^(?:确认|取消)(?:\s+|$)|\s*(?:建档|补图)$/u;
export function assertP34Fixture(cfg){
  const root=dirname(resolve(cfg.stateDir));
  const base=resolve(cfg.n22Root,'商品仓','仅本机只读');
  const d3=cfg.n22D3Fixture===true;
  const d2=cfg.n22D2Fixture===true;
  const plan=cfg.n22CardPage!=null||cfg.n22PlanGrant!=null;
  const planPort=Number(String(cfg.origin).split(':').at(-1));
  const d2Port=Number(String(cfg.origin).split(':').at(-1));
  const target=plan?'http://127.0.0.1:'+planPort:d2&&Number.isSafeInteger(d2Port)&&d2Port>=30000&&d2Port<=65535?`http://127.0.0.1:${d2Port}`:d3?'http://127.0.0.1:17873':'http://127.0.0.1:17871';
  if(cfg.n22WriteFixture!==true||cfg.origin!==target||cfg.allowAndroidHost!==false||
     cfg.modelPolicy!=='disabled'||cfg.modelSecretFile||cfg.contentArchive||cfg.n22Adapters?.content||
     !/^n22-write-[a-f0-9]{14}$/u.test(cfg.storeRef)||dirname(root)!==base||!basename(root).startsWith(d2?'test-write-d2-':d3?'test-write-d3-':'test-write-')||
     (d2&&(d2Port<30000||d2Port>65535||!Number.isSafeInteger(d2Port)||d3||cfg.n22G2Fixture||cfg.n22G2PrivateCandidate||
       cfg.socketPath||cfg.privateTlsOrigin||cfg.n22Adapters?.album?.file!==join(cfg.n22Root,'相册仓','backend','group-http.mjs')||
       cfg.n22Adapters?.album?.export!=='createN22AlbumWithDrafts'))||
     (plan&&(!d3||d2||!Number.isSafeInteger(planPort)||planPort<30000||planPort>65535||
       !basename(root).startsWith('test-write-d3-card2plan-')||cfg.privateTlsOrigin||cfg.n22StockFixture||
       cfg.n22G2Fixture||cfg.n22G2PrivateCandidate||cfg.n22AppLocalPractice||
       cfg.n22Adapters?.sales||cfg.n22Adapters?.album?.export!=='createAlbumRoute'||
       cfg.n22Adapters?.album?.file!==join(cfg.n22Root,'相册仓','backend','http.mjs')||
       cfg.n22CardPage?.relative!=='内容仓/D3/CARD2PLAN/card2plan.mjs'||
       cfg.n22PlanGrant?.relative!=='内容仓/D3/PLANGRANT/plangrant.mjs'||
       cfg.n22D3Adapters?.caption?.relative!=='内容仓/D3/C2TEXT/edit-caption.mjs'))||
     (d3&&(cfg.n22D3Policy!==join(root,'fixture','d3-policy.json')||cfg.socketPath||cfg.tlsProbe||
       cfg.n22D3Adapters?.content?.relative!=='内容仓/D3/d3-content.mjs'||cfg.n22D3Adapters?.router?.relative!=='销售仓/d3-turn.mjs'||
       cfg.n22D3Adapters?.consent?.relative!=='销售仓/d3-consent.mjs'))||
     realpathSync(root)!==root||lstatSync(root).isSymbolicLink()||basename(cfg.stateDir)!=='state'||
     cfg.n22CatalogSlice!==join(root,'fixture','catalog.json'))throw error('WRITE_FIXTURE_REQUIRED',500);
  const approved=['fixture/catalog.json','fixture/cards.json','fixture/materials.json','fixture/WRITE-ENABLED.json'];
  if(d3)approved.push('fixture/d3-policy.json');
  for(const k of approved){
    const f=join(root,k);if(!existsSync(f)||!lstatSync(f).isFile()||lstatSync(f).isSymbolicLink()||realpathSync(f)!==f)
      throw error('WRITE_FIXTURE_INPUT_INVALID',500);
  }
  if(cfg.snapshotFile!==join(root,'fixture','cards.json')||cfg.materialDir!==join(root,'fixture')||
     (existsSync(cfg.stateDir)&&(!lstatSync(cfg.stateDir).isDirectory()||realpathSync(cfg.stateDir)!==cfg.stateDir)))
    throw error('WRITE_FIXTURE_PATH_INVALID',500);
  for(const name of ['n15-auth.sqlite','n22-write-catalog.sqlite','n22-album.sqlite','n22-messages.sqlite']){
    for(const suffix of ['','-wal','-shm','-journal']){
      const f=join(cfg.stateDir,name+suffix);
      if(existsSync(f)&&(!lstatSync(f).isFile()||realpathSync(f)!==f||lstatSync(f).nlink!==1))
        throw error('WRITE_FIXTURE_DB_ALIAS',500);
    }
  }
  const marker=JSON.parse(readFileSync(join(root,'fixture','WRITE-ENABLED.json'),'utf8'));
  if(marker.kind!=='N22_SYNTHETIC_WRITE_ONLY' || marker.storeId!==cfg.storeRef)throw error('WRITE_FIXTURE_SCOPE_INVALID',500);
  return root;
}

export function createP34Write({db,catalog,album,storeId,readReference,readMessage,draftJoin=false,planPairMode=false,isCurrentOwner}){
  db.exec(`CREATE TABLE IF NOT EXISTS n22_write_batches(
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, session TEXT NOT NULL, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS n22_write_groups(
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, session TEXT NOT NULL, batch TEXT NOT NULL, fp TEXT NOT NULL, assets TEXT NOT NULL,
    UNIQUE(actor,session,batch,fp));
    CREATE TABLE IF NOT EXISTS n22_write_intents(
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, session TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL,
    spec TEXT NOT NULL, receipt TEXT, created_at INTEGER NOT NULL, UNIQUE(actor,session,message));`);
  const prep=s=>db.prepare(s);
  const oneBatch=prep('SELECT * FROM n22_write_batches WHERE id=? AND actor=? AND session=?');
  const byBatchMessage=prep('SELECT id FROM n22_write_batches WHERE actor=? AND session=? AND message=?');
  const insertBatch=prep('INSERT OR IGNORE INTO n22_write_batches VALUES (?,?,?,?)');
  const oneGroup=prep('SELECT * FROM n22_write_groups WHERE id=? AND actor=? AND session=?');
  const groupFingerprint=prep('SELECT * FROM n22_write_groups WHERE actor=? AND session=? AND batch=? AND fp=?');
  const insertGroup=prep('INSERT INTO n22_write_groups VALUES (?,?,?,?,?,?)');
  const oneIntent=prep('SELECT * FROM n22_write_intents WHERE id=? AND actor=? AND session=?');
  const messageIntent=prep('SELECT * FROM n22_write_intents WHERE actor=? AND session=? AND message=?');
  const insertIntent=prep('INSERT INTO n22_write_intents VALUES (?,?,?,?,?,?,NULL,?)');
  const status=prep('UPDATE n22_write_intents SET status=?,receipt=? WHERE id=?');
  const approve=prep("UPDATE n22_write_intents SET status='committing',spec=? WHERE id=?");
  const mappedGroup=prep('SELECT product_id FROM catalog_groups WHERE shop_id=? AND group_id=?');
  const committedLinks=prep("SELECT body_json FROM catalog_receipts WHERE shop_id=? AND operation='acceptGroup' AND json_extract(receipt_json,'$.productId')=?");
  const owner=c=>{
    if(c?.shopId!==storeId||c.role!=='owner'||!c.actorId||!c.sessionId)throw error('FIXTURE_OWNER_REQUIRED',403);
    if((draftJoin||planPairMode)&&isCurrentOwner?.(c.sessionId)!==true)throw error('OWNER_SESSION_NO_LONGER_ACTIVE',401);
  };
  const bind=c=>[c.actorId,c.sessionId];
  let granted=null;
  const delivery=new AsyncLocalStorage(),running=new Map();
  function noteBatch(ctx,ack){
    owner(ctx);
    if(typeof ack?.batchId!=='string'||ack.mode!=='organize_only'||typeof ack.messageId!=='string')throw error('BATCH_SCOPE_NOT_VERIFIED',409);
    insertBatch.run(ack.batchId,...bind(ctx),ack.messageId);
    if(oneBatch.get(ack.batchId,...bind(ctx))?.message!==ack.messageId)throw error('BATCH_NOT_IN_SESSION',404);
  }
  function ownsBatch(c,id,msg){
    owner(c);const row=typeof id==='string'?oneBatch.get(id,...bind(c)):null;
    return !!row&&(msg===undefined||msg===row.message);
  }
  function scopedCatalogCard(c,p){
    owner(c);if(!p)return null;
    const linked=new Set();
    for(const row of committedLinks.all(storeId,p.productId)){
      const g=JSON.parse(row.body_json);
      if(ownsBatch(c,g.taskId))for(const a of g.keptAssetIds)linked.add(a);
    }
    return p.assetIds.every(id=>linked.has(id))?p:null;
  }
  const catalogRead=Object.freeze({list:c=>catalog.list(c).filter(p=>scopedCatalogCard(c,p)),
    get:(c,id)=>scopedCatalogCard(c,catalog.get(c,id))});
  function makeGroup(ctx,batchId,ids){
    if(!oneBatch.get(batchId,...bind(ctx)))throw error('BATCH_NOT_IN_SESSION',404);
    const batch=album.readAuthorizedBatch(ctx,batchId);
    if(batch?.shopId!==storeId||batch.batchId!==batchId)throw error('BATCH_NOT_IN_SESSION',404);
    const all=new Map(batch.assets.filter(x=>x.status==='kept'&&typeof x.assetId==='string').map(x=>[x.assetId,x]));
    if(new Set(ids).size!==ids.length||ids.some(x=>!all.has(x)))throw error('ASSET_NOT_IN_BATCH',404);
    const assets=sort(ids).map(assetId=>({assetId,sha256:all.get(assetId).sha256}));
    if(assets.some(a=>!/^[a-f0-9]{64}$/u.test(a.sha256??'')))throw error('ASSET_NOT_VERIFIED',409);
    const fp=sha(json(assets));let row=groupFingerprint.get(...bind(ctx),batchId,fp);
    if(!row){const id=randomUUID();insertGroup.run(id,...bind(ctx),batchId,fp,json(assets));row=oneGroup.get(id,...bind(ctx));}
    return groupView(row);
  }
  function groupView(r){return {groupId:r.id,groupVersion:1,batchId:r.batch,assets:JSON.parse(r.assets)};}
  function resolveGroup(ctx,id,v){
    const r=oneGroup.get(id,...bind(ctx));
    if(!r)throw error('GROUP_NOT_IN_SESSION',404);
    if(Number(v)!==1)throw error('GROUP_VERSION_CONFLICT',409);
    return groupView(r);
  }
  function assetCheck(ctx,g){
    const cur=resolveGroup(ctx,g.groupId,g.groupVersion);
    if(json(cur)!==json(g)||!oneBatch.get(g.batchId,...bind(ctx)))throw error('GROUP_VERSION_CONFLICT',409);
    for(const a of g.assets){
      const original=album.readAuthorizedAsset(ctx,g.batchId,a.assetId);
      if(!original?.bytes||sha(original.bytes)!==a.sha256)throw error('ASSET_CHANGED',409);
    }
  }
  const get=(ctx,id)=>{
    const p=catalog.get(ctx,id);if(!p)throw error('PRODUCT_NOT_FOUND',404);
    return p;
  };
  function prepare(ctx,x,spec){
    const existing=messageIntent.get(...bind(ctx),x.messageId);
    if(existing)return readEntry(existing);
    const id=randomUUID();
    insertIntent.run(id,...bind(ctx),x.messageId,'prepared',json(spec),Date.now());
    return readEntry(oneIntent.get(id,...bind(ctx)));
  }
  function readEntry(r){
    const spec=JSON.parse(r.spec),out=r.receipt?JSON.parse(r.receipt):{};
    return {status:r.status,intentId:r.id,preparedMessageId:r.message,fixtureOnly:true,operation:spec.operation,
      preview:spec.preview,...out};
  }
  function verifyDraft(c,p){
    const v=album.draft.checkMessageGroup(c,{replyToMessageId:p.replyToMessageId,groupId:p.groupId,
      ordinal:p.ordinal,draftGroupVersion:p.draftGroupVersion});
    if(v.shopId!==storeId||!ownsBatch(c,v.batchId)||json(v)!==json(p))throw error('STALE_OR_UNPINNED_GROUP',409);
    return v;
  }
  function a4Inputs(s,id){
    const g=s.a34,requestId='confirm-'+id;
    const command={requestId,messageId:s.confirmMessageId,replyToMessageId:g.replyToMessageId,groupId:g.groupId,
      draftGroupVersion:g.draftGroupVersion,intent:s.operation==='attach'?'supplement':'create',
      ...(s.operation==='attach'?{targetProductId:s.productId,expectedVersion:s.expectedVersion}:{})};
    const wire={requestId,taskId:g.batchId,groupId:g.groupId,groupVersion:1,keptAssetIds:g.keptAssetIds,
      decisionSource:g.decisionSource,evidenceRef:g.evidenceRef,
      ...(s.operation==='attach'?{targetProductId:s.productId,expectedVersion:s.expectedVersion}:{})};
    return {command,wire};
  }
  function liveDelivery(c){
    owner(c);const z=delivery.getStore();
    if(!draftJoin||!z||z.who!==json(bind(c)))throw error('OWNER_CONFIRMATION_REQUIRED',403);
    const row=oneIntent.get(z.id,...bind(c)),s=row&&JSON.parse(row.spec);
    if(row?.status!=='committing'||!s?.a34||!s.confirmMessageId)throw error('OWNER_CONFIRMATION_REQUIRED',403);
    return {s,...a4Inputs(s,z.id)};
  }
  function authorizeDelivery(c,p){
    const {s,command}=liveDelivery(c),g=verifyDraft(c,s.a34);
    if(!['shopId','batchId','draftVersion','groupId','draftGroupVersion','replyToMessageId','decisionSource','evidenceRef']
      .every(k=>p[k]===g[k])||json(p.keptAssetIds)!==json(g.keptAssetIds)||
      !['intent','targetProductId','expectedVersion','requestId','messageId'].every(k=>p[k]===command[k]))
      throw error('OWNER_CONFIRMATION_SCOPE_CONFLICT',409);
    return {approved:true,approvalRef:command.requestId};
  }
  function acceptDraftHandoff(c,incoming){
    const {s,wire}=liveDelivery(c),g=verifyDraft(c,s.a34);
    const same=Object.keys(wire).length===Object.keys(incoming??{}).length&&Object.keys(wire).every(k=>json(wire[k])===json(incoming[k]));
    if(!same)throw error('OWNER_CONFIRMATION_SCOPE_CONFLICT',409);
    granted={owner:json(bind(c)),ids:new Set(g.keptAssetIds)};
    try{return catalog.acceptGroup(c,incoming);}finally{granted=null;}
  }
  function joinedCommit(c,x,row,s){
    if(running.has(row.id))return running.get(row.id);
    const putConflict=code=>{
      status.run('conflict',json({code,currentVersion:s.productId?catalog.get(c,s.productId)?.productVersion??null:null}),row.id);
      return readEntry(oneIntent.get(row.id,...bind(c)));
    };
    try{verifyDraft(c,s.a34);}catch(e){if(e.httpStatus===409)return putConflict(e.code);throw e;}
    if(!s.confirmMessageId){s={...s,confirmMessageId:x.messageId};approve.run(json(s),row.id);}
    const done=delivery.run({id:row.id,who:json(bind(c))},async()=>{
      try{
        const r=await album.draft.handoff(c,a4Inputs(s,row.id).command);
        if(r.status==='rejected')return putConflict(r.code);
        if(['committed','already_committed'].includes(r.status)&&r.catalogReceipt){
          status.run('committed',json({receipt:r.catalogReceipt}),row.id);
        }else if(r.status!=='awaiting_catalog_receipt')throw error('D2_HANDOFF_NOT_VERIFIED',503);
        return readEntry(oneIntent.get(row.id,...bind(c)));
      }catch(e){if(e.httpStatus===409)return putConflict(e.code);throw e;}
    });
    running.set(row.id,done);
    const clear=()=>{if(running.get(row.id)===done)running.delete(row.id);};done.then(clear,clear);
    return done;
  }
  function change(ctx,x,id,mode){
    let row=oneIntent.get(id,...bind(ctx));
    if(!row||(x.replyToMessageId&&x.replyToMessageId!==row.message))throw error('INTENT_NOT_IN_SESSION',404);
    if(['committed','cancelled','conflict','expired'].includes(row.status)){
      if(row.status==='committed'){
        const frozen=JSON.parse(row.spec);
        if(frozen.group)assetCheck(ctx,frozen.group);
      }
      return readEntry(row);
    }
    if(mode==='取消'){
      if(row.status!=='prepared')throw error('CONFIRMATION_ALREADY_STARTED',409);
      status.run('cancelled',null,id);return readEntry(oneIntent.get(id,...bind(ctx)));
    }
    if(row.status==='prepared'&&Date.now()-row.created_at>30*60*1000){
      status.run('expired',null,id);return readEntry(oneIntent.get(id,...bind(ctx)));
    }
    const spec=JSON.parse(row.spec),rid='confirm-'+id;
    if(draftJoin&&spec.a34)return joinedCommit(ctx,x,row,spec);
    status.run('committing',null,id);
    try{
      let receipt;
      if(spec.operation==='update'){
        receipt=catalog.update(ctx,{requestId:rid,productId:spec.productId,expectedVersion:spec.expectedVersion,changes:[spec.change]});
      }else{
        const g=spec.group;
        assetCheck(ctx,g);granted={owner:json(bind(ctx)),ids:new Set(g.assets.map(a=>a.assetId))};
        try{receipt=catalog.acceptGroup(ctx,{requestId:rid,taskId:g.batchId,groupId:g.groupId,groupVersion:g.groupVersion,
          keptAssetIds:g.assets.map(a=>a.assetId),decisionSource:'owner_confirmed',evidenceRef:'n22-group:'+g.groupId,
          ...(spec.operation==='attach'?{targetProductId:spec.productId,expectedVersion:spec.expectedVersion}:{})});}
        finally{granted=null;}
      }
      status.run('committed',json({receipt}),id);
    }catch(e){
      if((e.httpStatus??e.status)!==409)throw e;
      status.run('conflict',json({code:e.code,
        currentVersion:spec.productId?catalog.get(ctx,spec.productId)?.productVersion??null:null}),id);
    }
    row=oneIntent.get(id,...bind(ctx));return readEntry(row);
  }
  function execute(c,x){
    const text=x.text.normalize('NFKC').trim().replace(/[。！？!]+$/u,'');
    const sel=(pat)=>new RegExp(pat,'u').exec(text);
    let m=sel('^(确认|取消)\\s+('+uuid+')$');
    if(m){owner(c);if(draftJoin&&!x.replyToMessageId)throw error('WRITE_COMMAND_NEEDS_EXPLICIT_REFERENCE',400);return change(c,x,m[2],m[1]);}
    if(planPairMode&&['确认这项商品变更','取消这项商品变更'].includes(text)){
      owner(c);
      const row=x.replyToMessageId&&messageIntent.get(...bind(c),x.replyToMessageId);
      if(!row)throw error('INTENT_NOT_IN_SESSION',404);
      return change(c,x,row.id,text.startsWith('确认')?'确认':'取消');
    }
    if(planPairMode&&text==='把本条两张练习图建档'){
      owner(c);
      const m=x.replyToMessageId, matched=m&&byBatchMessage.all(...bind(c),m), b=matched?.[0]?.id;
      const source=m&&readMessage?.(c,m), a=source?.actions?.find(z=>z.action==='classify');
      if(matched?.length!==1||source?.shopId!==storeId||a?.result?.batchId!==b||
         a.result.messageId!==m||a.result.status!=='classified_read_only')throw error('PLAN_INTAKE_SOURCE_NOT_IN_SESSION',404);
      const batch=album.readAuthorizedBatch(c,b);
      const ids=batch?.assets?.filter(z=>z.status==='kept').map(z=>z.assetId);
      if(batch?.messageId!==m||ids?.length!==2)throw error('PLAN_INTAKE_EXACT_TWO_IMAGES',409);
      const g=makeGroup(c,b,ids);assetCheck(c,g);
      const prior=mappedGroup.get(storeId,g.groupId), current=prior?get(c,prior.product_id):null;
      return prepare(c,x,{operation:'create',group:g,preview:{productId:current?.productId??null,
        expectedVersion:current?.productVersion??null,groupId:g.groupId,groupVersion:g.groupVersion,batchId:b,photoIntakeMessageId:m,
        assetIds:g.assets.map(z=>z.assetId),willAttach:g.assets.map(z=>z.assetId).filter(z=>!current?.assetIds.includes(z))}});
    }
    if(draftJoin){
      const basic=sel('^(确认|取消)$');
      if(basic){
        owner(c);const row=x.replyToMessageId&&messageIntent.get(...bind(c),x.replyToMessageId);
        if(!row)throw error('INTENT_NOT_IN_SESSION',404);
        return change(c,x,row.id,basic[1]);
      }
      const pick=sel('^(?:把|用)?\\s*第\\s*([1-9]|1[0-2])\\s*组\\s*(?:建档|补到卡号\\s+('+uuid+')\\s+v([1-9][0-9]{0,7}))$');
      if(pick){
        owner(c);if(!x.replyToMessageId)throw error('D2_DISPLAYED_GROUP_REQUIRED',400);
        const g=album.draft.checkMessageGroup(c,{replyToMessageId:x.replyToMessageId,ordinal:Number(pick[1])});
        if(g.shopId!==storeId||!ownsBatch(c,g.batchId))throw error('BATCH_NOT_IN_SESSION',404);
        const p=pick[2]?get(c,pick[2]):null;
        if(p&&p.productVersion!==Number(pick[3]))throw error('VERSION_CONFLICT',409);
        const old=mappedGroup.get(storeId,g.groupId);
        const shown=p??(old?get(c,old.product_id):null);
        return prepare(c,x,{operation:p?'attach':'create',a34:g,...(p?{productId:p.productId,expectedVersion:p.productVersion}:{}),
          preview:{sourceMessageId:g.replyToMessageId,draftVersion:g.draftVersion,groupId:g.groupId,groupVersion:1,
            draftGroupVersion:g.draftGroupVersion,batchId:g.batchId,assetIds:g.keptAssetIds,decisionSource:g.decisionSource,
            productId:shown?.productId??null,expectedVersion:shown?.productVersion??null,
            willAttach:g.keptAssetIds.filter(a=>!shown?.assetIds.includes(a))}});
      }
    }
    if(!command.test(text))return null;
    m=sel('^(?:把|用)?\\s*(?:卡号\\s+('+uuid+')|这件)\\s*的\\s*(售价|零售价|尺寸)\\s*(?:改为|改成|设为)\\s*([0-9]{1,9}(?:\\.[0-9]{1,2})?)\\s*(元|CNY|cm|mm|厘米|毫米)$');
    if(m){
      owner(c);const pin=m[1]?null:readReference(c,x.replyToMessageId);
      if(!m[1]&&!pin)throw error('PRODUCT_REFERENCE_REQUIRED',400);
      const p=get(c,m[1]??pin.productId);
      if(pin&&p.productVersion!==pin.productVersion)throw error('VERSION_CONFLICT',409);
      const price=m[2]!=='尺寸',unit={CNY:'元',厘米:'cm',毫米:'mm'}[m[4]]??m[4];
      if(price&&unit!=='元'||!price&&(unit==='元'||Number(m[3])<=0))throw error('INVALID_FIELD_UNIT',400);
      const field=price?'price':'size',value=price?Number(m[3]).toFixed(2):String(Number(m[3]));
      const change={field,value,unit,source:'manual'};
      return prepare(c,x,{operation:'update',productId:p.productId,expectedVersion:p.productVersion,change,
        preview:{productId:p.productId,expectedVersion:p.productVersion,difference:{field,
          before:p.fields[field]?{value:p.fields[field].value,unit:p.fields[field].unit}:null,after:{value,unit}}}});
    }
    const end='\\s*(建档|补到卡号\\s+('+uuid+'))$';
    if(draftJoin){
      if(/建档|补到卡号|补图/u.test(text))throw error('D2_DISPLAYED_GROUP_REQUIRED',400);
      return null;
    }
    let g=null,dest=null;
    m=sel('^(?:把|用)?\\s*组\\s+('+uuid+')\\s+v([1-9][0-9]{0,7})'+end);
    if(m){owner(c);g=resolveGroup(c,m[1],m[2]);dest=m[4];}
    else{
      m=sel('^(?:把|用)?\\s*(?:批次\\s+('+opaque+')\\s*的|本批的)\\s*素材\\s+(.+?)'+end);
      if(m){
        owner(c);const batch=m[1]??x.batchId;
        if(!batch||!refs.test(m[2]))throw error('EXPLICIT_BATCH_MATERIAL_REQUIRED',400);
        g=makeGroup(c,batch,m[2].split(/[\s、,，]+/u));dest=m[4];
      }
    }
    if(g){
      assetCheck(c,g);
      const p=dest?get(c,dest):null,old=mappedGroup.get(storeId,g.groupId);
      const current=p??(old?get(c,old.product_id):null);
      const toAttach=g.assets.map(a=>a.assetId).filter(a=>!current?.assetIds.includes(a));
      return prepare(c,x,{operation:p?'attach':'create',group:g,...(p?{productId:p.productId,expectedVersion:p.productVersion}:{}),
        preview:{productId:current?.productId??null,expectedVersion:current?.productVersion??null,
          groupId:g.groupId,groupVersion:g.groupVersion,batchId:g.batchId,assetIds:g.assets.map(a=>a.assetId),willAttach:toAttach}});
    }
    if(/^(?:确认|取消)(?:\s|$)|建档|补到卡号|(?:售价|零售价|尺寸).{0,4}(?:改成|改为|设为)/u.test(text))
      throw error('WRITE_COMMAND_NEEDS_EXPLICIT_REFERENCE',400);
    return null;
  }
  return {noteBatch,ownsBatch,catalogRead,authorizeDelivery,acceptDraftHandoff,execute,isApprovedAsset:(ctx,id)=>ctx.shopId===storeId&&
    granted?.owner===json(bind(ctx))&&granted.ids.has(id)};
}
