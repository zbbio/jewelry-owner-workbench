import {createHash,randomUUID as uid} from 'node:crypto';
import {createAlbum} from './album/index.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const key=x=>typeof x==='string'&&/^[\p{L}\p{N}_.:-]{1,128}$/u.test(x);
const positive=x=>Number.isSafeInteger(x)&&x>=1;
const exact=(x,names)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>names.includes(k));
const require=(v,code,httpStatus=400)=>{if(!v)throw Object.assign(Error(code),{code,httpStatus});};
const stable=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const queued=new WeakMap();
const noEffects=()=>({catalogCreated:0,catalogUpdated:0,cardAssetLinksAdded:0});
const H=['requestId','messageId','replyToMessageId','groupId','draftGroupVersion','intent','targetProductId','expectedVersion'];
const storage=
  'CREATE TABLE IF NOT EXISTS n22_album_drafts(s TEXT,t TEXT,actor TEXT,session TEXT,json TEXT,PRIMARY KEY(s,t));'+
  'CREATE TABLE IF NOT EXISTS n22_album_refs(s TEXT,actor TEXT,session TEXT,m TEXT,t TEXT,view TEXT,PRIMARY KEY(s,actor,session,m));'+
  'CREATE TABLE IF NOT EXISTS n22_album_draft_ops(s TEXT,r TEXT,actor TEXT,session TEXT,k TEXT,signature TEXT,outgoing TEXT,reply TEXT,PRIMARY KEY(s,r));'+
  'CREATE TABLE IF NOT EXISTS n22_album_deliveries(s TEXT,g TEXT,r TEXT,t TEXT,phase TEXT,PRIMARY KEY(s,g));';

