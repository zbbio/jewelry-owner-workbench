import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {createS1QaGate} from './s1-qa.mjs';
import {createSdkQuote} from './s1.mjs';

const providers=new WeakMap();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
const ver=x=>Number.isSafeInteger(x)&&x>0;
const between=(x,lo,hi)=>Number.isSafeInteger(x)&&x>=lo&&x<hi;
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
 Object.keys(x).length===keys.length&&Object.keys(x).every(k=>keys.includes(k));
const scopeKeys=['shopId','actorId','sessionId'];
const laneKeys=['productId','productVersion','requestId','messageId'];
const same=(x,y,keys)=>keys.every(k=>x?.[k]===y[k]);
const dynamic=x=>x?.requestId===null&&x.messageId===null;
const laneValid=x=>id(x?.productId)&&ver(x?.productVersion)&&
 (exact(x,laneKeys)&&id(x.requestId)&&id(x.messageId)||
  exact(x,[...laneKeys,'inputTextSha256'])&&dynamic(x)&&/^[0-9a-f]{64}$/u.test(x.inputTextSha256));
const releaseValid=r=>exact(r,['releaseId','notBeforeMs','expiresAtMs','scope','a','b'])&&id(r.releaseId)&&
 ver(r.notBeforeMs)&&ver(r.expiresAtMs)&&between(r.expiresAtMs,r.notBeforeMs+1,r.notBeforeMs+900001)&&
 exact(r.scope,scopeKeys)&&scopeKeys.every(k=>id(r.scope[k]))&&laneValid(r.a)&&laneValid(r.b)&&
 r.a.productVersion===5&&r.b.productVersion===1&&r.a.productId!==r.b.productId&&
 ['messageId','requestId'].every(k=>r.a[k]===null||r.b[k]===null||r.a[k]!==r.b[k]);
const off=()=>Object.freeze({networkPolicy:'disabled',status:()=>({model:'disabled'})});

