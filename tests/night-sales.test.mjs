import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCatalog} from '../catalog/index.mjs';
import {createContent} from '../content/index.mjs';
import {createSales} from '../sales/index.mjs';
const Q='这件多少钱，尺寸多少？有货吗？能看本件视频吗？';
const shop={shopId:'test-owner-shop',actorId:'owner'},elsewhere={shopId:'other-owner-shop',actorId:'owner'};
const req=(id,p,extras={})=>({requestId:id,productId:p,sessionId:'s',question:Q,...extras});
const field=(field,value,unit=null,source='manual')=>({field,value,unit,source});
const unknown=/价格.{0,12}(待核实|未核实|尚未核实|未确认|未记录)/;
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'n1-sales-')), file=path.join(dir,'state.sqlite'),f={fault:null};
  function open(){
    f.db=new DatabaseSync(file);
    f.catalog=createCatalog({db:f.db,hasAsset:(s,a)=>a.startsWith(s.shopId+'/')});
    const content=createContent({db:f.db,getProduct:f.catalog.get,listOldVideos:()=>[],probeVideo:()=>false,
      resolveInputs:(_c,p)=>({assets:[{kind:'product_shot',rights:'usable',assetId:p.assetIds[0],productId:p.productId,digest:'synthetic-digest'}],
        copyId:'synthetic-copy',copyVersion:1,preferenceVersion:1,preferenceSnapshot:{tone:'plain'}})});
    f.sales=createSales({db:f.db,catalog:f.catalog,content:{requestVideo(s,x){
      if(f.fault==='before')throw Error('fixture-before-content-commit');
      const r=content.requestVideo(s,x);
      if(f.fault==='after')throw Error('fixture-after-content-commit');
      return r;
    }}});
  }
  open(); f.reopen=()=>{f.db.close();open();};
  t.after(()=>{f.db.close();for(const entry of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,entry));fs.rmdirSync(dir);});
  f.card=(s,tag,changes=[])=>{
    const p=f.catalog.acceptGroup(s,{requestId:'create-'+tag,taskId:'t',groupId:tag,groupVersion:1,keptAssetIds:[s.shopId+'/'+tag],
      decisionSource:'owner_confirmed',evidenceRef:'qa'}).productId;
    if(changes.length)f.catalog.update(s,{requestId:'facts-'+tag,productId:p,expectedVersion:1,changes});return p;
  };
  f.count=(tab,s)=>f.db.prepare('SELECT COUNT(*) AS n FROM '+tab+' WHERE shop_id=?').get(s.shopId).n;
  return f;
}
test('真实复合问法：原卡没有可靠价格；新品价和尺寸不改旧答或其他卡；口语请求交内容',t=>{
  const f=setup(t), a=f.card(shop,'A',[field('size',8,'mm')]),b=f.card(shop,'B',[field('size',17,'mm'),field('price',260,'元')]);
  const before=f.sales.ask(shop,req('a1',a)), other=f.sales.ask(shop,req('b1',b));
  assert.match(before.answer,unknown);assert.match(before.answer,/8\s*mm/);assert.match(before.answer,/库存待核实/);
  assert.equal(before.video?.outcome,'queued');assert.equal(before.video?.deliveryStatus,'not_submitted');assert.match(other.answer,/260\s*元/);
  f.catalog.update(shop,{requestId:'edit',productId:a,expectedVersion:2,changes:[field('size',10,'mm'),field('price',699,'元')]});
  f.reopen();
  const now=f.sales.ask(shop,req('a2',a));assert.match(now.answer,/699\s*元/);assert.match(now.answer,/10\s*mm/);
  assert.equal(now.productRef.productVersion,3);assert.equal(now.video.productVersion,3);assert.equal(now.taskIds[0],before.taskIds[0]);
  assert.deepEqual(f.sales.ask(shop,req('a1',a)),before);
  const bAgain=f.sales.ask(shop,req('b2',b));assert.equal(bAgain.answer,other.answer);assert.deepEqual(bAgain.productRef,other.productRef);
  assert.equal(f.count('sales_tasks',shop),2);
});
test('问价不采信宣传/AI/无币种或模糊报价；缺人工尺寸时说明',t=>{
  const f=setup(t);
  for(const [label,params] of [['promo',[field('description','特价 599 元，最低可谈'),field('title','优惠价799元')]],
    ['ai',[field('price',888,'元','ai_suggestion')]],['unitless',[field('price',222)]],
    ['conflict',[field('price',111,'元'),field('salePrice',999,'元')]],['cost',[field('costPrice',966,'元')]]]){
    const p=f.card(shop,label,params),a=f.sales.ask(shop,req(label,p,{needVideo:false})).answer;
    assert.match(a,unknown);assert.match(a,/尺寸.{0,12}(待|未)/);assert.doesNotMatch(a,/599|799|888|222|111|999|966/);
  }
});
test('显式关闭与否定、渠道问法不触发；两店同号同问各自建一个待办和内容任务',t=>{
  const f=setup(t), a=f.card(shop,'A'), b=f.card(elsewhere,'B');
  for(const [i,extras] of [{needVideo:false},{question:'不用看视频了，只问尺寸。'},{question:'这个视频是什么格式？'},{question:'能看另外一件的视频吗？'}].entries())
    assert.equal(f.sales.ask(shop,req('no'+i,a,extras)).video,undefined);
  assert.equal(f.count('content_tasks',shop),0);
  const x=f.sales.ask(shop,req('shared',a)), y=f.sales.ask(elsewhere,req('shared',b));
  assert.equal(x.video?.outcome,'queued');assert.equal(y.video?.outcome,'queued');assert.notEqual(x.video.taskId,y.video.taskId);
  assert.equal(f.count('sales_tasks',shop),1);assert.equal(f.count('sales_tasks',elsewhere),1);
  assert.equal(f.count('content_tasks',shop),1);assert.equal(f.count('content_tasks',elsewhere),1);
  assert.throws(()=>f.sales.ask(elsewhere,req('shared',a)),e=>e.code==='PRODUCT_NOT_FOUND');
});
for(const fault of ['before','after'])test('自然问法内容异常 '+fault+'；原请求重启恢复，无虚假送达或多份任务',t=>{
  const f=setup(t), a=f.card(shop,'A'), r=req('r',a);f.fault=fault;
  assert.throws(()=>f.sales.ask(shop,r),new RegExp('fixture-'+fault+'-content-commit'));
  assert.equal(f.count('sales_tasks',shop),1);assert.equal(f.count('sales_receipts',shop),1);assert.equal(f.count('content_tasks',shop),fault==='before'?0:1);
  f.reopen(); f.fault=null;const result=f.sales.ask(shop,r);
  assert.equal(result.video?.outcome,'queued'); assert.equal(result.deliveryStatus,'not_submitted');assert.equal(result.video.deliveryStatus,'not_submitted');
  assert.deepEqual(f.sales.ask(shop,r),result);assert.equal(f.count('content_tasks',shop),1);assert.equal(f.count('sales_tasks',shop),1);
});
test('已有旧格式自然句回执不事后触发视频',t=>{
  const f=setup(t),p=f.card(shop,'legacy'),r=req('old',p);
  const old={requestId:r.requestId,sessionId:'s',status:'answered',answer:'原系统答复',productRef:{productId:p,productVersion:1},taskIds:[],deliveryStatus:'not_submitted'};
  f.db.prepare('INSERT INTO sales_receipts VALUES(?,?,?,?,?)').run(shop.shopId,'ask','old',JSON.stringify({sessionId:'s',question:Q,productId:p,needVideo:false}),JSON.stringify({result:old}));
  assert.deepEqual(f.sales.ask(shop,r),old);assert.equal(f.count('content_tasks',shop),0);
});