/** Owns drafts/receipts only. Product commit must be an explicitly authorized existing product port. */
export function createGroupDrafts({db,dataDir,catalogRead,catalogWrite,authorizeBatchReference,authorizeDelivery}={}){
  if(!db||typeof authorizeBatchReference!=='function')throw new TypeError('draft db and authoritative message lookup required');
  // Same-batch proposals use this read-only instance. Existing-card comparisons need an explicit catalogRead grant.
  const album=createAlbum({db,dataDir,catalog:{list:()=>[]}});
  db.exec(storage);
  if(!queued.has(db))queued.set(db,new Map());
  const queue=queued.get(db), get=(q,...p)=>db.prepare(q).get(...p),run=(q,...p)=>db.prepare(q).run(...p);
  const toJson=JSON.stringify,parse=JSON.parse;
  const tx=f=>{db.exec('BEGIN IMMEDIATE');try{const v=f();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  function scope(c){
    require(key(c?.shopId)&&key(c?.actorId)&&key(c?.sessionId)&&c?.role==='owner','A34_FORBIDDEN',403);
    return Object.freeze({shopId:c.shopId,actorId:c.actorId,sessionId:c.sessionId,role:'owner'});
  }
  function serial(c,func){
    const s=c.shopId,next=(queue.get(s)??Promise.resolve()).catch(()=>{}).then(func);queue.set(s,next);
    const settle=()=>{if(queue.get(s)===next)queue.delete(s)};next.then(settle,settle);
    return next;
  }
  function readBatch(c,b){
    const d=get('SELECT * FROM n22_album_drafts WHERE s=? AND t=?',c.shopId,b);
    if(!d)return null;
    require(d.actor===c.actorId&&d.session===c.sessionId,'DRAFT_NOT_IN_SCOPE',404);
    return parse(d.json);
  }
  function ref(c,m){
    const x=get('SELECT view FROM n22_album_refs WHERE s=? AND actor=? AND session=? AND m=?',c.shopId,c.actorId,c.sessionId,m);
    return x?parse(x.view):null;
  }
  function saveRef(c,m,record){
    require(!ref(c,m),'DRAFT_MESSAGE_ALREADY_USED',409);
    run('INSERT INTO n22_album_refs VALUES(?,?,?,?,?,?)',c.shopId,c.actorId,c.sessionId,m,record.batchId,toJson(record));
  }
  function operation(c,k,r,body){
    const sig=hash(body),old=get('SELECT * FROM n22_album_draft_ops WHERE s=? AND r=?',c.shopId,r);
    if(old){
      require(old.actor===c.actorId&&old.session===c.sessionId,'DRAFT_REQUEST_NOT_IN_SCOPE',404);
      require(old.k===k&&old.signature===sig,'IDEMPOTENCY_CONFLICT',409);
    }
    return {old,sig};
  }
  function saveOp(c,k,r,sig,outgoing,reply){
    run('INSERT INTO n22_album_draft_ops VALUES(?,?,?,?,?,?,?,?)',
      c.shopId,r,c.actorId,c.sessionId,k,sig,outgoing?toJson(outgoing):null,reply?toJson(reply):null);
  }
  const lock=(c,g)=>get('SELECT phase,r FROM n22_album_deliveries WHERE s=? AND g=?',c.shopId,g);
  function publicDraft(c,x,d){
    const groups=d.groups.map((x,i)=>({...x,ordinal:i+1,deliveryStatus:lock(c,x.groupId)?.phase??'not_requested'}));
    const used=new Set(groups.flatMap(g=>g.keptAssetIds));
    return {status:'draft_only',shopId:c.shopId,requestId:x.requestId,messageId:x.messageId,batchId:d.batchId,
      draftVersion:d.draftVersion,groups,pendingAssetIds:d.assets.filter(y=>!used.has(y)),
      inspection:d.inspection,effects:noEffects()};
  }
  function publish(c,k,x,d,sig){
    const v=publicDraft(c,x,d);
    saveRef(c,x.messageId,v);saveOp(c,k,x.requestId,sig,null,v);return v;
  }

  async function prepare(ctx,x){
    const c=scope(ctx);
    require(exact(x,['requestId','messageId','replyToMessageId','batchId'])&&
      [x.requestId,x.messageId,x.replyToMessageId,x.batchId].every(key),'INVALID_DRAFT_REQUEST');
    // An upload and its organize-only turn may share the real message ID.
    // Equality is not a grant; the scoped persisted batch and host below still
    // have to attest this exact upload. Corrections keep their own new ID.
    const body=[x.messageId,x.replyToMessageId,x.batchId];
    return serial(c,async()=>{
      const t=album.getTask(c,x.batchId);
      require(t?.kind==='import'&&t.analysis?.mode==='organize_only'&&t.analysis.messageId===x.replyToMessageId,'BATCH_NOT_IN_SCOPE',404);
      require(await authorizeBatchReference(c,{batchId:x.batchId,messageId:x.replyToMessageId})===true,'BATCH_REFERENCE_NOT_VERIFIED',403);
      const {old,sig}=operation(c,'prepare',x.requestId,body);
      if(old)return parse(old.reply);
      const current=readBatch(c,x.batchId);
      let fresh=current;
      if(!fresh){
        const confirmed=t.items.filter(a=>a.status==='kept').map(a=>a.assetId), allowed=new Set(confirmed);
        const inspection=await album.inspectOrganizeBatch(c,x.batchId,{catalogRead});
        const groups=[];
        for(const proposed of inspection.proposals){
          const arr=[...new Set(proposed.keptAssetIds)];
          const candidate=key(proposed.suggestedProductId)&&positive(proposed.suggestedProductVersion)?
            {productId:proposed.suggestedProductId,productVersion:proposed.suggestedProductVersion}:null;
          if(arr.length<(candidate?1:2)||arr.some(id=>!allowed.has(id)))continue;
          for(const id of arr)allowed.delete(id);
          const measured=candidate&&inspection.cardReferences.candidates.find(r=>
            r.productId===candidate.productId&&r.productVersion===candidate.productVersion&&stable(r.assetIds,arr));
          groups.push({groupId:uid(),draftGroupVersion:1,keptAssetIds:arr,decisionSource:'system_checked',
            evidenceRef:uid(),reason:proposed.reason,...(candidate?{suggestedTarget:candidate}:{}),
            ...(measured?{suggestionEvidence:{kind:'readonly_suggestion',
              extractorVersion:inspection.cardReferences.extractor.version,
              authorizedReferenceCount:measured.authorizedReferenceCount,
              featureReadyCount:measured.featureReadyCount,actualPairs:measured.actualPairs,strongPairs:measured.strongPairs}}:{})});

        }
        fresh={batchId:x.batchId,draftVersion:1,assets:confirmed,groups,inspection};
      }
      return tx(()=>{
        const second=operation(c,'prepare',x.requestId,body);
        if(second.old)return parse(second.old.reply);
        const now=readBatch(c,x.batchId);
        if(now)return publish(c,'prepare',x,now,sig);
        run('INSERT INTO n22_album_drafts VALUES(?,?,?,?,?)',c.shopId,x.batchId,c.actorId,c.sessionId,toJson(fresh));
        return publish(c,'prepare',x,fresh,sig);
      });
    });
  }
  function readMessageGroup(ctx,messageId,ordinal){
    const c=scope(ctx);
    if(!key(messageId)||!positive(ordinal))return null;
    const r=ref(c,messageId),g=r?.groups.find(v=>v.ordinal===ordinal);
    return g?{batchId:r.batchId,replyToMessageId:messageId,draftVersion:r.draftVersion,groupId:g.groupId,
      draftGroupVersion:g.draftGroupVersion,keptAssetIds:g.keptAssetIds}:null;
  }
  function pinned(c,m){
    require(key(m),'INVALID_DRAFT_REFERENCE');
    const r=ref(c,m),d=r&&readBatch(c,r.batchId);
    require(d,'DRAFT_REFERENCE_NOT_IN_SCOPE',404);
    require(r.draftVersion===d.draftVersion,'STALE_DRAFT_REFERENCE',409);
    return {r,d};
  }
  function readMessageDraft(ctx,messageId){
    const c=scope(ctx);
    return key(messageId)?ref(c,messageId)??null:null;
  }
  function checkMessageGroup(ctx,x){
    const c=scope(ctx);
    require(exact(x,['replyToMessageId','ordinal','groupId','draftGroupVersion'])&&key(x.replyToMessageId)&&
      (positive(x.ordinal)||key(x.groupId))&&(x.ordinal===undefined||positive(x.ordinal))&&
      (x.groupId===undefined||key(x.groupId))&&(x.draftGroupVersion===undefined||positive(x.draftGroupVersion)),
      'INVALID_DRAFT_REFERENCE');
    const {r,d}=pinned(c,x.replyToMessageId);
    const shown=r.groups.find(g=>(x.ordinal===undefined||g.ordinal===x.ordinal)&&(x.groupId===undefined||g.groupId===x.groupId));
    require(shown,'DRAFT_GROUP_NOT_IN_MESSAGE',404);
    const live=d.groups.find(g=>g.groupId===shown.groupId);
    require(live&&live.draftGroupVersion===shown.draftGroupVersion&&
      (x.draftGroupVersion===undefined||live.draftGroupVersion===x.draftGroupVersion)&&
      stable(shown.keptAssetIds,live.keptAssetIds),'STALE_OR_UNPINNED_GROUP',409);
    const t=album.getTask(c,d.batchId);
    require(t?.kind==='import'&&t.analysis?.mode==='organize_only','BATCH_NOT_IN_SCOPE',404);
    const kept=new Map(t.items.filter(z=>z.status==='kept').map(z=>[z.assetId,z.sha256]));
    const assets=live.keptAssetIds.map(assetId=>{
      const digest=kept.get(assetId);
      require(typeof digest==='string'&&/^[0-9a-f]{64}$/u.test(digest),'ASSET_CHANGED',409);
      let original;
      try{original=album.readAsset(c,assetId);}catch{throw Object.assign(Error('ASSET_CHANGED'),{code:'ASSET_CHANGED',httpStatus:409});}
      require(original?.bytes&&createHash('sha256').update(original.bytes).digest('hex')===digest,'ASSET_CHANGED',409);
      return {assetId,sha256:digest};
    });
    return {shopId:c.shopId,batchId:d.batchId,replyToMessageId:x.replyToMessageId,draftVersion:d.draftVersion,
       groupId:live.groupId,draftGroupVersion:live.draftGroupVersion,ordinal:shown.ordinal,
       keptAssetIds:[...live.keptAssetIds],assets,decisionSource:live.decisionSource,evidenceRef:live.evidenceRef};
  }
  async function correct(ctx,x){
    const c=scope(ctx);
    require(exact(x,['requestId','messageId','replyToMessageId','expectedDraftVersion','groups'])&&
      [x.requestId,x.messageId,x.replyToMessageId].every(key)&&x.messageId!==x.replyToMessageId&&positive(x.expectedDraftVersion)&&
      Array.isArray(x.groups)&&x.groups.length<=12,'INVALID_CORRECTION');
    const asked=x.groups.map(y=>{
      require(exact(y,['groupId','keptAssetIds'])&&(y.groupId===undefined||key(y.groupId))&&
        Array.isArray(y.keptAssetIds)&&y.keptAssetIds.length>0&&y.keptAssetIds.length<=12&&y.keptAssetIds.every(key),'INVALID_CORRECTION');
      return {groupId:y.groupId??null,keptAssetIds:[...y.keptAssetIds]};
    });
    const body=[x.messageId,x.replyToMessageId,x.expectedDraftVersion,asked];
    return serial(c,()=>tx(()=>{
      const {old,sig}=operation(c,'correct',x.requestId,body);
      if(old)return parse(old.reply);
      const {r,d}=pinned(c,x.replyToMessageId);
      require(d.draftVersion===x.expectedDraftVersion,'DRAFT_VERSION_CONFLICT',409);
      const allowedAssets=new Set(d.assets), ids=new Set(), oldById=new Map(d.groups.map(y=>[y.groupId,y]));
      const seen=new Set(), pinnedIds=new Set(r.groups.map(y=>y.groupId));
      const groups=asked.map(a=>{
        for(const id of a.keptAssetIds){require(allowedAssets.has(id)&&!seen.has(id),'ASSET_OUT_OF_SCOPE_OR_REUSED',409);seen.add(id);}
        const previous=a.groupId?oldById.get(a.groupId):null;
        if(a.groupId){
          require(previous&&pinnedIds.has(a.groupId)&&!ids.has(a.groupId),'UNPINNED_DRAFT_GROUP',409);ids.add(a.groupId);
          if(stable(previous.keptAssetIds,a.keptAssetIds))return previous;
          require(!lock(c,a.groupId),'DRAFT_ALREADY_SUBMITTED',409);
        }
        return {groupId:previous?.groupId??uid(),draftGroupVersion:(previous?.draftGroupVersion??0)+1,
          keptAssetIds:a.keptAssetIds,decisionSource:'owner_confirmed',evidenceRef:uid(),
          reason:'owner_corrected_in_scoped_message',correctionMessageId:x.messageId};
      });
      for(const previous of d.groups)if(!ids.has(previous.groupId))require(!lock(c,previous.groupId),'DRAFT_ALREADY_SUBMITTED',409);
      const next={...d,draftVersion:d.draftVersion+1,groups};
      run('UPDATE n22_album_drafts SET json=? WHERE s=? AND t=?',toJson(next),c.shopId,d.batchId);
      return publish(c,'correct',x,next,sig);
    }));
  }

  function inputHandoff(x){
    require(exact(x,H)&&[x.requestId,x.messageId,x.replyToMessageId,x.groupId].every(key)&&x.messageId!==x.replyToMessageId&&
       positive(x.draftGroupVersion)&&['create','supplement'].includes(x.intent),'INVALID_HANDOFF');
    require(x.intent==='create'?x.targetProductId===undefined&&x.expectedVersion===undefined:
      key(x.targetProductId)&&positive(x.expectedVersion),'INVALID_HANDOFF_TARGET');
    return {requestId:x.requestId,messageId:x.messageId,replyToMessageId:x.replyToMessageId,groupId:x.groupId,
      draftGroupVersion:x.draftGroupVersion,intent:x.intent,...(x.intent==='supplement'?
      {targetProductId:x.targetProductId,expectedVersion:x.expectedVersion}:{})};
  }
  function preview(c,x){
    const {r,d}=pinned(c,x.replyToMessageId);
    const group=r.groups.find(y=>y.groupId===x.groupId), current=d.groups.find(y=>y.groupId===x.groupId);
    require(group&&current&&group.draftGroupVersion===x.draftGroupVersion&&current.draftGroupVersion===x.draftGroupVersion&&
      stable(current.keptAssetIds,group.keptAssetIds),'STALE_OR_UNPINNED_GROUP',409);
    return {shopId:c.shopId,batchId:d.batchId,draftVersion:d.draftVersion,replyToMessageId:x.replyToMessageId,groupId:x.groupId,
      draftGroupVersion:x.draftGroupVersion,intent:x.intent,keptAssetIds:current.keptAssetIds,
      decisionSource:current.decisionSource,evidenceRef:current.evidenceRef,...(x.intent==='supplement'?
        {targetProductId:x.targetProductId,expectedVersion:x.expectedVersion}:{})};
  }
  function previewDelivery(ctx,x){
    const c=scope(ctx);x=inputHandoff(x);
    return {status:'confirmation_required',requestId:x.requestId,messageId:x.messageId,...preview(c,x),effects:noEffects()};
  }
  const identicalAction=(a,b)=>['intent','groupId','draftGroupVersion','targetProductId','expectedVersion'].every(k=>a[k]===b[k]);
  async function handoff(ctx,x){
    const c=scope(ctx);x=inputHandoff(x);
    const envelope={shopId:c.shopId,requestId:x.requestId,messageId:x.messageId};
    return serial(c,async()=>{
      const {old,sig}=operation(c,'handoff',x.requestId,x);
      if(old?.reply)return parse(old.reply);
      let outgoing=old?parse(old.outgoing):null;
      if(!outgoing){
        const proposal=preview(c,x),confirmed=lock(c,proposal.groupId);
        if(confirmed){
          require(confirmed.phase==='committed','GROUP_HANDOFF_PENDING',409);
          return tx(()=>{
            const prior=get('SELECT outgoing,reply FROM n22_album_draft_ops WHERE s=? AND r=?',c.shopId,confirmed.r);
            require(prior?.reply&&identicalAction(parse(prior.outgoing).command,x),'GROUP_ALREADY_DELIVERED',409);
            const r={...envelope,status:'already_committed',batchId:proposal.batchId,catalogReceipt:parse(prior.reply).catalogReceipt,effects:noEffects()};
            saveOp(c,'handoff',x.requestId,sig,null,r);return r;
          });
        }
        require(typeof catalogWrite?.acceptGroup==='function','CATALOG_WRITE_NOT_CONNECTED',503);
        // Trusted host looks up a distinct user confirmation for this exact proposal.
        // No client boolean, text implying approval, or system_checked inference is sufficient.
        const approval=await authorizeDelivery?.(c,{...proposal,requestId:x.requestId,messageId:x.messageId});
        require(key(approval?.approvalRef)&&approval.approved===true,'OWNER_CONFIRMATION_REQUIRED',403);
        // A4 v1 starts at official version 1; earlier draft revisions are separate.
        const wire={requestId:x.requestId,taskId:proposal.batchId,groupId:x.groupId,groupVersion:1,
          keptAssetIds:proposal.keptAssetIds,decisionSource:proposal.decisionSource,evidenceRef:proposal.evidenceRef,
          ...(proposal.targetProductId?{targetProductId:proposal.targetProductId,expectedVersion:proposal.expectedVersion}:{})};
        outgoing={wire,command:x,approvalRef:approval.approvalRef};
        tx(()=>{
          const check=operation(c,'handoff',x.requestId,x);
          require(!check.old&&!lock(c,x.groupId)&&stable(preview(c,x),proposal),'GROUP_CHANGED_WHILE_CONFIRMING',409);
          run('INSERT INTO n22_album_deliveries VALUES(?,?,?,?,?)',c.shopId,x.groupId,x.requestId,wire.taskId,'awaiting_catalog_receipt');
          saveOp(c,'handoff',x.requestId,sig,outgoing,null);
        });
      }
      const wire=outgoing.wire;
      const waiting=()=>({...envelope,status:'awaiting_catalog_receipt',batchId:wire.taskId,groupId:wire.groupId});
      if(typeof catalogWrite?.acceptGroup!=='function')return waiting();
      let receipt;
      try{receipt=await catalogWrite.acceptGroup(c,wire);}catch(e){
        const code=key(e?.code)?e.code:'CATALOG_REJECTED';
        if(![400,403,404,409,422].includes(e?.httpStatus??e?.status))return waiting();
        const out={...envelope,status:'rejected',batchId:wire.taskId,groupId:wire.groupId,code,effects:noEffects()};
        return tx(()=>{
          run('UPDATE n22_album_draft_ops SET reply=? WHERE s=? AND r=? AND reply IS NULL',toJson(out),c.shopId,x.requestId);
          run('DELETE FROM n22_album_deliveries WHERE s=? AND g=? AND r=? AND phase=?',
            c.shopId,x.groupId,x.requestId,'awaiting_catalog_receipt');
          return parse(operation(c,'handoff',x.requestId,x).old.reply);
        });
      }
      if(!(receipt?.status==='committed'&&['requestId','taskId','groupId','groupVersion'].every(k=>receipt[k]===wire[k])&&
         key(receipt.productId)&&positive(receipt.productVersion)&&(!wire.targetProductId||wire.targetProductId===receipt.productId)&&
         ['created','images_added','unchanged'].includes(receipt.outcome)&&Array.isArray(receipt.linkedAssetIds)&&
         Array.isArray(receipt.addedAssetIds)&&wire.keptAssetIds.every(a=>receipt.linkedAssetIds.includes(a))&&
         receipt.addedAssetIds.every(a=>wire.keptAssetIds.includes(a))))return waiting();
      const out={...envelope,status:'committed',batchId:wire.taskId,groupId:wire.groupId,catalogReceipt:receipt};
      return tx(()=>{
        run('UPDATE n22_album_deliveries SET phase=? WHERE s=? AND g=? AND r=?','committed',c.shopId,x.groupId,x.requestId);
        run('UPDATE n22_album_draft_ops SET reply=? WHERE s=? AND r=? AND reply IS NULL',toJson(out),c.shopId,x.requestId);
        return parse(operation(c,'handoff',x.requestId,x).old.reply);
      });
    });
  }
  function getDraft(ctx,batchId){
    const c=scope(ctx);require(key(batchId),'INVALID_BATCH');
    const data=readBatch(c,batchId);
    return data?publicDraft(c,{requestId:null,messageId:null},data):null;
  }
  return Object.freeze({prepare,correct,previewDelivery,handoff,readMessageGroup,readMessageDraft,checkMessageGroup,getDraft});
}
