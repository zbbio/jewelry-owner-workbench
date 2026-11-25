import {createHash} from 'node:crypto';
import {exact,failure,owner,token,version} from './p1-contract.mjs';

const scopePath='/api/n22/confirmations';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const id=x=>typeof x==='string'&&uuid.test(x);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const bounded=(x,n)=>typeof x==='string'&&x.length>0&&x.length<=n&&!/[\u0000-\u001f\u007f]/u.test(x);
const field=x=>['price','size'].includes(x);
const headers={'Cache-Control':'no-store'};
const readJSON=x=>x?JSON.parse(x):null;
const asISO=n=>new Date(n).toISOString();
export const P2_VERSION='n99-p2-confirmation/v1';
const terminal=new Map([['expired','CONFIRMATION_EXPIRED'],['revoked','CONFIRMATION_REVOKED'],
 ['stale','CONFIRMATION_VERSION_CHANGED'],['result_unknown','CONFIRMATION_RESULT_UNKNOWN']]);

// The actual write provider remains the existing P34 isolated catalog adapter.
// Extra warehouses must provide verified own previews/consent/version/idempotence;
// no generic HTTP callback or model-supplied action is admitted.
export function createP2Confirmations({db,catalogWrite,isLiveOwner,clock=Date.now,ttlMs=10*60*1000,
 canDecide=()=>true}){
  if(!['previewForConfirmation','inspectConfirmation','decideConfirmation'].every(k=>typeof catalogWrite?.[k]==='function')||
     typeof isLiveOwner!=='function'||typeof canDecide!=='function'||typeof clock!=='function'||
     !Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>10*60*1000)
    throw new TypeError('P2 requires a real isolated P34 adapter and owner authorization');
  db.exec(`
   CREATE TABLE IF NOT EXISTS n99_p2_confirmations(
    id TEXT PRIMARY KEY, shop TEXT NOT NULL, actor TEXT NOT NULL, session TEXT NOT NULL,
    conversation TEXT NOT NULL, message TEXT NOT NULL, run TEXT NOT NULL,
    object TEXT NOT NULL, expected_version INTEGER NOT NULL,
    preview TEXT NOT NULL, preview_sha TEXT NOT NULL,
    created INTEGER NOT NULL, expires INTEGER NOT NULL, phase TEXT NOT NULL DEFAULT 'pending',
    attempted TEXT, UNIQUE(shop,actor,session,message)
   );
   CREATE INDEX IF NOT EXISTS n99_p2_by_owner ON n99_p2_confirmations(shop,actor,session,created DESC,id DESC);
   CREATE TABLE IF NOT EXISTS n99_p2_decision_requests(
    shop TEXT NOT NULL, actor TEXT NOT NULL, session TEXT NOT NULL, request TEXT NOT NULL,
    ticket TEXT NOT NULL, intent TEXT NOT NULL, PRIMARY KEY(shop,actor,session,request),
    FOREIGN KEY(ticket) REFERENCES n99_p2_confirmations(id)
   );
  `);
  const q=(s)=>db.prepare(s);
  const insert=q('INSERT INTO n99_p2_confirmations(id,shop,actor,session,conversation,message,run,object,expected_version,preview,preview_sha,created,expires) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const ticket=q('SELECT * FROM n99_p2_confirmations WHERE shop=? AND actor=? AND session=? AND id=?');
  const message=q('SELECT * FROM n99_p2_confirmations WHERE shop=? AND actor=? AND session=? AND conversation=? AND message=?');
  const first=q('SELECT * FROM n99_p2_confirmations WHERE shop=? AND actor=? AND session=? ORDER BY created DESC,id DESC LIMIT ?');
  const next=q('SELECT * FROM n99_p2_confirmations WHERE shop=? AND actor=? AND session=? AND (created,id)<(?,?) ORDER BY created DESC,id DESC LIMIT ?');
  const byRequest=q('SELECT * FROM n99_p2_decision_requests WHERE shop=? AND actor=? AND session=? AND request=?');
  const remember=q('INSERT INTO n99_p2_decision_requests VALUES (?,?,?,?,?,?)');
  const claim=q("UPDATE n99_p2_confirmations SET phase='deciding',attempted=? WHERE id=? AND phase='pending'");
  const finish=q('UPDATE n99_p2_confirmations SET phase=? WHERE id=?');
  const who=c=>{
    owner(c);
    if(isLiveOwner(c)!==true)throw failure('PRACTICE_OWNER_REQUIRED',401);
    return [c.shopId,c.actorId,c.sessionId];
  };
  const ms=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)throw Error('P2_CLOCK_INVALID');return n;};
  function get(c,k){
    const scope=who(c),row=id(k)?ticket.get(...scope,k):null;
    if(!row)throw failure('CONFIRMATION_NOT_FOUND',404);
    return row;
  }
  function binding(r){
    return Object.freeze({confirmationId:r.id,conversationId:r.conversation,messageId:r.message,runId:r.run,
     productId:r.object,expectedVersion:r.expected_version,action:'catalog.update',reviewDigest:r.preview_sha});
  }
  function resultView(row,data){
    const r=data?.receipt;
    if(data?.status!=='committed'||row.attempted!=='confirm'||r?.productId!==row.object||
       !version(r.productVersion)||r.productVersion<row.expected_version||!['updated','unchanged'].includes(r.outcome))return null;
    return {productId:r.productId,productVersion:r.productVersion,outcome:r.outcome,
      requestId:r.requestId,changedFields:Array.isArray(r.changedFields)?r.changedFields.filter(field):[]};
  }
  function state(c,r){
    const meta=binding(r);
    if(canDecide(c,meta)!==true)return {status:'revoked'};
    const data=catalogWrite.inspectConfirmation(c,r.id);
    if(!data||!data.objectPresent)return {status:'revoked'};
    const business=resultView(r,data);
    if(business)return {status:'confirmed',business};
    if(data.status==='cancelled'&&r.attempted==='cancel')return {status:'canceled'};
    if(data.status==='conflict'||data.currentVersion!==r.expected_version)return {status:'stale',currentVersion:data.currentVersion};
    if(data.status==='expired'||ms()>=r.expires)return {status:'expired'};
    // If acknowledgement was lost, never run this ticket again. Poll the actual
    // upstream intent/receipt. The current provider's commit is synchronous.
    if(r.phase!=='pending'||data.status!=='prepared')return {status:'result_unknown'};
    return {status:'pending'};
  }
  function projection(c,r){
    const s=state(c,r),recheck=['expired','revoked','stale','result_unknown'].includes(s.status);
    return {...binding(r),version:P2_VERSION,source:{conversationId:r.conversation,messageId:r.message},
      object:{kind:'catalog_product',productId:r.object,expectedVersion:r.expected_version},
      createdAt:asISO(r.created),expiresAt:asISO(r.expires),status:s.status,
      preview:s.status==='revoked'?null:readJSON(r.preview),
      ...(s.currentVersion!==undefined?{currentVersion:s.currentVersion}:{}),
      ...(s.business?{receipt:s.business}:{}),...(recheck?{code:terminal.get(s.status)}:{})};
  }
  function forMessage(c,t){
    if(!id(t.conversationId)||!id(t.messageId))return [];
    const row=message.get(...who(c),t.conversationId,t.messageId);
    return row?[projection(c,row)]:[];
  }
  function register(c,scope,p){
    const k=who(c);
    if(!id(scope?.conversationId)||!id(scope.messageId)||!id(scope.runId)||p?.operation!=='update'||
       p?.status!=='prepared'||!id(p.intentId)||p.preparedMessageId!==scope.messageId||p.fixtureOnly!==true)
      throw failure('P2_PREVIEW_NOT_VERIFIED',409);
    const {productId,expectedVersion,difference}=p.preview??{};
    if(!id(productId)||!version(expectedVersion)||!field(difference?.field)||
       !bounded(difference?.after?.value,36)||!bounded(difference?.after?.unit,8))
      throw failure('P2_PREVIEW_NOT_VERIFIED',409);
    const preview={field:difference.field,after:{value:difference.after.value,unit:difference.after.unit},
      before:difference.before&&bounded(String(difference.before.value),36)&&bounded(difference.before.unit,8)?
       {value:String(difference.before.value),unit:difference.before.unit}:null};
    const sha=digest([k[0],k[1],scope.conversationId,scope.messageId,scope.runId,productId,expectedVersion,preview]);
    const old=message.get(...k,scope.conversationId,scope.messageId);
    if(old){if(old.id!==p.intentId||old.preview_sha!==sha)throw failure('P2_PREVIEW_CONFLICT',409);return projection(c,old);}
    const start=ms();
    insert.run(p.intentId,...k,scope.conversationId,scope.messageId,scope.runId,productId,expectedVersion,JSON.stringify(preview),sha,start,start+ttlMs);
    return projection(c,get(c,p.intentId));
  }
  function act(c,ticketId,verb,input){
    const r=get(c,ticketId),k=who(c);
    const {requestId,source,reviewDigest}=exact(input,['requestId','source','reviewDigest']);
    const pin=exact(source,['conversationId','messageId']);
    if(!token(requestId)||!id(pin.conversationId)||!id(pin.messageId)||typeof reviewDigest!=='string'||!/^[a-f0-9]{64}$/u.test(reviewDigest))
      throw failure('INVALID_REQUEST',400);
    if(pin.conversationId!==r.conversation||pin.messageId!==r.message)throw failure('CONFIRMATION_SOURCE_CONFLICT',409);
    if(reviewDigest!==r.preview_sha)throw failure('CONFIRMATION_PREVIEW_CHANGED',409);
    const prior=byRequest.get(...k,requestId);
    if(prior&&(prior.ticket!==r.id||prior.intent!==verb))throw failure('REQUEST_REUSE_CONFLICT',409);
    const view=projection(c,r);
    if(terminal.has(view.status))throw failure(terminal.get(view.status),view.status==='revoked'?403:409);
    if(view.status==='confirmed'||view.status==='canceled'){
      if(view.status!==(verb==='confirm'?'confirmed':'canceled'))
        throw failure('CONFIRMATION_ALREADY_DECIDED',409);
      if(!prior)remember.run(...k,requestId,r.id,verb);
      return {...view,replay:true};
    }
    if(prior)throw failure('CONFIRMATION_RESULT_UNKNOWN',409);
    db.exec('BEGIN IMMEDIATE');
    try{
      if(claim.run(verb,r.id).changes!==1)throw failure('CONFIRMATION_BUSY',409);
      remember.run(...k,requestId,r.id,verb);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    // All active boundaries above and the reused P34/catalog commit are sync.
    // Do not wrap catalog.update in a second SQLite transaction.
    const ack=catalogWrite.decideConfirmation(c,{confirmationId:r.id,sourceMessageId:r.message,verb});
    if(ack&&typeof ack.then==='function')throw Error('P2_SYNC_CATALOG_REQUIRED');
    const t=projection(c,get(c,r.id));
    if(['confirmed','canceled'].includes(t.status)){
      finish.run(t.status,r.id);
      return t;
    }
    throw failure(terminal.get(t.status)??'CONFIRMATION_RESULT_UNKNOWN',t.status==='revoked'?403:409);
  }
  function list(c,u){
    const k=who(c),n=u.searchParams.get('limit'),cursor=u.searchParams.get('before');
    if([...u.searchParams.keys()].some(x=>!['limit','before'].includes(x))||
       ['limit','before'].some(x=>u.searchParams.getAll(x).length>1)||
       (n!==null&&(!/^\d{1,2}$/u.test(n)||Number(n)<1||Number(n)>50))||cursor==='')throw failure('INVALID_QUERY',400);
    const lim=n===null?20:Number(n),boundary=cursor?get(c,cursor):null;
    const rows=boundary?next.all(...k,boundary.created,boundary.id,lim+1):first.all(...k,lim+1);
    return {items:rows.slice(0,lim).map(x=>projection(c,x)),nextBefore:rows.length>lim?rows[lim-1].id:null};
  }
  async function route(p,m,c,read,json,req){
    if(p!==scopePath&&!p.startsWith(scopePath+'/'))return false;
    try{
      who(c);
      const u=new URL(req.url,'http://127.0.0.1');
      if(u.pathname!==p&&u.pathname!=='/api/n22/practice'+p.slice('/api/n22'.length))throw failure('INVALID_QUERY',400);
      let v;
      if(p===scopePath){
        if(m!=='GET')throw failure('METHOD_NOT_ALLOWED',405);
        v=list(c,u);
      }else{
        if(u.search)throw failure('INVALID_QUERY',400);
        const t=p.slice(scopePath.length+1).split('/');
        if(t.length===1&&m==='GET')v=projection(c,get(c,t[0]));
        else if(t.length===2&&m==='POST'&&['confirm','cancel'].includes(t[1]))v=act(c,t[0],t[1],await read());
        else throw failure('METHOD_NOT_ALLOWED',405);
      }
      json(200,v,headers);
    }catch(e){
      if(!e.httpStatus)throw e;
      json(e.httpStatus,{error:{code:e.code}},headers);
    }
    return true;
  }
  return Object.freeze({register,forMessage,route});
}
