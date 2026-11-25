const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0;
const commonIds=['shopId','actorId','sessionId','requestId','messageId','referenceMessageId','productId'];
export const D3_PURPOSE=Object.freeze({confirm:'render_selected_plan',adopt:'adopt_selected_work'});
const targetFields={
 render_selected_plan:['draftSetId','draftSetVersion','planId','planVersion'],
 adopt_selected_work:['workId','workVersion']
};
const matches=(a,b,keys)=>keys.every(k=>a?.[k]===b[k]);
const known=(x,k)=>Object.hasOwn(x??{},k);
function validIdentity(c,x){
 const fields=targetFields[x?.purpose];
 return !!fields&&c?.role==='owner'&&commonIds.every(k=>id(x[k]))&&ver(x.productVersion)&&
  x.referenceMessageId!==x.messageId&&matches(x,c,['shopId','actorId','sessionId'])&&
  fields.every(k=>k.endsWith('Version')?ver(x[k]):id(x[k]));
}
function utc(s){
 if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(s))return null;
 const n=Date.parse(s);
 if(!Number.isSafeInteger(n)||new Date(n).toISOString()!==(s.length===20?s.slice(0,-1)+'.000Z':s))return null;
 return n;
}
export const d3Identity=(ctx,x,command)=>{
 const purpose=D3_PURPOSE[command];
 const keys=['shopId','requestId','messageId','referenceMessageId','productId','productVersion',...(targetFields[purpose]??[])];
 return Object.freeze({...Object.fromEntries(keys.map(k=>[k,x[k]])),
  ...(known(x,'confirmationId')?{confirmationId:x.confirmationId}:{}),actorId:ctx.actorId,sessionId:ctx.sessionId,purpose});
};
export function checkD3Consent(ctx,expected,record,nowMs){
 if(!validIdentity(ctx,expected)||!id(record?.confirmationId)||
    (known(expected,'confirmationId')&&record.confirmationId!==expected.confirmationId)||
    !matches(record,expected,[...commonIds,'purpose','productVersion',...targetFields[expected.purpose]]))
  return 'D3_CONFIRMATION_REQUIRED';
 const end=utc(record.expiresAt);
 if(end===null||!Number.isSafeInteger(nowMs))return 'D3_CONFIRMATION_REQUIRED';
 if(end<=nowMs)return 'D3_CONFIRMATION_EXPIRED';
 if(record.active!==true||record.revokedAt!==null||record.canceledAt!==null)
  return record.revokedAt||record.canceledAt||record.active===false?'D3_CONFIRMATION_REVOKED':'D3_CONFIRMATION_REQUIRED';
 return null;
}
export function checkD3Target(ctx,expected,proof){
 if(!validIdentity(ctx,expected))return 'D3_CONFIRMATION_REQUIRED';
 if(proof?.state==='canceled')return 'CANCELED';
 if(proof?.state==='stale_version')return 'STALE_VERSION';
 if(proof?.state!=='current')return 'D3_TARGET_NOT_VERIFIED';
 if(!matches(proof,expected,['shopId','productId','productVersion',...targetFields[expected.purpose]]))return 'STALE_VERSION';
 return null;
}
const fail=code=>{throw Object.assign(new Error(code),{code});};
const failIf=code=>{if(code!==null)fail(code);};
export const isD3ConsentError=code=>['D3_CONFIRMATION_REQUIRED','D3_CONFIRMATION_EXPIRED','D3_CONFIRMATION_REVOKED',
 'D3_CONSENT_NOT_CONNECTED','D3_TARGET_NOT_VERIFIED','D3_MESSAGE_BIND_FAILED','D3_STALE_OR_WRONG_CARD','CANCELED','STALE_VERSION'].includes(code);

// This is the gate at the content service exit. The trusted product port
// owns persistent claim / replay / revocation; it loads record and target
// in its protected commit path, never from the route's earlier snapshot.
export function createD3ContentConsent({contentD3,withConsent,messageLedger,catalog,consentClock=Date.now}={}){
 return Object.freeze(Object.fromEntries(Object.keys(D3_PURPOSE).map(command=>[command,async(ctx,x)=>{
   if(typeof withConsent!=='function'||typeof messageLedger?.read!=='function'||typeof catalog?.get!=='function'||
      typeof contentD3?.[command]!=='function')fail('D3_CONSENT_NOT_CONNECTED');
   const expected=d3Identity(ctx,x,command);
   if(!validIdentity(ctx,expected)||!id(expected.confirmationId))fail('D3_CONFIRMATION_REQUIRED');
   let invoked=false;
   const out=await withConsent(ctx,expected,async (record,target)=>{
    if(invoked)fail('D3_CONFIRMATION_REQUIRED');
    invoked=true;
    const [present,prior,current]=await Promise.all([
     messageLedger.read(ctx,expected.messageId),messageLedger.read(ctx,expected.referenceMessageId),
     catalog.get(ctx,expected.productId)
    ]);
    const keys=['shopId','productId','productVersion'];
    if(!matches(present,expected,keys)||!matches(prior,expected,keys))fail('D3_MESSAGE_BIND_FAILED');
    if(!current||(current.shopId!=null&&current.shopId!==expected.shopId)||
      !matches(current,expected,['productId','productVersion']))fail('D3_STALE_OR_WRONG_CARD');
    failIf(checkD3Target(ctx,expected,target));
    // Time is read after awaited scope/version checks, immediately before
    // entering the real confirm/adopt implementation.
    failIf(checkD3Consent(ctx,expected,record,consentClock()));
    const {actorId,sessionId,purpose,...input}=expected;
    return contentD3[command](ctx,Object.freeze(input));
   });
   return out??fail('D3_CONFIRMATION_REQUIRED');
 }])));
}
