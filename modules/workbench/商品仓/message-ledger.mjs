import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const token=x=>typeof x==='string'&&/^[\w.:-]{1,128}$/u.test(x);
const err=(code,httpStatus)=>Object.assign(Error(code),{code,httpStatus});
const fingerprint=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function createMessageLedger(path){
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS n22_messages(
    shop TEXT NOT NULL, actor TEXT NOT NULL, session TEXT NOT NULL, msg TEXT NOT NULL,
    request TEXT NOT NULL, fp TEXT NOT NULL, product TEXT, version INTEGER, may_clip INTEGER NOT NULL DEFAULT 0,
    work TEXT, work_version INTEGER, finished_json TEXT,
    PRIMARY KEY(shop,actor,session,msg), UNIQUE(shop,actor,session,request));`);
  const who=c=>[c.shopId,c.actorId,c.sessionId];
  const get=db.prepare('SELECT * FROM n22_messages WHERE shop=? AND actor=? AND session=? AND msg=?');
  const req=db.prepare('SELECT * FROM n22_messages WHERE shop=? AND actor=? AND session=? AND request=?');
  const add=db.prepare('INSERT INTO n22_messages(shop,actor,session,msg,request,fp) VALUES (?,?,?,?,?,?)');
  const bind=db.prepare('UPDATE n22_messages SET product=?,version=?,may_clip=? WHERE shop=? AND actor=? AND session=? AND msg=? AND product IS NULL');
  const pin=db.prepare('UPDATE n22_messages SET work=?,work_version=? WHERE shop=? AND actor=? AND session=? AND msg=? AND work IS NULL');
  const save=db.prepare('UPDATE n22_messages SET finished_json=? WHERE shop=? AND actor=? AND session=? AND msg=?');
  const running=new Map();
  function read(c,messageId){return token(messageId)?get.get(...who(c),messageId)??null:null;}
  function authorize(c,{messageId,signal}){signal?.throwIfAborted();
    const r=read(c,messageId);if(!r?.product||r.may_clip!==1)return null;
    return {shopId:c.shopId,productId:r.product,productVersion:r.version,allowOldVideo:true,
      ...(r.work?{pinnedWorkRef:{workId:r.work,workVersion:r.work_version}}:{})};}
  function reference(c,messageId){const r=read(c,messageId);return r?.product?{shopId:c.shopId,productId:r.product,productVersion:r.version}:null;}
  function setProduct(c,mid,p,mayClip){
    bind.run(p.productId,p.productVersion,mayClip?1:0,...who(c),mid);
    const old=read(c,mid);
    if(!old||old.product!==p.productId||old.version!==p.productVersion||old.may_clip!==Number(mayClip))throw err('MESSAGE_SCOPE_CONFLICT',409);
  }
  function setWork(c,mid,w){
    pin.run(w.workId,w.workVersion,...who(c),mid);
    const old=read(c,mid);
    if(!old||old.work!==w.workId||old.work_version!==w.workVersion)throw err('MESSAGE_WORK_CONFLICT',409);
  }
  async function execute(c,x,fn){
    if(!x||typeof x!=='object'||Object.keys(x).some(k=>!['requestId','messageId','text','replyToMessageId','batchId'].includes(k))||
       !token(x.requestId)||!token(x.messageId)||typeof x.text!=='string'||!x.text.trim()||x.text.length>500||
       x.replyToMessageId!=null&&!token(x.replyToMessageId)||x.batchId!=null&&!token(x.batchId))throw err('INVALID_REQUEST',400);
    const key=JSON.stringify([...who(c),x.messageId]), fp=fingerprint([x.text.trim(),x.replyToMessageId??null,x.batchId??null]);
    const old=read(c,x.messageId)??req.get(...who(c),x.requestId);
    if(old){
      if(old.fp!==fp||old.request!==x.requestId||old.msg!==x.messageId)throw err('MESSAGE_REUSE_CONFLICT',409);
      if(running.has(key))return {...await running.get(key),replay:true};
      if(old.finished_json)return {...JSON.parse(old.finished_json),replay:true};
      throw err('INTERRUPTED_TURN_NO_AUTOMATIC_REPLAY',409);
    }
    add.run(...who(c),x.messageId,x.requestId,fp);
    const result=Promise.resolve().then(fn).then(y=>{save.run(JSON.stringify(y),...who(c),x.messageId);return y;});
    running.set(key,result);
    try{return await result;}finally{running.delete(key);}
  }
  const restore=(c,mid)=>{const row=read(c,mid);return row?.finished_json?JSON.parse(row.finished_json):null;};
  // Only finished cancellation receipts issued in this exact scope apply.
  const canceled=db.prepare(`SELECT 1 FROM n22_messages
    WHERE shop=? AND actor=? AND session=? AND finished_json IS NOT NULL
    AND json_extract(finished_json,'$.status')='draft_source_canceled'
    AND json_extract(finished_json,'$.draftSourceCancellation.originMessageId')=? LIMIT 1`);
  const isDraftSourceCanceled=(c,mid)=>token(mid)&&!!canceled.get(...who(c),mid);
  return {authorize,reference,restore,execute,setProduct,setWork,isDraftSourceCanceled,close:()=>db.close()};
}
