// Preparation only: real catalog transaction, synthetic products, no endpoint and no live state.
import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCatalog} from '../../../../店主工作台/catalog/index.mjs';

const ctx={shopId:'p34-fixture-shop',actorId:'fixture-owner'};
const group=(id,n,assets,x={})=>({requestId:'req-'+id+'-'+n,taskId:'batch-int',groupId:id,groupVersion:n,
  keptAssetIds:assets,decisionSource:'owner_confirmed',evidenceRef:'evidence-'+id,...x});
const open=p=>{const db=new DatabaseSync(p);db.exec('PRAGMA journal_mode=DELETE');
  return {db,api:createCatalog({db,hasAsset:(c,id)=>c.shopId===ctx.shopId&&['xa','xb','xc','xd'].includes(id)})};};
test('P3 independent prep: exact replay, different request same snapshot no bump, old true change rejects',()=>{
  const {db,api}=open(':memory:');try{
    const a=api.acceptGroup(ctx,group('gA',1,['xa'])),b=api.acceptGroup(ctx,group('gB',1,['xb']));
    assert.equal(a.outcome,'created');assert.equal(b.outcome,'created');assert.notEqual(a.productId,b.productId);
    assert.deepEqual(api.acceptGroup(ctx,group('gA',1,['xa'])),a);
    const add=group('gA',2,['xa','xc'],{targetProductId:a.productId,expectedVersion:1});
    const updated=api.acceptGroup(ctx,add);assert.equal(updated.productVersion,2);
    assert.deepEqual(api.acceptGroup(ctx,add),updated);
    const noop=api.acceptGroup(ctx,{...add,requestId:'other-request'});
    assert.deepEqual([noop.productId,noop.productVersion,noop.outcome],[a.productId,2,'unchanged']);
    assert.throws(()=>api.acceptGroup(ctx,{...add,requestId:'old-write',groupVersion:3,keptAssetIds:['xa','xc','xd']}),{code:'VERSION_CONFLICT'});
    assert.throws(()=>api.acceptGroup(ctx,{...add,requestId:'divergent',keptAssetIds:['xa','xd']}),{code:'GROUP_VERSION_CONFLICT'});
    assert.deepEqual(api.get(ctx,a.productId).assetIds,['xa','xc']);assert.deepEqual(api.get(ctx,b.productId).assetIds,['xb']);
  }finally{db.close();}
});

test('P4 independent prep: manual fields, exactly-once, stale writer, durable reread and closed-copy rollback',()=>{
  const hold=fileURLToPath(new URL('./仅本机只读/p34-test/',import.meta.url));
  mkdirSync(hold,{recursive:true});const dir=mkdtempSync(join(hold,'test-'));
  const live=join(dir,'before-and-after.sqlite'), backup=join(dir,'pre-update.sqlite'), restore=join(dir,'restored.sqlite');
  let old=open(live);const a=old.api.acceptGroup(ctx,group('gA',1,['xa'])),b=old.api.acceptGroup(ctx,group('gB',1,['xb']));
  old.db.close();copyFileSync(live,backup);
  let active=open(live);
  try{
    const u={requestId:'manual-price',productId:a.productId,expectedVersion:1,changes:[
      {field:'price',value:'250.00',unit:'元',source:'manual'}, {field:'size',value:'14',unit:'cm',source:'manual'}]};
    const updated=active.api.update(ctx,u);
    assert.equal(updated.productVersion,2);assert.deepEqual(active.api.update(ctx,u),updated);
    assert.throws(()=>active.api.update(ctx,{...u,requestId:'stale-request'}),{code:'VERSION_CONFLICT'});
    assert.equal(active.api.get(ctx,b.productId).productVersion,1);
    assert.equal(active.api.get({...ctx,shopId:'foreign'},a.productId),null);
  }finally{active.db.close();}
  active=open(live);
  try{const row=active.api.get(ctx,a.productId);assert.equal(row.productVersion,2);
    assert.equal(row.fields.price.value,'250.00');assert.equal(row.fields.size.unit,'cm');
  }finally{active.db.close();}
  copyFileSync(backup,restore);old=open(restore);
  try{assert.equal(old.api.get(ctx,a.productId).productVersion,1);
    assert.equal(old.api.get(ctx,a.productId).fields.price,undefined);
    assert.deepEqual(old.api.get(ctx,b.productId).assetIds,['xb']);
    assert.equal(old.api.get(ctx,b.productId).productVersion,1);
  }finally{old.db.close();}
});
