import {createHash} from 'node:crypto';
import {readPlanIntent} from '../APPPLAN/app-plan.mjs';
import {MAX_ASSET_BYTES,MIME_EXT,byteHash,prepareTwoPlans,editPlan,cancelPlans} from '../content/c2-plan-prep.mjs';
import {createPlanVersionStore} from '../C2/plan-version-store.mjs';
import {createD3CaptionEditor} from '../D3/C2TEXT/edit-caption.mjs';

const id=x=>typeof x==='string'&&/^[A-Za-z0-9][\w.:-]{0,127}$/u.test(x);
const imageId=x=>typeof x==='string'&&/^[\w-]{1,128}$/u.test(x);
const version=x=>Number.isSafeInteger(x)&&x>0;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const card=['shopId','productId','productVersion'];
const who=['shopId','actorId','sessionId'];
const same=(a,b,ks)=>!!a&&!!b&&ks.every(k=>a[k]===b[k]);
const pick=(a,ks)=>Object.fromEntries(ks.map(k=>[k,a[k]]));
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const err=(code,httpStatus=409)=>Object.assign(Error(code),{code,httpStatus});
const require=(ok,code,httpStatus)=>{if(!ok)throw err(code,httpStatus);};
const sync=x=>{require(typeof x?.then!=='function','RESUMEC2_SYNC_HOST_PORT_REQUIRED',503);return x;};
const mode='isolated_prepare_edit_only';
let savepointNo=0;

