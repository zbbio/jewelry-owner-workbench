import {createHash,randomBytes,randomInt,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const SHOP='local-demo-shop';
export const PORT=17864;
export const COOKIE='n14session';
export const OWNER_S=30*24*60*60;
export const PAIR_S=180;
const QA_MS=15*60_000, WINDOW_MS=5*60_000;
const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const digest=x=>createHash('sha256').update(x).digest('hex');
export const privateDir=()=>{if(!process.env.LOCALAPPDATA)throw Error('LOCALAPPDATA_REQUIRED');return join(process.env.LOCALAPPDATA,'JewelryOwnerWorkbench','N14');};
export class Fault extends Error { constructor(code,status=400){super(code);this.code=code;this.status=status;} }
const fail=(code,status)=>{throw new Fault(code,status);};
export function openStore(dir,{now=Date.now}={}){
  mkdirSync(dir,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(dir,'pairing.sqlite'));
  db.exec(`PRAGMA busy_timeout=4000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS pair (digest TEXT PRIMARY KEY, shop TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS n14_pair_nonce (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS n14_pair_post_diag (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, status INTEGER NOT NULL,
    reason TEXT NOT NULL, originClass TEXT NOT NULL, fetchSiteClass TEXT NOT NULL, bodyBytes INTEGER, fieldCount INTEGER, codeLength INTEGER);
  CREATE TABLE IF NOT EXISTS failures (at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS binding (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, shop TEXT NOT NULL, issued INTEGER NOT NULL,
    expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, product TEXT, seq INTEGER NOT NULL DEFAULT 0,
    quotaWindow INTEGER NOT NULL DEFAULT 0, quotaCount INTEGER NOT NULL DEFAULT 0, qaSpent INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS qa (id TEXT PRIMARY KEY, owner TEXT UNIQUE REFERENCES binding(id),
    expires INTEGER NOT NULL, product TEXT, seq INTEGER NOT NULL, aBudget INTEGER NOT NULL DEFAULT 0,
    bBudget INTEGER NOT NULL DEFAULT 0, aHeld INTEGER NOT NULL DEFAULT 0, bReady INTEGER NOT NULL DEFAULT 0,
    aRelease INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS audit (n INTEGER PRIMARY KEY AUTOINCREMENT, qa TEXT, at INTEGER NOT NULL, value TEXT NOT NULL);`);
  const get=(s,...a)=>db.prepare(s).get(...a), all=(s,...a)=>db.prepare(s).all(...a), run=(s,...a)=>db.prepare(s).run(...a);
  function tx(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}
  const format=q=>({productId:q.product,seq:q.seq,sessionKind:q.kind});
  function owner(id,t){return get('SELECT id,shop,product,seq,qaSpent,quotaWindow,quotaCount,expires FROM binding WHERE id=? AND shop=? AND revoked=0 AND expires>?',id,SHOP,t);}
  function current(id,t){const r=owner(id,t);if(!r)return null;
    const q=get('SELECT * FROM qa WHERE owner=? AND expires>?',id,t);
    return q?{...q,storeId:id,kind:'qa'}:{...r,storeId:id,kind:'owner'};}
  function issue(){return tx(()=>{
    const code=Array.from(randomBytes(16),b=>alphabet[b&31]).join(''),until=now()+PAIR_S*1000;
    run('DELETE FROM pair');run('INSERT INTO pair VALUES (?,?,?)',digest(code),SHOP,until);
    return {code:code.match(/.{4}/g).join('-'),expires:until};
  });}
  const nonceShape=x=>typeof x==='string' && /^[A-Za-z0-9_-]{43}$/.test(x);
  function pairPageNonce(previous){return tx(()=>{
    const t=now();run('DELETE FROM n14_pair_nonce WHERE expires<=?',t);
    if(nonceShape(previous)&&get('SELECT 1 AS ok FROM n14_pair_nonce WHERE digest=? AND expires>?',digest(previous),t))return previous;
    if(get('SELECT COUNT(*) AS n FROM n14_pair_nonce').n>=32)fail('PAIR_PAGE_RATE_LIMITED',429);
    const nonce=randomBytes(32).toString('base64url');run('INSERT INTO n14_pair_nonce VALUES(?,?)',digest(nonce),t+10*60_000);return nonce;
  });}
  function redeem(raw,nonce){return tx(()=>{
    const t=now();run('DELETE FROM failures WHERE at<=?',t-WINDOW_MS);
    if(get('SELECT COUNT(*) AS n FROM failures').n>=8)return {error:'PAIR_RATE_LIMITED',status:429,why:'PAIR_RATE_LIMITED'};
    if(nonce!==undefined&&(!nonceShape(nonce)||!get('SELECT 1 AS ok FROM n14_pair_nonce WHERE digest=? AND expires>?',digest(nonce),t)))
      return {error:'PAIR_NONCE_EXPIRED',status:403,why:'NONCE_EXPIRED_OR_UNKNOWN'};
    const code=typeof raw==='string' && raw.length<=64?raw.toUpperCase().replace(/[\s-]/g,''):'';
    const key=/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(code)?digest(code):'';
    const row=key?get('SELECT expires FROM pair WHERE digest=? AND shop=?',key,SHOP):null;
    if(!row||row.expires<=t){run('INSERT INTO failures VALUES (?)',t);return {error:'PAIR_INVALID',status:401,
      why:row?'CODE_EXPIRED':key?'CODE_INVALID_OR_NOT_CURRENT':'CODE_FIELD_FORMAT'};}
    if(get('SELECT 1 AS ok FROM binding WHERE shop=? AND revoked=0 AND expires>? LIMIT 1',SHOP,t))return {error:'OWNER_ALREADY_BOUND',status:409,why:'OWNER_ALREADY_BOUND'};
    run('DELETE FROM pair WHERE digest=? AND shop=?',key,SHOP);
    if(nonce!==undefined)run('DELETE FROM n14_pair_nonce WHERE digest=?',digest(nonce));
    const token=randomBytes(32).toString('base64url');
    run('INSERT INTO binding(id,digest,shop,issued,expires) VALUES (?,?,?,?,?)',randomUUID(),digest(token),SHOP,t,t+OWNER_S*1000);
    return {token};
  });}
  function diagnostic(x){tx(()=>{
    run('INSERT INTO n14_pair_post_diag(at,status,reason,originClass,fetchSiteClass,bodyBytes,fieldCount,codeLength) VALUES(?,?,?,?,?,?,?,?)',
      now(),x.status,x.reason,x.originClass,x.fetchSiteClass,x.bodyBytes,x.fieldCount,x.codeLength);
    run('DELETE FROM n14_pair_post_diag WHERE n <= (SELECT COALESCE(MAX(n)-96,0) FROM n14_pair_post_diag)');
  });}
  function auth(token){if(!/^[A-Za-z0-9_-]{43}$/.test(token||''))return null;
    return get('SELECT id FROM binding WHERE digest=? AND shop=? AND revoked=0 AND expires>?',digest(token),SHOP,now())?.id??null;}
  function expect(id){const q=current(id,now());if(!q)fail('SESSION_REQUIRED',401);return q;}
  function selection(id,p,seq){return tx(()=>{
    const q=expect(id);if(q.seq+1!==seq)fail('STALE_SELECTION',409);
    run(q.kind==='qa'?'UPDATE qa SET product=?,seq=? WHERE id=?':'UPDATE binding SET product=?,seq=? WHERE id=?',p,seq,q.id);
    return format({...q,product:p,seq});
  });}
  function reserve(id,p,seq,live){return tx(()=>{
    const q=expect(id);if(q.product!==p||q.seq!==seq)fail('STALE_SELECTION',409);
    if(p===null)return q;
    if(!live)fail('MODEL_PAUSED',503);
    if(q.kind==='qa'){
      if((p==='A'&&q.aBudget) || (p==='B'&&(!q.aHeld||q.bBudget)))fail('QA_ORDER_OR_LIMIT',429);
      if(p==='A'){run('UPDATE qa SET aBudget=1 WHERE id=?',q.id);run('UPDATE binding SET qaSpent=1 WHERE id=?',id);}
      else run('UPDATE qa SET bBudget=1 WHERE id=?',q.id);
    } else {
      const t=now(), n=t-q.quotaWindow>=3_600_000?0:q.quotaCount;
      if(n>=12)fail('TURN_LIMIT',429);
      run('UPDATE binding SET quotaWindow=?,quotaCount=? WHERE id=?',n?q.quotaWindow:t,n+1,id);
    }
    return q;
  });}
  function sameContext(q){const cur=current(q.storeId,now());return cur?.kind===q.kind&&cur.id===q.id?cur:null;}
  const mark=(q,which,value)=>tx(()=>{if(!sameContext(q)||q.kind!=='qa')fail('STALE_SELECTION',409);
    run(which==='a'?'UPDATE qa SET aHeld=1 WHERE id=?':'UPDATE qa SET bReady=1 WHERE id=?',q.id);
    return appendAudit(q.id,value);});
  function qaStart(ownerId){return tx(()=>{
    const t=now(),a=owner(ownerId,t);if(!a)fail('INSTALLATION_NOT_FOUND',404);
    if(a.qaSpent)fail('QA_ALREADY_SPENT',409);
    run('DELETE FROM qa WHERE expires<=?',t);
    if(get('SELECT id FROM qa LIMIT 1'))fail('QA_ALREADY_ACTIVE',409);
    const id=randomUUID(),expires=t+QA_MS;
    // Keep owner and temporary selection sequences disjoint. Client always sends exactly seq+1.
    run('INSERT INTO qa(id,owner,expires,seq) VALUES (?,?,?,?)',id,ownerId,expires,randomInt(1_000_000_000,1_900_000_000));
    return {qaRunId:id,installationId:ownerId,expiresUtc:new Date(expires).toISOString()};
  });}
  function qaRelease(id){return tx(()=>{
    const q=get('SELECT * FROM qa WHERE id=? AND expires>?',id,now());if(!q||!owner(q.owner,now()))fail('QA_NOT_FOUND',404);
    if(!q.aHeld||!q.bReady||q.product!=='B')fail('QA_B_NOT_READY',409);
    if(q.aRelease)fail('QA_ALREADY_RELEASED',409);
    const held=get("SELECT value FROM audit WHERE qa=? AND json_extract(value,'$.code')='QA_A_HELD' ORDER BY n DESC LIMIT 1",id);
    if(!held)fail('QA_HOLD_NOT_RECORDED',409);
    const v=JSON.parse(held.value);
    run('UPDATE qa SET aRelease=1 WHERE id=?',id);
    const e=appendAudit(id,{requestId:v.requestId,utc:v.utc,requestAt:v.requestAt,productId:v.productId,
      cardId:v.cardId,productVersion:v.productVersion,selectionSeq:v.selectionSeq,status:200,code:'QA_RELEASE_ACK'});
    return {qaRunId:id,released:true,requestId:e.requestId,eventAt:e.eventAt,eventSeq:e.eventSeq};
  });}
  const qaEnd=id=>({qaRunId:id,ended:run('DELETE FROM qa WHERE id=?',id).changes===1});
  const revoke=id=>tx(()=>{run('DELETE FROM qa WHERE owner=?',id);return {installationId:id,revoked:run('UPDATE binding SET revoked=1 WHERE id=? AND revoked=0',id).changes===1};});
  const list=()=>all(`SELECT b.id AS installationId,b.issued,b.expires,b.qaSpent,q.id AS qaRunId,
    q.expires AS qaExpires,q.aHeld,q.bReady,q.aRelease FROM binding b LEFT JOIN qa q ON q.owner=b.id AND q.expires>?
    WHERE b.revoked=0 AND b.expires>? ORDER BY b.issued`,now(),now());
  // No tokens, prompts, source paths or raw provider IDs enter persistent audit.
  function appendAudit(qaId,value){
    const at=now(),eventAt=new Date(at).toISOString();
    const x=run('INSERT INTO audit(qa,at,value) VALUES (?,?,?)',qaId,at,JSON.stringify({...value,eventAt}));
    run('DELETE FROM audit WHERE n <= (SELECT COALESCE(MAX(n)-256,0) FROM audit)');
    return {...value,eventAt,eventSeq:Number(x.lastInsertRowid)};
  }
  const audit=(q,value)=>tx(()=>appendAudit(q.kind==='qa'?q.id:null,value));
  const getAudit=id=>all('SELECT n,at,value FROM audit WHERE qa=? ORDER BY n',id)
    .map(x=>({...JSON.parse(x.value),eventAt:new Date(x.at).toISOString(),eventSeq:x.n}));
  // First process listener clears orphan QA only after acquiring the public HTTP port.
  const clearQA=()=>run('DELETE FROM qa');
  return {close:()=>db.close(),issue,pairPageNonce,redeem,diagnostic,auth,expect,format,selection,reserve,sameContext,mark,qaStart,qaRelease,qaEnd,revoke,list,audit,getAudit,clearQA};
}
