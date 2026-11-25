import {resolve,join,basename,dirname} from 'node:path';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {createConnection} from 'node:net';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {assertP34Fixture} from './p34-write.mjs';
import {fixturePolicy,createD3EnrolmentTable} from './d3-fixture.mjs';

const [file,messageId]=process.argv.slice(2);
if(!file||!/^[\w.:-]{1,128}$/u.test(messageId??''))throw Error('Use: node d3-provision.mjs <fixture runtime.json> <committed P3 messageId>');
const path=realpathSync(resolve(file)),cfg=JSON.parse(readFileSync(path,'utf8'));
if(cfg.n22D3Fixture!==true||cfg.n22CardPage||cfg.n22PlanGrant||basename(path)!=='runtime.json'||dirname(path)!==assertP34Fixture(cfg))
  throw Error('D3_FIXTURE_ONLY');
const ownCatalog=realpathSync(new URL('../../../../店主工作台/catalog/index.mjs',import.meta.url));
if(cfg.n22CatalogSource!==ownCatalog)throw Error('D3_WRONG_CATALOG_SOURCE');
await new Promise((ok,no)=>{
  const s=createConnection({host:'127.0.0.1',port:17873});
  s.setTimeout(2000,()=>{s.destroy();no(Error('D3_STOP_FIXTURE_FIRST'));});
  s.once('connect',()=>{s.destroy();no(Error('D3_STOP_FIXTURE_FIRST'));});
  s.once('error',e=>e.code==='ECONNREFUSED'?ok():no(e));
});
const hashes=fixturePolicy(cfg);
const catPath=join(cfg.stateDir,'n22-write-catalog.sqlite');
if(!lstatSync(catPath).isFile()||lstatSync(catPath).nlink!==1||realpathSync(catPath)!==catPath)throw Error('D3_DB_SCOPE');
const db=new DatabaseSync(catPath), ledger=new DatabaseSync(join(cfg.stateDir,'n22-messages.sqlite'),{readOnly:true});
const adb=new DatabaseSync(join(cfg.stateDir,'n22-album.sqlite'),{readOnly:true});
try{
  const rows=ledger.prepare('SELECT actor,session,finished_json FROM n22_messages WHERE shop=? AND msg=? AND finished_json IS NOT NULL').all(cfg.storeRef,messageId);
  if(rows.length!==1)throw Error('D3_P3_ORIGIN_NOT_UNIQUE');
  const row=rows[0],ctx={shopId:cfg.storeRef,actorId:row.actor,sessionId:row.session,role:'owner'};
  const ack=JSON.parse(row.finished_json), job=ack.actions?.[0]?.result, r=job?.receipt;
  if(ack.status!=='catalog_write_committed'||job.operation!=='create'||r?.outcome!=='created'||r.productVersion!==1||
     r.productId!==ack.productId||r.linkedAssetIds.length!==2)throw Error('D3_EXPLICIT_P3_NEW_CARD_REQUIRED');
  const g=db.prepare('SELECT batch,assets FROM n22_write_groups WHERE id=? AND actor=? AND session=?').get(r.groupId,ctx.actorId,ctx.sessionId);
  const grantAssets=JSON.parse(g?.assets??'null')??[];
  if(grantAssets.length!==2||new Set(grantAssets.map(a=>a.sha256)).size!==2)throw Error('D3_MATERIAL_GRANT_REQUIRED');
  const f=join(cfg.n22Root,cfg.n22Adapters.album.file.slice(cfg.n22Root.length+1));
  if(f!==cfg.n22Adapters.album.file||!f.endsWith(join('相册仓','backend','http.mjs'))||
    createHash('sha256').update(readFileSync(f)).digest('hex')!==cfg.n22Adapters.album.sha256)throw Error('D3_ALBUM_SOURCE_CHANGED');
  // The factory can initialize tables; these tables already exist in the fixture.
  const {createAlbumRoute}=await import(pathToFileURL(f).href);
  const album=createAlbumRoute({db:adb,dataDir:cfg.stateDir});
  for(const a of grantAssets){
    const x=album.readAuthorizedAsset(ctx,g.batch,a.assetId);
    if(!r.linkedAssetIds.includes(a.assetId)||!hashes.hashes.includes(a.sha256)||x?.mime!=='image/png'||
       createHash('sha256').update(x.bytes).digest('hex')!==a.sha256)throw Error('D3_MATERIAL_GRANT_MISMATCH');
  }
  const {createCatalog}=await import(pathToFileURL(ownCatalog).href);
  const catalog=createCatalog({db,hasAsset:()=>false});
  createD3EnrolmentTable(db);
  const old=db.prepare('SELECT product,actor,session,pver FROM n22_d3_enrolment WHERE k=1').get();
  if(old&&(old.product!==r.productId||old.actor!==ctx.actorId||old.session!==ctx.sessionId))
    throw Error('D3_ONE_CARD_ONLY');
  const result=catalog.saveCopy(ctx,{requestId:'d3-fixture-copy-'+messageId,productId:r.productId,expectedVersion:r.productVersion,text:hashes.copy});
  db.prepare('INSERT OR IGNORE INTO n22_d3_enrolment VALUES(1,?,?,?,?,?)')
    .run(cfg.storeRef,ctx.actorId,ctx.sessionId,r.productId,result.productVersion);
  process.stdout.write(JSON.stringify({result:'fixture_copy_and_approved_materials_linked',shopId:cfg.storeRef,
    productId:r.productId,productVersion:result.productVersion,copyId:result.copyId,copyVersion:result.copyVersion,
    assets:grantAssets})+'\n');
}finally{adb.close();ledger.close();db.close();}
