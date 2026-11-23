import {createSales} from './sales/index.mjs';
import {createStudio} from './content/studio.mjs';
import {reviewView} from './album-review.mjs';
const enc=encodeURIComponent;
const problem=(code,message,status=400)=>Object.assign(Error(message),{code,httpStatus:status});
const notFound=()=>problem('NOT_FOUND','没有找到本店的记录。',404);
const known=(b,keys)=>{if(Object.keys(b).some(k=>!keys.includes(k)))throw problem('INVALID_INPUT','请使用当前页面支持的字段。');};
const id=s=>{try{const v=decodeURIComponent(s);if(v.length>180||!v.length||v.includes('/'))throw Error();return v;}catch{throw problem('INVALID_ID','编号错误。');}};
const version=v=>{if(!Number.isSafeInteger(v)||v<1)throw problem('INVALID_VERSION','缺少有效版本，请刷新。');return v;};
const required=(x)=>{if(!x)throw notFound();return x;};
function mediaBytes(req,res,bytes){
 const b=Buffer.from(bytes),n=b.length,h={'Content-Type':'video/mp4','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
 const r=req.headers.range;if(!r){res.writeHead(200,{...h,'Content-Length':n});res.end(req.method==='HEAD'?undefined:b);return;}
 const m=/^bytes=(\d*)-(\d*)$/.exec(r);let lo=0,hi=n-1;
 if(!m||(!m[1]&&!m[2]))lo=-1;
 else if(!m[1]){const k=Number(m[2]);lo=k>0?Math.max(0,n-k):-1;}
 else {lo=Number(m[1]);if(m[2])hi=Math.min(hi,Number(m[2]));}
 if(!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi)||lo<0||lo>=n||hi<lo){res.writeHead(416,{...h,'Content-Range':'bytes */'+n});res.end();return;}
 res.writeHead(206,{...h,'Content-Range':'bytes '+lo+'-'+hi+'/'+n,'Content-Length':hi-lo+1});
 res.end(req.method==='HEAD'?undefined:b.subarray(lo,hi+1));
}
// Album-only imports and outbox retries must remain side-effect free with respect to the media workspace.
export function createDesk(config){
 let active;
 return {route(args){
  const {pathname:p,req}=args;
  if(!(p==='/api/desk/tasks'||p==='/api/sales/ask'||p.startsWith('/api/video/tasks/')||
       (req.method==='PATCH'&&/^\/api\/cards\/[^/]+$/.test(p))||/^\/api\/cards\/[^/]+\/(?:copy|video|works)(?:$|\/)/.test(p)))return false;
  active??=openDesk(config);return active.route(args);
 }};
}
function openDesk({db,album,catalog,mediaRoot}){
 const studio=createStudio({db,album,catalog,mediaRoot});
 const sales=createSales({db,catalog,content:studio,canRetrieveWork:(scope,{productId,workRef})=>{
  try{return Boolean(studio.openOldVideo(scope,{productId,...workRef})?.bytes?.length);}catch{return false;}}});
 function view(ctx,p,w,current){
  const {productVersion,workId,workVersion,status}=w;const base='/api/cards/'+enc(p)+'/works/'+enc(workId)+'/'+workVersion+'/';
  return {productId:p,productVersion,workId,workVersion,status,...(productVersion===current&&['approved','awaiting_approval'].includes(status)?{previewUrl:base+'preview'}:{}),
    ...(productVersion===current&&status==='approved'?{playUrl:base+'play'}:{})};
 }
 async function route({req,res,pathname:s,ctx,jsonBody,respond}){
  const method=req.method,ok=x=>{respond(res,200,x);return true;};let m;
  if(s==='/api/desk/tasks'&&method==='GET')return ok({album:(await album.listTasks(ctx)).map(reviewView),inventory:sales.listTasks(ctx),video:studio.listTasks(ctx)});
  if(s==='/api/sales/ask'&&method==='POST'){
   const b=await jsonBody(req);known(b,['requestId','sessionId','productId','question']);if(typeof b.question!=='string'||b.question.length>2000)throw problem('INVALID_INPUT','问题过长或为空。');
   return ok(sales.ask(ctx,b));
  }
  if((m=/^\/api\/cards\/([^/]+)$/.exec(s))&&method==='PATCH'){
   const p=id(m[1]),b=await jsonBody(req);known(b,['requestId','expectedVersion','changes']);
   if(!Array.isArray(b.changes)||!b.changes.length||b.changes.length>8||!b.changes.every(c=>c&&['price','size'].includes(c.field)&&c.source==='manual'))throw problem('INVALID_INPUT','只接受店主明确输入的价格或尺寸。');
   for(const c of b.changes){known(c,['field','value','source','unit']);if(c.field==='price'&&(typeof c.value!=='number'||!Number.isFinite(c.value)||c.value<0))throw problem('INVALID_INPUT','售价应为非负数。');if(c.field==='size'&&!(typeof c.value==='number'&&Number.isFinite(c.value)&&c.value>0)&&!(typeof c.value==='string'&&c.value.trim().length>0&&c.value.length<=64))throw problem('INVALID_INPUT','尺寸无效。');}
   return ok(catalog.update(ctx,{requestId:b.requestId,productId:p,expectedVersion:version(b.expectedVersion),changes:b.changes}));
  }
  if((m=/^\/api\/cards\/([^/]+)\/copy$/.exec(s))&&method==='POST'){
   const b=await jsonBody(req);known(b,['requestId','expectedVersion','text']);return ok(catalog.saveCopy(ctx,{requestId:b.requestId,productId:id(m[1]),expectedVersion:version(b.expectedVersion),text:b.text}));
  }
  if((m=/^\/api\/cards\/([^/]+)\/video\/setup$/.exec(s))&&method==='POST'){
   const b=await jsonBody(req);known(b,['requestId','expectedVersion','assetIds','rightsConfirmed','style']);
   if(!['plain','portrait_card'].includes(b.style)||b.rightsConfirmed!==true)throw problem('RIGHTS_REQUIRED','请先确认本件素材可用于本次视频。');
   return ok(studio.saveChoice(ctx,{requestId:b.requestId,productId:id(m[1]),productVersion:version(b.expectedVersion),assetIds:b.assetIds,grantOriginalUse:true,template:'portrait_card'}));
  }
  if((m=/^\/api\/cards\/([^/]+)\/video$/.exec(s))){
   const p=id(m[1]);if(method==='GET'){const card=required(catalog.get(ctx,p)),choice=studio.getChoice(ctx,p);
    return ok({productId:p,productVersion:card.productVersion,assetCount:card.assetIds.length,choice,choiceId:choice?.choiceId||null,
       works:studio.listWorks(ctx,p).map(w=>view(ctx,p,w,card.productVersion)),tasks:studio.listTasks(ctx).filter(t=>t.productId===p)});}
   if(method==='POST'){const b=await jsonBody(req);known(b,['requestId','expectedVersion','choiceId']);return ok(studio.requestVideo(ctx,{requestId:b.requestId,productId:p,productVersion:version(b.expectedVersion),demand:'查看本件视频',...(b.choiceId?{choiceId:b.choiceId}:{})}));}
  }
  if((m=/^\/api\/video\/tasks\/([^/]+)(?:\/(render|confirm))?$/.exec(s))){
   const taskId=id(m[1]);const task=required(studio.getTask(ctx,taskId));
   if(!m[2]&&method==='GET')return ok(task);
   if(m[2]&&method==='POST'){
    const b=await jsonBody(req);if(m[2]==='render'){known(b,['requestId']);return ok(studio.render(ctx,{requestId:b.requestId,taskId}));}
    known(b,['requestId','workVersion']);const w=required(task.workRef);if(w.workVersion!==version(b.workVersion))throw problem('VERSION_CONFLICT','待确认的作品版本已变化。',409);
    return ok(studio.approve(ctx,{requestId:b.requestId,productId:task.productId,workId:w.workId,workVersion:w.workVersion}));}
  }
  if((m=/^\/api\/cards\/([^/]+)\/works\/([^/]+)\/(\d+)\/(preview|play)$/.exec(s))&&['HEAD','GET'].includes(method)){
   const q={productId:id(m[1]),workId:id(m[2]),workVersion:version(Number(m[3]))};
   const stream=required(m[4]==='play'?studio.openOldVideo(ctx,q):studio.openPreview(ctx,q));if(!stream.bytes?.length)throw notFound();
   mediaBytes(req,res,stream.bytes);return true;
  }
  return false;
 }
 return {route};
}