// No browser endpoint. This factory takes the backend's validated, private
// release and a dedicated on-disk budget DB; no default key source.
export function createG2ProviderMount(options={}){
 if(Object.hasOwn(options,'transport')||Object.hasOwn(options,'fixtureTransport'))return off();
 return mount(options);
}
// Intentionally a separate test-only entry. Real mounting never accepts a
// transport override; the fixture is visibly labelled by createSdkQuote.
export function createG2FixtureMount(options={}){
 if(typeof options.fixtureTransport!=='function')throw new TypeError('fixture transport is required');
 return mount(options,options.fixtureTransport);
}
export function getG2Runtime(handle){return providers.get(handle)??null;}
function mount({budgetDb,release,validateRelease=()=>false,getApiKey,now=Date.now,holdTimeoutMs=75000,record=()=>{}}={},fixture){
 if(!releaseValid(release)||typeof getApiKey!=='function'||typeof budgetDb?.prepare!=='function'||
    !ver(holdTimeoutMs)||holdTimeoutMs>90000)return off();
 let r;try{
   r=structuredClone(release);
   const backing=budgetDb.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
   if(!backing||!isAbsolute(backing)||!between(now(),r.notBeforeMs,r.expiresAtMs)||validateRelease(structuredClone(r))!==true)return off();
 }catch{return off();}
 const rid=hash(['g2-release',r.releaseId]);
 let get,reserve,spend,lease;
 try{
   budgetDb.exec('PRAGMA busy_timeout=4000; PRAGMA synchronous=FULL');
   budgetDb.exec('CREATE TABLE IF NOT EXISTS n22_g2_budget('+
    'release_hash TEXT PRIMARY KEY, single_run INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(single_run=1),'+
    'release_pin_hash TEXT NOT NULL, expires_ms INTEGER NOT NULL,'+
    'a_claim INTEGER NOT NULL DEFAULT 0 CHECK(a_claim IN (0,1)), b_claim INTEGER NOT NULL DEFAULT 0 CHECK(b_claim IN (0,1)),'+
    'a_binding TEXT,b_binding TEXT,'+
    'a_http INTEGER NOT NULL DEFAULT 0 CHECK(a_http BETWEEN 0 AND 2), b_http INTEGER NOT NULL DEFAULT 0 CHECK(b_http BETWEEN 0 AND 2))');
   lease=budgetDb.prepare('INSERT INTO n22_g2_budget(release_hash,release_pin_hash,expires_ms) VALUES(?,?,?) ON CONFLICT DO NOTHING')
    .run(rid,hash(r),r.expiresAtMs).changes===1;
   get=budgetDb.prepare('SELECT a_claim,b_claim,a_http,b_http FROM n22_g2_budget WHERE release_hash=?');
   reserve=Object.fromEntries(['a','b'].map(k=>[k,budgetDb.prepare(
    'UPDATE n22_g2_budget SET '+k+'_claim=1,'+k+'_binding=? WHERE release_hash=? AND expires_ms>? AND '+k+'_claim=0'+(k==='b'?' AND a_http=2':''))]));
   spend=Object.fromEntries(['a','b'].map(k=>[k,budgetDb.prepare(
    'UPDATE n22_g2_budget SET '+k+'_http='+k+'_http+1 WHERE release_hash=? AND expires_ms>? AND '+k+'_claim=1 AND '+k+'_binding=? AND '+k+'_http<2')]));
 }catch{return off();}
 // Deliberately never re-arm a previously admitted release on process
 // restart, even if it crashed before persisting the first provider reply.
 if(!lease)return Object.freeze({networkPolicy:'disabled',status:()=>({model:'disabled',reason:'release_already_opened'})});
 const token=Symbol();
 const digestEvent=(type,k=null,n=null)=>{try{record({type,...(k?{lane:k}:{}),...(n!=null?{sequence:n}:{}),
  releaseHash:rid,eventAt:new Date(now()).toISOString(),mode:fixture?'fixture':'live_eligible'});}catch{/* observer isn't a gate */}};
 const qa=createS1QaGate({authorizeAdmin:a=>a===token,allowFixture:!!fixture,allowLaneBinding:true,now,
  timeoutMs:Math.max(1,Math.min(holdTimeoutMs,r.expiresAtMs-now())),
  record:e=>digestEvent(e.type,e.requestId===r.a.requestId?'a':e.requestId===r.b.requestId?'b':null,e.eventSeq)});
 qa.control('arm',token,r);
 let live=true;
 const timeOK=()=>live&&between(now(),r.notBeforeMs,r.expiresAtMs);
 const which=(ctx,x,p)=>{
  if(ctx?.role!=='owner'||!same(ctx,r.scope,scopeKeys)||p?.shopId!==ctx.shopId)return null;
  const q={...x,productId:p.productId,productVersion:p.productVersion};
  if(!id(q.requestId)||!id(q.messageId))return null;
  return ['a','b'].find(k=>dynamic(r[k])?
   same(q,r[k],['productId','productVersion','inputTextSha256']):same(q,r[k],laneKeys))??null;
 };
 const binding=x=>hash([x.requestId,x.messageId]);
 const authorizeProvider=(ctx,x,p)=>{
  const k=which(ctx,x,p);
  if(!k||!timeOK())return false;
  try{
   if(!qa.permitProvider(ctx,x,p)||!timeOK()||reserve[k].run(binding(x),rid,now()).changes!==1)return false;
   digestEvent('G2_BUSINESS_QUESTION_ADMITTED',k);
   return true;
  }catch{return false;}
 };
 const authorizeAttempt=(ctx,x,p)=>{
  const k=which(ctx,x,p);
  if(!k||!timeOK())return false;
  try{
   if(spend[k].run(rid,now(),binding(x)).changes!==1)return false;
   digestEvent('G2_PROVIDER_HTTP_RESERVED',k);
   const left=r.expiresAtMs-now();
   return left>0?AbortSignal.timeout(left):false;
  }catch{return false;}
 };
 const quote=createSdkQuote({getApiKey:()=>timeOK()?getApiKey():null,authorizeProvider,authorizeAttempt,requireFixtureAuthorization:true,
  ...(fixture?{transport:fixture}:{})});
 const status=()=>{
   const state=qa.control('status',token);
   return {model:!timeOK()||['closed','released'].includes(state.phase)?'disabled':fixture?'fixture_armed':'approval_armed',
    phase:state.phase};
 };
 const handle=Object.freeze({networkPolicy:'approved_backend_only',status,counters(){
  const c=get.get(rid);
  return {businessQuestions:c.a_claim+c.b_claim,providerHttpReservations:c.a_http+c.b_http,
   lanes:{a:{business:c.a_claim,http:c.a_http},b:{business:c.b_claim,http:c.b_http}}};
 },operator(op,params={}){
  if(!['status','b_visible','release','end'].includes(op))throw new Error('G2_OPERATOR_ACTION_DENIED');
  if(op==='end'){live=false;return qa.control('end',token);}
  if(op!=='status'&&!timeOK())throw new Error('G2_RELEASE_NOT_ACTIVE');
  return qa.control(op,token,params);
 }});
 providers.set(handle,Object.freeze({quote,releaseGate:qa}));
 return handle;
}
