import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSales } from '../sales/index.mjs';

test('库存待办记住首次原问题与当时商品版本，原请求重试/追问不重建，不泄露到另一店',()=>{
 const db=new DatabaseSync(':memory:');try{
  const A={shopId:'A',actorId:'owner'},B={shopId:'B',actorId:'owner'};let v=2;
  const catalog={get:(_ctx,productId)=>({productId,productVersion:v,fields:{price:{value:99,unit:'元',source:'manual'},size:{value:16.5,unit:'cm',source:'manual'}}})};
  const sales=createSales({db,catalog});const q={sessionId:'s',productId:'p',question:'这条多少钱、有货吗？',requestId:'1'};
  const a=sales.ask(A,q);assert.match(a.answer,/99 元/);assert.match(a.answer,/16.5 cm/);assert.match(a.answer,/库存待核实/);
  v=3;assert.deepEqual(sales.ask(A,q),a);assert.deepEqual(sales.ask(A,{...q,requestId:'2',question:'这件还有吗？'}).taskIds,a.taskIds);
  const [t]=sales.listTasks(A);assert.equal(sales.listTasks(A).length,1);assert.equal(t.originalQuestion,q.question);assert.equal(t.originalRequestId,'1');assert.equal(t.originalProductVersion,2);assert.equal(t.taskId,a.taskIds[0]);assert.deepEqual(sales.listTasks(B),[]);
  const redirect=sales.ask(A,{...q,requestId:'3',question:'我问旁边那条'});assert.equal(redirect.status,'clarification_required');assert.equal(redirect.productRef,undefined);assert.deepEqual(redirect.taskIds,[]);
 }finally{db.close()}
});
test('点在 A 卡：「请给我看这条的视频」交给内容仓；明确排除 A 就只澄清，模糊/否定不成制作单',()=>{
 const db=new DatabaseSync(':memory:');try{
  const c={shopId:'S',actorId:'O'},demands=[];const sales=createSales({db,catalog:{get:()=>({productId:'A',productVersion:4,fields:{price:{value:298,source:'manual',unit:'元'}}})},
   content:{requestVideo(ctx,r){demands.push({...r});return {...r,outcome:'needs_source',nextAction:'补本件素材',deliveryStatus:'not_submitted'}}}});
  let i=0;const ask=question=>sales.ask(c,{requestId:String(++i),productId:'A',sessionId:'sess',question});
  for(const s of ['请给我看这条的视频','这条的视频能看吗？','另一条的视频不用了，请给我看这条的视频']){
   const r=ask(s);assert.equal(r.video?.outcome,'needs_source');assert.equal(r.video.productId,'A');assert.equal(r.video.productVersion,4);
  }
  for(const s of ['请给我看旁边那条的视频','能看另外一条的实拍短片吗？','我想看的不是这条','不是这条的视频，是另一条的','请给我看一下另外一件的视频']){
   const r=ask(s);assert.equal(r.status,'clarification_required',s);assert.equal(r.productRef,undefined);assert.equal(r.video,undefined);assert.deepEqual(r.taskIds,[]);assert.doesNotMatch(r.answer,/298|有货|已排队/);
  }
  for(const s of ['这条的视频是什么格式？','那个视频呢？','不用看这条的视频了','另一条的视频不用了，我只问这条多少钱','请给我看这条的视频，算了']){
   const r=ask(s);assert.equal(r.video,undefined,s);assert.equal(r.productRef.productId,'A');
  }
  assert.equal(demands.length,3);const question='请给我看这条的视频';
  const body=JSON.stringify({sessionId:'sess',question,productId:'A',needVideo:false}),old={requestId:'old-v2',sessionId:'sess',status:'answered',productRef:{productId:'A',productVersion:2},answer:'原有答复',taskIds:[],deliveryStatus:'not_submitted'};
  db.prepare('INSERT INTO sales_receipts VALUES(?,?,?,?,?)').run('S','ask','old-v2',body,JSON.stringify({intentFormat:2,result:old}));
  assert.deepEqual(sales.ask(c,{requestId:'old-v2',productId:'A',sessionId:'sess',question}),old);assert.equal(demands.length,3);
 }finally{db.close()}
});
