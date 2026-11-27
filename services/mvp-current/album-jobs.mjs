import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const ttl=24*60*60*1000;
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const batch=/^[a-f0-9]{32}$/u;
const tool='album_classify_batch', catalogTool='catalog_create_or_read_card';
const idFormat=/^[a-f0-9]{64}$/u;
export const isAlbumJobId=value=>typeof value==='string' && value.length===64 && idFormat.test(value);
// Call only after allowRequest. The existing login is single-owner; isolate its signed sessions.
export function albumJobScope(req,requiresAuth){
  if(!requiresAuth)return 'preview';
  const session=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('mvp_session='))?.slice(12);
  return session?'auth:'+hash(session):null;
}
const project=(id,row)=>({id,status:row.status,
  ...(row.code?{code:row.code}:{}),
  ...(row.status==='completed'?{total:row.total,batchId:row.batch_id}:{})});

export function openAlbumJobs({dir,run,publication,runCatalog,catalogPublication,catalogProjection,activeWrite=()=>null,clock=Date.now}){
  mkdirSync(dir,{mode:0o700,recursive:true});
  // Separate SQLite writer reservation: service overlap must not interrupt a live worker.
  const guard=new DatabaseSync(path.join(dir,'album-jobs.runner.sqlite'));
  try { guard.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch(cause){guard.close();throw new Error('ALBUM_JOBS_ALREADY_OPEN',{cause});}
  let db;
  try{
    db=new DatabaseSync(path.join(dir,'album-jobs.sqlite'));
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA secure_delete=ON;
      PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS album_jobs (
        id_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted','running','completed','failed')),
        created_at INTEGER NOT NULL, finished_at INTEGER, code TEXT, total INTEGER, batch_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS album_jobs_one_active ON album_jobs((1))
        WHERE status IN ('accepted','running');
      CREATE INDEX IF NOT EXISTS album_jobs_retention ON album_jobs(finished_at);
      CREATE TABLE IF NOT EXISTS catalog_jobs (
        id_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted','running','completed','failed')),
        created_at INTEGER NOT NULL, finished_at INTEGER, code TEXT, total INTEGER, batch_id TEXT,
        expected_batch TEXT NOT NULL, expected_total INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_jobs_one_active ON catalog_jobs((1))
        WHERE status IN ('accepted','running');
      CREATE INDEX IF NOT EXISTS catalog_jobs_retention ON catalog_jobs(finished_at);
    `);
  }catch(error){db?.close();guard.close();throw error;}
  const q=sql=>db.prepare(sql);
  const live=q("SELECT 1 AS active FROM album_jobs WHERE status IN ('accepted','running') LIMIT 1");
  const existing=q('SELECT scope,input_hash,status,code,total,batch_id,finished_at FROM album_jobs WHERE id_hash=?');
  const insert=q("INSERT INTO album_jobs(id_hash,scope,input_hash,status,created_at) VALUES(?,?,?,'accepted',?)");
  const running=q("UPDATE album_jobs SET status='running' WHERE id_hash=? AND status='accepted'");
  const terminal=q("UPDATE album_jobs SET status=?,finished_at=?,code=?,total=?,batch_id=? WHERE id_hash=? AND status='running'");
  const old=q('DELETE FROM album_jobs WHERE finished_at IS NOT NULL AND finished_at<=?');
  const trim=q(`DELETE FROM album_jobs WHERE id_hash IN
    (SELECT id_hash FROM album_jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT -1 OFFSET 256)`);
  // Same SQLite reservation/transaction and the same runner guard as album jobs.
  // A companion table keeps old binaries from interpreting catalog rows as album rows.
  const catalogLive=q("SELECT 1 AS active FROM catalog_jobs WHERE status IN ('accepted','running') LIMIT 1");
  const catalogExisting=q('SELECT scope,input_hash,status,code,total,batch_id,finished_at,expected_batch,expected_total FROM catalog_jobs WHERE id_hash=?');
  const catalogInsert=q("INSERT INTO catalog_jobs(id_hash,scope,input_hash,status,created_at,expected_batch,expected_total) VALUES(?,?,?,'accepted',?,?,?)");
  const catalogRunning=q("UPDATE catalog_jobs SET status='running' WHERE id_hash=? AND status='accepted'");
  const catalogTerminal=q("UPDATE catalog_jobs SET status=?,finished_at=?,code=?,total=?,batch_id=? WHERE id_hash=? AND status='running'");
  const catalogOld=q('DELETE FROM catalog_jobs WHERE finished_at IS NOT NULL AND finished_at<=?');
  const catalogTrim=q(`DELETE FROM catalog_jobs WHERE id_hash IN
    (SELECT id_hash FROM catalog_jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT -1 OFFSET 256)`);
  const prune=()=>{const cutoff=clock()-ttl;old.run(cutoff);trim.run();catalogOld.run(cutoff);catalogTrim.run();};
  const catalogEnabled=typeof runCatalog==='function'&&typeof catalogPublication==='function'&&typeof catalogProjection==='function';
  const safeCatalogState=()=>{
    try {
      const p=catalogPublication();
      return p?.classificationMode==='deepseek_vision'&&typeof p.batchId==='string'&&batch.test(p.batchId)&&
        Number.isSafeInteger(p.fileCount)&&p.fileCount>0?{batchId:p.batchId,total:p.fileCount}:null;
    }catch{return null;}
  };
  const same=(x,y)=>!!x&&!!y&&x.batchId===y.batchId&&x.total===y.total;
  const catalogConflict={error:'此任务编号不可用于该请求。',code:'catalog_job_conflict'};
  const notReady={error:'此相册批次尚未就绪，请等本次整理完成后重试。',code:'album_not_ready'};
  const catalogBusy={error:'已有商品卡同步任务在运行，请稍后再试。',code:'catalog_busy'};
  let closed=false;
  q("UPDATE album_jobs SET status='failed', code='interrupted',finished_at=? WHERE status IN ('accepted','running')").run(clock());
  prune();
  const timer=setInterval(()=>{try{prune();}catch{console.error('ALBUM_JOBS_RETENTION_FAILED');}},60*60*1000);
  timer.unref();
  function finish(key,status,{code=null,total=null,batchId=null}={}){
    terminal.run(status,clock(),code,total,batchId,key);
    prune();
  }
  function start(key,text){
    setImmediate(async()=>{
      if(closed)return;
      try{
        if(running.run(key).changes!==1)return;
        const prior=await publication();
        const out=await run(text);
        if(out?.albumJobCode==='needs_clarification')return finish(key,'failed',{code:'needs_clarification'});
        const r=out?.receipt;
        const v=r?.result;
        if(out?.tool!==tool || r?.tool!==tool || r?.status!=='completed' ||
           v?.classificationMode!=='deepseek_vision'||v?.publishStatus!=='published'||
           !Number.isSafeInteger(v.total)||v.total<1||typeof v.batchId!=='string'||!batch.test(v.batchId)||v.batchId===prior?.batchId){
          return finish(key,'failed',{code:'album_failed'});
        }
        const active=await publication();
        if(active?.batchId!==v.batchId||active?.fileCount!==v.total||active?.classificationMode!=='deepseek_vision')
          return finish(key,'failed',{code:'album_failed'});
        finish(key,'completed',{total:v.total,batchId:v.batchId});
      }catch{
        try{finish(key,'failed',{code:'album_failed'});}catch{console.error('ALBUM_JOB_STATE_WRITE_FAILED');}
      }
    });
  }
  function submit(suppliedId,scope,text){
    const id=isAlbumJobId(suppliedId)?suppliedId:randomBytes(32).toString('hex');
    const key=hash(id), input=hash(text);
    db.exec('BEGIN IMMEDIATE');
    try{
      prune();
      const row=existing.get(key);
      const result=row
        ? row.scope===scope&&row.input_hash===input
          ? {job:project(id,row)}:{error:'此任务编号不可用于该请求。',code:'album_job_conflict'}
        : catalogExisting.get(key)?{error:'此任务编号不可用于该请求。',code:'album_job_conflict'}
        : (live.get()||catalogLive.get()||activeWrite())?{error:'已有相册或商品卡任务正在运行，请稍后再试。',code:'album_busy'}
        : (insert.run(key,scope,input,clock()),{job:{id,status:'accepted'},start:()=>start(key,text)});
      db.exec('COMMIT');
      return result;
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function startCatalog(key,pin,text){
    setImmediate(async()=>{
      if(closed)return;
      try{
        if(catalogRunning.run(key).changes!==1)return;
        if(activeWrite()==='album'||!same(safeCatalogState(),pin))return finishCatalog(key,'failed','album_not_ready');
        if(activeWrite())return finishCatalog(key,'failed','catalog_busy');
        const out=await runCatalog(pin,text);
        if(closed)return;
        const r=out?.receipt, v=r?.result;
        if(v?.status==='requires_album')return finishCatalog(key,'failed','album_not_ready');
        if(out?.tool!==catalogTool||r?.tool!==catalogTool||r?.status!=='completed'||v?.classificationSource!=='album_snapshot'||
           v?.visionCalls!==0||!same(v,pin)||!same(catalogProjection(pin),pin))return finishCatalog(key,'failed','catalog_failed');
        finishCatalog(key,'completed',null,pin);
      }catch(e){
        if(closed)return;
        try{finishCatalog(key,'failed',e?.code==='album_not_ready'?'album_not_ready':e?.statusCode===409?'catalog_busy':'catalog_failed');}
        catch{console.error('CATALOG_JOB_STATE_WRITE_FAILED');}
      }
    });
  }
  function finishCatalog(key,status,code,pin){
    catalogTerminal.run(status,clock(),code,pin?.total??null,pin?.batchId??null,key);
    prune();
  }
  function submitCatalog(suppliedId,scope,text,sourceAlbumJobId){
    if(suppliedId!==undefined&&!isAlbumJobId(suppliedId))
      return {error:'商品卡任务编号格式不正确。',code:'invalid_catalog_job_id',httpStatus:400};
    const id=suppliedId??randomBytes(32).toString('hex');
    const key=hash(id);
    const input=hash(JSON.stringify([text,sourceAlbumJobId===undefined?null:[sourceAlbumJobId]]));
    db.exec('BEGIN IMMEDIATE');
    try{
      prune();
      const row=catalogExisting.get(key);
      let result;
      if(row)result=row.scope===scope&&row.input_hash===input?{job:project(id,row)}:catalogConflict;
      else if(existing.get(key))result=catalogConflict;
      else if(live.get()||activeWrite()==='album')result=notReady;
      else if(catalogLive.get()||activeWrite())result=catalogBusy;
      else{
        const pin=catalogEnabled?safeCatalogState():null;
        const specified=sourceAlbumJobId!==undefined;
        const source=specified&&isAlbumJobId(sourceAlbumJobId)?existing.get(hash(sourceAlbumJobId)):null;
        if(!pin||specified&&(!source||source.scope!==scope||source.status!=='completed'||
          source.batch_id!==pin.batchId||source.total!==pin.total))result=notReady;
        else{
          const {batchId,total}=pin;
          catalogInsert.run(key,scope,input,clock(),batchId,total);
          result={job:{id,status:'accepted'},start:()=>startCatalog(key,pin,text)};
        }
      }
      db.exec('COMMIT');
      return result;
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function getFrom(qry,id,scope){
    if(!isAlbumJobId(id)||!scope)return null;
    const row=qry.get(hash(id));
    return row&&row.scope===scope&&(row.finished_at===null||row.finished_at>clock()-ttl)?project(id,row):null;
  }
  const getCatalog=(id,scope)=>getFrom(catalogExisting,id,scope);
  function get(id,scope){
    return getFrom(existing,id,scope);
  }
  // Only catalog work is safe to recover without the original text: the accepted row pins the exact batch.
  // If a crash followed publication, the existing projection is validated and the worker does not rewrite it.
  if(catalogEnabled){
    q("UPDATE catalog_jobs SET status='accepted' WHERE status='running'").run();
    for(const row of q("SELECT id_hash,expected_batch,expected_total FROM catalog_jobs WHERE status='accepted'").all())
      startCatalog(row.id_hash,{batchId:row.expected_batch,total:row.expected_total});
  }
  function close(){
    if(closed)return;
    closed=true;clearInterval(timer);process.removeListener('exit',close);
    try{db.close();}finally{guard.close();}
  }
  process.once('exit',close);
  return {submit,get,submitCatalog,getCatalog,close};
}