export function createPracticePlanAdapter({db,practiceShopId,isPracticeOwner,parseD3,catalog,
  readMessage,readPlanningGrant,readP3Commit,readAlbumAsset,clock=Date.now}={}){
  require(typeof db?.prepare==='function'&&typeof db?.exec==='function'&&id(practiceShopId)&&
    [isPracticeOwner,parseD3,catalog?.get,readMessage,readPlanningGrant,readP3Commit,readAlbumAsset,clock].every(f=>typeof f==='function'),
    'RESUMEC2_HOST_PORTS_REQUIRED',503);
  const owned=c=>c?.role==='owner'&&c.shopId===practiceShopId&&who.every(k=>id(c[k]))&&sync(isPracticeOwner(c))===true;
  function tx(run){
    const sp='n22_resumec2_'+(++savepointNo);
    db.exec('SAVEPOINT '+sp);
    try{const out=run();db.exec('RELEASE '+sp);return out;}
    catch(e){db.exec('ROLLBACK TO '+sp);db.exec('RELEASE '+sp);throw e;}
  }
  db.exec('CREATE TABLE IF NOT EXISTS n22_resumec2_turns('+
    'shop TEXT NOT NULL, actor TEXT NOT NULL, sid TEXT NOT NULL, mid TEXT NOT NULL, req TEXT NOT NULL,'+
    'fp TEXT NOT NULL, product TEXT NOT NULL, pver INTEGER NOT NULL, consent TEXT NOT NULL, grant_key TEXT NOT NULL, draft TEXT NOT NULL,'+
    'dver INTEGER NOT NULL, op TEXT NOT NULL, PRIMARY KEY(shop,actor,sid,mid), UNIQUE(shop,actor,sid,req))');
  const versions=createPlanVersionStore(db);
  const scope='shop=? AND actor=? AND sid=?';
  const byMid=db.prepare('SELECT * FROM n22_resumec2_turns WHERE '+scope+' AND mid=?');
  const byReq=db.prepare('SELECT * FROM n22_resumec2_turns WHERE '+scope+' AND req=?');
  const byConsent=db.prepare('SELECT * FROM n22_resumec2_turns WHERE '+scope+' AND consent=? AND op=?');
  const save=db.prepare('INSERT INTO n22_resumec2_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const identity=c=>who.map(k=>c[k]);
  const pin=(c,row)=>({shopId:c.shopId,productId:row.product,productVersion:row.pver});
  const fromMessage=(c,mid)=>sync(readMessage(c,mid));

  // CARD2PLAN trust checks, isolated from its D3 production constructor.
  // PLANGRANT and the album remain the authorities; no grants are made here.
  function load(c,q){
    require(owned(c),'D3_STORE_NOT_ENABLED',403);
    const cur=sync(catalog.get(c,q.productId));
    require(same(cur,q,['productId','productVersion'])&&(cur.shopId==null||cur.shopId===c.shopId),'D3_PRODUCT_VERSION_CHANGED');
    const g=sync(readPlanningGrant(c,pick(q,['productId','productVersion'])));
    require(same(g,{...c,...q},[...who,...card])&&g.purpose==='local_content_only','D3_CARD2PLAN_PERMISSION_REQUIRED',403);
    require(g.status!=='revoked'&&g.revokedAt==null,'D3_CARD2PLAN_PERMISSION_REVOKED',403);
    const expiry=Date.parse(g.expiresAt);
    require(g.status!=='expired'&&expiry>clock(),'D3_CARD2PLAN_PERMISSION_EXPIRED',403);
    require(g.status==='active','D3_CARD2PLAN_PERMISSION_REQUIRED',403);
    require(id(g.p3MessageId)&&version(g.p3ProductVersion)&&g.p3ProductVersion<=q.productVersion&&
      id(g.consentMessageId)&&g.p3MessageId!==g.consentMessageId,'D3_CARD2PLAN_REFERENCE_REQUIRED');
    const original={...q,productVersion:g.p3ProductVersion};
    const p=sync(readP3Commit(c,g.p3MessageId));
    require(p?.status==='catalog_write_committed'&&p.operation==='create'&&p.messageId===g.p3MessageId&&
      same(p,{...c,...original},[...who,...card])&&same(fromMessage(c,g.p3MessageId),original,card)&&
      same(fromMessage(c,g.consentMessageId),q,card),'D3_CARD2PLAN_REFERENCE_REQUIRED');
    require(id(g.copyId)&&version(g.copyVersion)&&typeof g.confirmedCopy==='string'&&id(g.preferenceId)&&version(g.preferenceVersion)&&
      cur.copyProductVersion===q.productVersion&&id(cur.copyConfirmedBy)&&Number.isFinite(Date.parse(cur.copyConfirmedAt))&&
      same(cur,{...g,copyText:g.confirmedCopy},['copyId','copyVersion','copyText']),'D3_CARD2PLAN_CONFIRMED_COPY_REQUIRED');
    const a=g.assets;
    require(Array.isArray(a)&&a.length===2&&a.every(i=>imageId(i?.assetId)&&id(i.batchId)&&id(i.grantId)&&version(i.grantVersion)&&sha(i.sha256))&&
      new Set(a.map(i=>i.assetId.toLowerCase())).size===2&&new Set(a.map(i=>i.sha256)).size===2&&
      Array.isArray(cur.assetIds)&&cur.assetIds.length===2&&cur.assetIds.every(x=>a.some(i=>i.assetId===x))&&
      new Set(cur.assetIds).size===2,'D3_CARD2PLAN_PERMISSION_REQUIRED',403);
    const files=new Map(), pins=[];
    for(const i of a){
      const f=sync(readAlbumAsset(c,i.batchId,i.assetId));
      require(Buffer.isBuffer(f?.bytes)&&f.bytes.length>0,'D3_CARD2PLAN_MEDIA_UNAVAILABLE',404);
      require(f.bytes.length<=MAX_ASSET_BYTES&&Object.hasOwn(MIME_EXT,f.mime)&&byteHash(f.bytes)===i.sha256,'D3_CARD2PLAN_MEDIA_CHANGED');
      const cert={...q,...pick(i,['assetId','grantId','grantVersion','sha256'])};
      pins.push({...cert,kind:'product_shot',usage:'draft_planning',active:true});
      files.set(i.assetId,{...cert,mime:f.mime,bytes:Buffer.from(f.bytes)});
    }
    const source={...q,actorId:c.actorId,sessionId:c.sessionId,allowPlanning:true,
      ...pick(g,['copyId','copyVersion','confirmedCopy','preferenceId','preferenceVersion']),assets:pins};
    const grantKey=digest([source,g.p3MessageId,g.p3ProductVersion,g.consentMessageId,expiry,a.map(i=>[i.batchId,files.get(i.assetId).mime])]);
    return {grantKey,g,source,expiry,files};
  }
  const blocked=(x,code)=>({requestId:x?.requestId,messageId:x?.messageId,status:'failed',code,actions:[]});
  const project=(c,row,state,{replay=false}={})=>{
    const cancel=row.op==='cancel', q={...pin(c,row),messageId:row.mid,requestId:row.req};
    const result=cancel?{draftSetId:state.draftSetId,draftSetVersion:state.version-1,cancelledVersion:state.version}:
      {draftSetId:state.draftSetId,draftSetVersion:state.version,plans:state.plans.map(p=>({
        ...pick(p,['planId','planVersion','styleId','label','visualNote','factCopy']),
        shots:p.shots.map(x=>pick(x,['assetId','durationMs','caption']))
      }))};
    return {...q,status:'completed',appPlanMode:mode,...(replay?{replay:true}:{}),actions:[{...q,
      action:cancel?'content_cancel':'content_prepare',status:cancel?'cancelled':'drafts_ready',result:{...result,deliveryStatus:'not_submitted'}}]};
  };
  function current(c,row){
    const auth=load(c,pin(c,row));
    require(auth.grantKey===row.grant_key,'D3_CARD2PLAN_REPREPARE_REQUIRED');
    const state=row.op==='cancel'?versions.getVersion(c,row.draft,row.dver):versions.getActive(c,row.draft,row.dver);
    require(same(state,{...c,...pin(c,row)},[...who,...card])&&state.draftSetId===row.draft&&
      state.state===(row.op==='cancel'?'canceled':'editable'),'RESUMEC2_REFERENCE_INVALID');
    return {auth,state};
  }
  function turn(c,x,q){
    if(typeof x?.text!=='string'||!x.text.trim()||x.text.length>500)return null;
    const intent=readPlanIntent(x.text,parseD3);
    if(!intent&&!/^(?:请\s*)?(?:立即|直接|帮我\s*)?(?:发布|发给|发送|上架|对外发布)/u.test(x.text.trim()))return null;
    require(id(x.requestId)&&id(x.messageId),'RESUMEC2_INPUT_INVALID',400);
    if(!owned(c))return blocked(x,'D3_STORE_NOT_ENABLED');
    if(!intent||['confirm','adopt'].includes(intent.command))return blocked(x,'D3_CARDPAGE_PREPARATION_ONLY');
    if(intent.invalid||x.batchId!=null)return blocked(x,'D3_COMMAND_AMBIGUOUS');
    if(!id(x.replyToMessageId)||x.replyToMessageId===x.messageId)return blocked(x,'D3_REPLY_REQUIRED');
    if(!q||q.shopId!==c.shopId||!id(q.productId)||!version(q.productVersion))return blocked(x,'D3_PRODUCT_REQUIRED');
    q=pick(q,card);
    const op=intent.command, ref=x.replyToMessageId, k=identity(c);
    const fp=digest([x.text.trim(),ref,q]);
    return tx(()=>{
      const old=byMid.get(...k,x.messageId)??byReq.get(...k,x.requestId);
      if(old){
        require(old.mid===x.messageId&&old.req===x.requestId&&old.fp===fp,'MESSAGE_REUSE_CONFLICT');
        require(same(fromMessage(c,ref),q,card),'D3_REFERENCE_CARD_CONFLICT');
        return project(c,old,current(c,old).state,{replay:true});
      }
      require(same(fromMessage(c,ref),q,card),'D3_REFERENCE_CARD_CONFLICT');
      let state,auth;
      if(op==='prepare'){
        auth=load(c,q);
        require(ref===auth.g.consentMessageId,'D3_CARD2PLAN_REFERENCE_REQUIRED');
        require(!byConsent.get(...k,auth.g.consentMessageId,'cancel'),'C2_SET_CANCELED');
        require(!byConsent.get(...k,auth.g.consentMessageId,'prepare'),'RESUMEC2_ALREADY_PREPARED');
        state=prepareTwoPlans(c,{...auth.source,messageId:x.messageId},{readApprovedAsset:(_,p)=>auth.files.get(p.assetId)});
      }else{
        const parent=byMid.get(...k,ref);
        require(parent&&same(pin(c,parent),q,card)&&parent.op!=='cancel','RESUMEC2_REFERENCE_INVALID');
        const prior=current(c,parent);auth=prior.auth;
        const s={...auth.source,messageId:prior.state.messageId};
        if(op==='cancel')state=cancelPlans(c,s,prior.state,{expectedVersion:parent.dver});
        else{
          // Existing caption editor constructs shots from the exact displayed
          // version; nothing but the selected caption comes from the command.
          const edit=createD3CaptionEditor({contentD3:{
            restore:()=>({...prior.state,status:'drafts_ready',draftSetVersion:prior.state.version,messageId:ref}),
            edit:(ctx,input)=>editPlan(ctx,s,prior.state,{expectedVersion:input.draftSetVersion,planId:input.planId,shots:input.shots})
          }});
          const r=edit(c,{...q,requestId:x.requestId,messageId:x.messageId,referenceMessageId:ref,
            planOrdinal:intent.ordinal,shotOrdinal:intent.shotOrdinal,caption:intent.caption});
          require(r.state==='editable',r.code??'D3_CAPTION_EDIT_RECEIPT_REJECTED');
          const {editTarget,...next}=r;state=next;
        }
      }
      require(owned(c)&&auth.expiry>clock(),'D3_STORE_NOT_ENABLED',403);
      state=versions.record(c,state);
      save.run(...k,x.messageId,x.requestId,fp,q.productId,q.productVersion,auth.g.consentMessageId,auth.grantKey,state.draftSetId,state.version,op);
      return project(c,{mid:x.messageId,req:x.requestId,product:q.productId,pver:q.productVersion,op},state);
    });
  }
  function restore(c,{messageId}={}){
    require(owned(c),'D3_STORE_NOT_ENABLED',403);
    require(id(messageId),'RESUMEC2_INPUT_INVALID',400);
    const row=byMid.get(...identity(c),messageId);
    if(!row)return null;
    require(same(fromMessage(c,messageId),pin(c,row),card),'RESUMEC2_REFERENCE_INVALID',404);
    return project(c,row,current(c,row).state);
  }
  function present(c,receipt){
    if(receipt?.appPlanMode!==mode)return receipt;
    require(owned(c),'D3_STORE_NOT_ENABLED',403);
    const row=byMid.get(...identity(c),receipt.messageId);
    require(row&&row.req===receipt.requestId&&same(receipt,pin(c,row),card),'RESUMEC2_REFERENCE_INVALID',404);
    const live=restore(c,{messageId:receipt.messageId});
    return receipt.replay===true?{...live,replay:true}:live;
  }
  function capability(c){const enabled=owned(c);return {mode:enabled?mode:'not_enabled',prepare:enabled,production:false};}
  return Object.freeze({capability,turn,restore,present});
}
