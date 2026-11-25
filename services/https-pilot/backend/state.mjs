import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fail,sha} from './config.mjs';
export const OWNER_SECONDS=30*24*3600;
export const PAIR_SECONDS=180;
export const OWNER_COOKIE='__Host-n15session';
export const NONCE_COOKIE='__Host-n15pair';
export const PUBLIC_TEST_NO=/^N15-[A-Z0-9]{4,12}(?![\s\S])/u;
export const tokenShape=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const token=()=>randomBytes(32).toString('base64url');
export function openState(cfg,now=Date.now,{publicBytes=()=>randomBytes(6)}={}){
  mkdirSync(cfg.stateDir,{recursive:true,mode:0o700});
  const sd=lstatSync(cfg.stateDir),p=join(cfg.stateDir,'n15-auth.sqlite');
  if(!sd.isDirectory()||(process.platform==='linux'&&(sd.mode&0o077)!==0)|| (existsSync(p)&&!lstatSync(p).isFile()))fail('UNSAFE_STATE_DIRECTORY',500);
  const db=new DatabaseSync(p);
  try{
    if(process.platform==='linux')chmodSync(p,0o600);
    db.exec(`PRAGMA busy_timeout=4000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS app_scope(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL,shop TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner(id TEXT PRIMARY KEY,tok TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,card TEXT,seq INTEGER NOT NULL DEFAULT 0,qaUsed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS code(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS nonce(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bad(at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS qa(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES owner(id),expires INTEGER NOT NULL,card TEXT,seq INTEGER NOT NULL,aUsed INTEGER NOT NULL DEFAULT 0,bUsed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS qa_control(id TEXT PRIMARY KEY REFERENCES qa(id) ON DELETE CASCADE,publicNo TEXT NOT NULL UNIQUE,
      aRequest TEXT,bRequest TEXT,aHeld INTEGER NOT NULL DEFAULT 0,bReady INTEGER NOT NULL DEFAULT 0,released INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS qa_public_registry(publicNo TEXT PRIMARY KEY CHECK(length(publicNo) BETWEEN 8 AND 16
      AND substr(publicNo,1,4)='N15-' AND substr(publicNo,5) NOT GLOB '*[^A-Z0-9]*'));
    CREATE TABLE IF NOT EXISTS meter(at INTEGER NOT NULL,scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(n INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,value TEXT NOT NULL);`);
  }catch(e){db.close();throw e;}
  const get=(s,...a)=>db.prepare(s).get(...a), all=(s,...a)=>db.prepare(s).all(...a), run=(s,...a)=>db.prepare(s).run(...a);
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
  try{tx(()=>{run('INSERT OR IGNORE INTO app_scope VALUES(1,?,?)',cfg.origin,cfg.storeRef);const s=get('SELECT * FROM app_scope WHERE id=1');
    if(s.origin!==cfg.origin||s.shop!==cfg.storeRef)fail('STATE_SCOPE_MISMATCH',503);});}catch(e){db.close();throw e;}
  const one=t=>get('SELECT * FROM owner WHERE expires>? AND revoked=0 LIMIT 1',t);
  const live=(id,t)=>get('SELECT * FROM owner WHERE id=? AND expires>? AND revoked=0',id,t);
  function current(id){const x=live(id,now());if(!x)return null;const q=get('SELECT q.*,c.publicNo,c.aRequest,c.bRequest,c.aHeld,c.bReady,c.released FROM qa q JOIN qa_control c USING(id) WHERE q.ownerId=? AND q.expires>?',id,now());
    return q?{...q,kind:'qa',ownerId:id}:{...x,kind:'owner',ownerId:id};}
  function expect(id){const c=current(id);if(!c)fail('SESSION_REQUIRED',401);return c;}
  const publicScope=s=>({productId:s.card,seq:s.seq,sessionKind:s.kind});
  function issue(){return tx(()=>{const t=now();if(one(t))fail('OWNER_ALREADY_BOUND',409);
    const b=randomBytes(16),raw=Array.from(b,x=>alphabet[x&31]).join('');b.fill(0);
    run('DELETE FROM code');run('INSERT INTO code VALUES(?,?)',sha(raw),t+PAIR_SECONDS*1000);
    return {code:raw.match(/.{4}/g).join('-'),expiresAt:new Date(t+PAIR_SECONDS*1000).toISOString()};});}
  function pageNonce(previous){return tx(()=>{const t=now();run('DELETE FROM nonce WHERE expires<=?',t);
    if(tokenShape(previous)&&get('SELECT 1 FROM nonce WHERE hash=?',sha(previous)))return previous;
    if(get('SELECT count(*) AS n FROM nonce').n>=64)fail('PAIR_PAGE_LIMIT',429);
    const n=token();run('INSERT INTO nonce VALUES(?,?)',sha(n),t+600_000);return n;});}
  function redeem(code,n){return tx(()=>{const t=now();run('DELETE FROM bad WHERE at<=?',t-300_000);
    if(!tokenShape(n)||!get('SELECT 1 FROM nonce WHERE hash=? AND expires>?',sha(n),t))return {error:'PAIR_PAGE_EXPIRED',status:403};
    if(get('SELECT count(*) AS n FROM bad').n>=8)return {error:'PAIR_RATE_LIMITED',status:429};
    const normalized=typeof code==='string'&&code.length<=64?code.toUpperCase().replace(/[\s-]/g,''):'';
    const d=/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(normalized)?sha(normalized):'';
    if(!d||!get('SELECT 1 FROM code WHERE hash=? AND expires>?',d,t)){run('INSERT INTO bad VALUES(?)',t);return {error:'PAIR_INVALID',status:401};}
    if(one(t))return {error:'OWNER_ALREADY_BOUND',status:409};
    run('DELETE FROM code WHERE hash=?',d);run('DELETE FROM nonce WHERE hash=?',sha(n));
    const v=token();run('INSERT INTO owner(id,tok,expires) VALUES(?,?,?)',randomUUID(),sha(v),t+OWNER_SECONDS*1000);
    return {token:v};});}
  const auth=v=>tokenShape(v)?get('SELECT id FROM owner WHERE tok=? AND expires>? AND revoked=0',sha(v),now())?.id??null:null;
  function select(id,card,seq){return tx(()=>{const s=expect(id);if(s.seq+1!==seq)fail('STALE_SELECTION',409);
    run(s.kind==='qa'?'UPDATE qa SET card=?,seq=? WHERE id=?':'UPDATE owner SET card=?,seq=? WHERE id=?',card,seq,s.id);
    return publicScope({...s,card,seq});});}
  const same=s=>{const p=current(s.ownerId);return p?.kind===s.kind&&p.id===s.id&&p.seq===s.seq&&p.card===s.card;};
  function reserve(id,card,seq,allowed,event){return tx(()=>{const s=expect(id);
    if(s.card!==card||s.seq!==seq)fail('STALE_SELECTION',409);
    const admitted=()=>{if(event)appendAudit({...event,sessionKind:s.kind,publicTestNo:s.publicNo??null,selectionSeq:seq,
      productId:card,code:'REQUEST_ADMITTED',status:null,providerAttempts:0});return s;};
    if(card===null)return admitted();if(!allowed)fail('MODEL_NOT_READY',503);
    const t=now();run('DELETE FROM meter WHERE at<=?',t-3_600_000);
    if(get('SELECT count(*) AS n FROM meter').n>=20||get('SELECT count(*) AS n FROM meter WHERE scope=?',s.kind).n>=(s.kind==='qa'?2:12))fail('TURN_LIMIT',429);
    if(s.kind==='qa'){
      if(card==='A'&&s.aUsed||card==='B'&&(!s.aHeld||s.bUsed))fail('QA_ORDER_OR_LIMIT',429);
      run(card==='A'?'UPDATE qa SET aUsed=1 WHERE id=?':'UPDATE qa SET bUsed=1 WHERE id=?',s.id);
      run(card==='A'?'UPDATE qa_control SET aRequest=? WHERE id=?':'UPDATE qa_control SET bRequest=? WHERE id=?',event?.requestId??null,s.id);
      run('UPDATE owner SET qaUsed=1 WHERE id=?',id);
    }
    run('INSERT INTO meter VALUES(?,?)',t,s.kind);return admitted();});}
  function revoke(id){return tx(()=>{run('DELETE FROM qa WHERE ownerId=?',id);return {revoked:run('UPDATE owner SET revoked=1 WHERE id=? AND revoked=0',id).changes===1};});}
  function qaStart(ownerId){return tx(()=>{const t=now(),o=live(ownerId,t);
    if(!o||o.qaUsed)fail('QA_OWNER_UNAVAILABLE_OR_SPENT',409);
    run('DELETE FROM qa WHERE expires<=?',t);if(get('SELECT 1 FROM qa LIMIT 1'))fail('QA_ACTIVE',409);
    let publicTestNo;
    // Public correlation label only; retries do not change owner, QA ID generation, or authorization.
    for(let i=0;i<32;i++){
      const b=publicBytes();if(!Buffer.isBuffer(b)||b.length!==6)fail('QA_PUBLIC_RANDOM_INVALID',503);
      const candidate='N15-'+b.toString('hex').toUpperCase();
      if(run('INSERT OR IGNORE INTO qa_public_registry VALUES(?)',candidate).changes===1){publicTestNo=candidate;break;}
    }
    if(!publicTestNo)fail('QA_PUBLIC_NO_COLLISIONS',503);
    const id=randomUUID(),expires=t+900_000;
    run('INSERT INTO qa(id,ownerId,expires,seq) VALUES(?,?,?,?)',id,ownerId,expires,randomInt(10**9,19*10**8));
    run('INSERT INTO qa_control(id,publicNo) VALUES(?,?)',id,publicTestNo);
    appendAudit({code:'QA_REGISTERED',publicTestNo,sessionKind:'qa'});
    return {qaRunId:id,publicTestNo,expiresAt:new Date(expires).toISOString()};});}
  function qaContext(s){const cur=current(s.ownerId);return cur?.kind==='qa'&&cur.id===s.id?cur:null;}
  const qaMark=(s,event)=>tx(()=>{
    const q=qaContext(s), isA=event.code==='QA_A_HELD';
    if(!q || !['QA_A_HELD','QA_B_READY'].includes(event.code) || (isA?(event.requestId!==q.aRequest||q.aHeld):
        (event.requestId!==q.bRequest||q.bReady||q.card!=='B'||q.seq!==s.seq)))fail('QA_CONTEXT_CHANGED',409);
    run(isA?'UPDATE qa_control SET aHeld=1 WHERE id=?':'UPDATE qa_control SET bReady=1 WHERE id=?',s.id);return appendAudit(event);
  });
  const qaRelease=(id,confirmed)=>tx(()=>{
    if(confirmed!==true)fail('QA_RELEASE_REQUIRES_B_VISUAL_CONFIRMATION',409);
    const row=get('SELECT ownerId FROM qa WHERE id=?',id), q=row?current(row.ownerId):null;
    if(!q||q.kind!=='qa'||q.id!==id)fail('QA_NOT_ACTIVE',404);
    if(!q.aHeld||!q.bReady||q.card!=='B')fail('QA_B_NOT_READY',409);
    if(q.released)fail('QA_ALREADY_RELEASED',409);
    const a=get("SELECT value FROM audit WHERE json_extract(value,'$.code')='QA_A_HELD' AND json_extract(value,'$.requestId')=? ORDER BY n DESC LIMIT 1",q.aRequest);
    if(!a)fail('QA_HOLD_AUDIT_MISSING',409);
    const held=JSON.parse(a.value);run('UPDATE qa_control SET released=1 WHERE id=?',id);
    return appendAudit({code:'QA_RELEASE_ACK',publicTestNo:q.publicNo,sessionKind:'qa',status:200,
      requestId:q.aRequest,bRequestId:q.bRequest,requestAt:held.requestAt,productId:'A',productVersion:held.productVersion,selectionSeq:held.selectionSeq});
  });
  const qaEnd=(id,reason='QA_ENDED')=>tx(()=>{
    const q=get('SELECT publicNo FROM qa_control WHERE id=?',id);const ended=run('DELETE FROM qa WHERE id=?',id).changes===1;
    if(ended&&q)appendAudit({code:reason,publicTestNo:q.publicNo,sessionKind:'qa'});
    return {ended};});
  const clearQA=()=>tx(()=>{
    for(const x of all('SELECT publicNo FROM qa_control'))appendAudit({code:'QA_RECOVERED_WITHOUT_REPEAT',publicTestNo:x.publicNo,sessionKind:'qa'});
    run('DELETE FROM qa');});
  const list=()=>all('SELECT id AS installationId,expires,qaUsed FROM owner WHERE revoked=0 AND expires>?',now());
  function appendAudit(x){const at=now(),r=run('INSERT INTO audit(at,value) VALUES(?,?)',at,JSON.stringify(x));
    run('DELETE FROM audit WHERE n<=(SELECT COALESCE(MAX(n)-256,0) FROM audit)');return {eventSeq:Number(r.lastInsertRowid),eventAt:new Date(at).toISOString(),...x};}
  const audit=x=>tx(()=>appendAudit(x));
  const auditList=()=>all('SELECT * FROM audit ORDER BY n').map(x=>({eventSeq:x.n,eventAt:new Date(x.at).toISOString(),...JSON.parse(x.value)}));
  return {issue,pageNonce,redeem,auth,expect,publicScope,select,same,reserve,revoke,list,qaStart,qaEnd,clearQA,qaContext,qaMark,qaRelease,audit,auditList,close:()=>db.close()};
}
