// PC-only operator bridge. Never expose this module over HTTP or serialize its code.
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {privateDir,PORT,SHOP,PAIR_S} from './会话库.mjs';

const KEY='N14-PAIRFIX';
const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const sha=x=>createHash('sha256').update(x).digest('hex');
const origin=`http://127.0.0.1:${PORT}`;
const now=()=>Date.now();
const iso=t=>new Date(t).toISOString();

async function currentInstance(){
  const dir=privateDir(),meta=JSON.parse(await readFile(join(dir,'service.json'),'utf8'));
  const r=await fetch(origin+'/api/health',{redirect:'error',signal:AbortSignal.timeout(2000)});
  const j=await r.json();
  if(!r.ok||j.service!=='n14-local-readonly'||j.runId!==meta.runId||meta.origin!==origin)throw Error('N14_LIVE_INSTANCE_NOT_CONFIRMED');
  return {file:join(dir,'pairing.sqlite'),runId:j.runId,pairProtocol:j.pairProtocol};
}

function scan(db,t){
  const n=db.prepare('SELECT count(*) AS n FROM binding WHERE shop=? AND revoked=0 AND expires>?').get(SHOP,t).n;
  return {observedAtUtc:iso(t),activeOwnerBinding:n>0?1:0,uniqueOrAbsent:n<=1,
    pendingCode:db.prepare('SELECT count(*) AS n FROM pair WHERE shop=? AND expires>?').get(SHOP,t).n>0,
    qaActive:db.prepare('SELECT count(*) AS n FROM qa WHERE expires>?').get(t).n>0};
}

// Inputs to this PC-local transaction are trusted from currentInstance() or the isolated tests.
export function operateInstance({file,runId,pairProtocol},op,{time=now,generate=()=>randomBytes(16)}={}){
  if(!['status','prepare','issue','adopt-v2','diagnostics'].includes(op))throw Error('PAIRFIX_INVALID_OPERATION');
  const readonly=op==='status'||op==='diagnostics';
  const db=new DatabaseSync(file,{readOnly:readonly});
  try{
    db.exec('PRAGMA busy_timeout=4000');
    if(readonly){db.exec('PRAGMA query_only=ON');const state=scan(db,time());
      if(op==='status')return state;
      const found=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='n14_pair_post_diag'").get();
      const events=found?db.prepare('SELECT n AS eventSeq,at,status,reason,originClass,fetchSiteClass,bodyBytes,fieldCount,codeLength FROM n14_pair_post_diag ORDER BY n').all()
        .map(({at,...row})=>({...row,eventAt:iso(at)})):[];
      return {...state,pairProtocol:pairProtocol??null,observerInstalled:Boolean(found),eventCount:events.length,events};
    }
    db.exec('BEGIN IMMEDIATE');
    try{
      const t=time(),before=scan(db,t);
      if(before.activeOwnerBinding){db.exec('COMMIT');return {...before,stage:'owner_present_refresh_only'};}
      if(before.qaActive)throw Error('PAIRFIX_UNEXPECTED_QA_STATE');
      db.exec(`CREATE TABLE IF NOT EXISTS n14_pairfix_guard (
        name TEXT PRIMARY KEY, instance TEXT NOT NULL, armedAt INTEGER NOT NULL, issuedAt INTEGER)`);
      const found=db.prepare('SELECT instance,armedAt,issuedAt FROM n14_pairfix_guard WHERE name=?').get(KEY);
      if(op==='adopt-v2'){
        if(pairProtocol!=='n14-same-origin-json-nonce-v2'||!found)throw Error('PAIRFIX_ADOPT_REQUIRES_EXISTING_GUARD_AND_V2');
        if(found.issuedAt!=null||before.pendingCode){db.exec('COMMIT');return {...before,stage:'existing_code_or_issue_do_not_repeat'};}
        if(found.instance!==runId)db.prepare('UPDATE n14_pairfix_guard SET instance=?,armedAt=? WHERE name=? AND issuedAt IS NULL').run(runId,t,KEY);
        db.exec('COMMIT');return {...before,stage:'ready_single_issue'};
      }
      if(op==='prepare'){
        if(found&&found.instance!==runId)throw Error('PAIRFIX_INSTANCE_CHANGED');
        const revoked=found?false:db.prepare('DELETE FROM pair WHERE shop=?').run(SHOP).changes>0;
        if(!found)db.prepare('INSERT INTO n14_pairfix_guard VALUES(?,?,?,NULL)').run(KEY,runId,t);
        const staged=scan(db,t);db.exec('COMMIT');
        return {...staged,priorCodeRemoved:revoked,stage:found?.issuedAt!=null?'already_issued_no_repeat':'ready_single_issue'};
      }
      if(!found||found.instance!==runId||t-found.armedAt>15*60_000)throw Error('PAIRFIX_NOT_ARMED_FOR_CURRENT_INSTANCE');
      if(found.issuedAt!=null)throw Error('PAIRFIX_ALREADY_ISSUED');
      if(before.pendingCode)throw Error('PAIRFIX_OTHER_PAIRING_PENDING');
      if(db.prepare('SELECT count(*) AS n FROM failures WHERE at>?').get(t-5*60_000).n>=8)throw Error('PAIRFIX_EXISTING_RATE_LIMIT');
      const bytes=generate();
      if(!Buffer.isBuffer(bytes)||bytes.length!==16)throw Error('PAIRFIX_RANDOM_INPUT_INVALID');
      const raw=Array.from(bytes,b=>alphabet[b&31]).join('');bytes.fill(0);
      const expires=t+PAIR_S*1000;
      db.prepare('INSERT INTO pair(digest,shop,expires) VALUES(?,?,?)').run(sha(raw),SHOP,expires);
      db.prepare('UPDATE n14_pairfix_guard SET issuedAt=? WHERE name=? AND issuedAt IS NULL').run(t,KEY);
      db.exec('COMMIT');
      return {stage:'issued_in_memory',code:raw.match(/.{4}/g).join('-'),expiresAtUtc:iso(expires)};
    }catch(e){db.exec('ROLLBACK');throw e;}
  }finally{db.close();}
}

// Sales calls with its already approved private input callback. No CLI can emit the code.
export async function withOnePairingCode(enterPrivately){
  if(typeof enterPrivately!=='function')throw Error('PAIRFIX_PRIVATE_CALLBACK_REQUIRED');
  const issued=operateInstance(await currentInstance(),'issue');
  if(issued.stage!=='issued_in_memory')return {stage:issued.stage,activeOwnerBinding:issued.activeOwnerBinding};
  const expiresAtUtc=issued.expiresAtUtc;
  try{await enterPrivately(issued.code,expiresAtUtc);}
  catch{throw Error('PAIRFIX_PRIVATE_HANDOFF_FAILED_NO_AUTO_REISSUE');}
  finally{delete issued.code;}
  return {stage:'delivered_to_private_callback_once',expiresAtUtc};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const [op='status',...extra]=process.argv.slice(2);
  if(extra.length||!['prepare','status','adopt-v2','diagnostics'].includes(op)){console.error('PAIRFIX_COMMAND_NOT_ALLOWED');process.exitCode=2;}
  else currentInstance().then(i=>console.log(JSON.stringify(operateInstance(i,op)))).catch(e=>{
    console.error(/^(?:PAIRFIX|N14)_[A-Z0-9_]+$/.test(e?.message??'')?e.message:'PAIRFIX_CONTROL_FAILED');process.exitCode=2;});
}
