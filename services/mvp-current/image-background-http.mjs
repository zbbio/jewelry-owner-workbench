import {publicImageJob} from './image-background-agent.mjs';
const prefix='/image-background/';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const media=(id,kind,url=prefix+'media')=>url+'?'+new URLSearchParams({id,kind,version:'1'});
function watch(row){
 const ready=row.status==='preview_ready';
 const original=esc(media(row.jobId,'original'));
 const output=ready?esc(media(row.jobId,'generated')):null;
 const diag=row.providerCode==='ModelNotOpen'?'图片服务未开通此模型。':row.status==='failed'?'没有可查看的新图。':'任务尚未得到可用结果；不会自动重试。';
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<title>商品图换背景 · 对照</title><style>*{box-sizing:border-box}body{font:19px/1.55 system-ui;max-width:1100px;margin:auto;padding:20px;background:#f6f7f2;color:#17352b}a{color:#175641;display:inline-block;padding:10px 0}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}section{background:white;padding:12px;min-width:0}img{display:block;width:100%;max-height:75vh;object-fit:contain}@media(max-width:640px){.pair{grid-template-columns:1fr}}</style>'+
 '<a href="/">← 返回珠宝助手</a><h1>'+esc(row.source.productId)+'</h1><p>'+esc(row.backgroundBrief)+'</p>'+
 '<p>AI 合成／非实拍；珠子、隔片等细节待对照核实。未发布。</p>'+
 (ready&&row.warnings?.includes('SOURCE_ASPECT_RATIO_CHANGED')?'<p role="status">生成图与原图宽高比不同，请复核。</p>':'')+'<main class="pair">'+
 '<section><h2>商品原图</h2><a aria-label="打开原图大图" href="'+original+'"><img alt="商品原图" src="'+original+'"></a></section>'+
 '<section><h2>换背景预览</h2>'+(output?'<a aria-label="打开合成大图" href="'+output+'"><img alt="换背景预览" src="'+output+'"></a>':'<p role="status">'+esc(diag)+'</p>')+'</section></main></html>';
}
function collection(rows,page){
 const ready=rows.filter(row=>row.status==='preview_ready'&&row.work?.version===1);
 const failed=rows.filter(row=>row.status==='failed').length;
 const perPage=12,totalPages=Math.max(1,Math.ceil(ready.length/perPage));
 if(page<1||page>totalPages)return null;
 const cards=ready.slice((page-1)*perPage,page*perPage).map(row=>{
   const id=row.jobId, watchUrl=prefix+'watch?'+new URLSearchParams({id});
   return '<article><h2>'+esc(row.source?.productId)+'</h2><div class="pair">'+
    '<figure><img loading="lazy" src="'+esc(media(id,'original',prefix+'thumbnail'))+'" alt="商品原图"><figcaption>商品原图</figcaption></figure>'+
    '<figure><img loading="lazy" src="'+esc(media(id,'generated',prefix+'thumbnail'))+'" alt="AI 合成预览"><figcaption>AI 合成预览</figcaption></figure>'+
    '</div><a href="'+esc(watchUrl)+'">查看本件原图与换背景对照 →</a></article>';
 }).join('');
 const pageLink=(n,label)=>'<a href="'+prefix+'collection?page='+n+'">'+label+'</a>';
 const nav='<nav aria-label="预览分页">'+(page>1?pageLink(page-1,'上一页')+' · ':'')+
  '第 '+page+' / '+totalPages+' 页'+(page<totalPages?' · '+pageLink(page+1,'下一页'):'')+'</nav>';
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<title>换背景预览汇总</title><style>*{box-sizing:border-box}body{font:18px/1.5 system-ui;max-width:1120px;margin:auto;padding:16px;background:#f6f7f2;color:#17352b}a{color:#175641;display:inline-block;padding:10px 0}main,.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}article{min-width:0;background:white;padding:12px}h2{overflow-wrap:anywhere}figure{margin:0;min-width:0}img{display:block;width:100%;height:clamp(110px,28vw,250px);object-fit:contain;background:#f6f7f2}@media(max-width:640px){main{grid-template-columns:1fr}}</style>'+
  '<a href="/">← 返回珠宝助手</a><h1>换背景预览汇总</h1>'+
  '<p>AI 合成／非实拍，未发布；珠子、隔片等细节待核，请对照原图。</p>'+
  '<p>已有 '+ready.length+' 张预览；失败 '+failed+' 项。</p>'+
  (cards?'<main>'+cards+'</main>'+nav:'<p role="status">暂无换背景预览。</p>')+'</html>';
}
export function handleImageBackgroundHttp(req,res,url,svc,ctx){
 if(!url.pathname.startsWith(prefix))return false;
 const send=(code,body,type='application/json; charset=utf-8')=>{
   const bytes=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
   res.writeHead(code,{'content-type':type,'content-length':bytes.length,'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
   res.end(req.method==='HEAD'?undefined:bytes);return true;
 };
 if(!['GET','HEAD'].includes(req.method))return send(405,{error:'READ_ONLY_ROUTE'});
 if(!svc)return send(404,{error:'IMAGE_WORKFLOW_NOT_ENABLED'});
 try{
   const id=url.searchParams.get('id');
   if(url.pathname===prefix+'jobs')return send(200,id?{imageJob:publicImageJob(svc.status(ctx,id))}:{imageJobs:svc.jobs(ctx).map(publicImageJob)});
   if(url.pathname===prefix+'collection'){
     const rows=svc.jobs(ctx), pages=url.searchParams.getAll('page');
     if(pages.length>1||(pages.length&&!/^[1-9][0-9]{0,2}$/.test(pages[0])))return send(404,{error:'IMAGE_COLLECTION_PAGE_NOT_FOUND'});
     const html=collection(rows,Number(pages[0]??'1'));
     return html===null?send(404,{error:'IMAGE_COLLECTION_PAGE_NOT_FOUND'}):send(200,html,'text/html; charset=utf-8');
   }
   if(url.pathname===prefix+'watch'){
     const row=svc.status(ctx,id);
     // Preview cannot silently display a newer or unmatched source.
     svc.media(ctx,{jobId:id,kind:'original',version:1});
     if(row.status==='preview_ready')svc.media(ctx,{jobId:id,kind:'generated',version:1});
     return send(200,watch(row),'text/html; charset=utf-8');
   }
   if(url.pathname===prefix+'media'||url.pathname===prefix+'thumbnail'){
     const v=url.searchParams.get('version');
     if(v!=='1')return send(404,{error:'IMAGE_MEDIA_NOT_AVAILABLE'});
     const read=url.pathname===prefix+'thumbnail'?svc.thumbnail:svc.media;
     const out=read(ctx,{jobId:id,kind:url.searchParams.get('kind'),version:1});
     return send(200,out.bytes,out.contentType);
   }
   return send(404,{error:'UNKNOWN_IMAGE_ROUTE'});
 }catch(e){
   const code=e?.code, known={IMAGE_SCOPE_DENIED:403,IMAGE_JOB_NOT_FOUND:404,IMAGE_MEDIA_NOT_AVAILABLE:404,
     SOURCE_CHANGED:410,SOURCE_UNAVAILABLE:410,UNKNOWN_PRODUCT:410,PRODUCT_IMAGE_BINDING_INVALID:410,IMAGE_WORK_INTEGRITY_ERROR:410,IMAGE_THUMBNAIL_UNAVAILABLE:503};
   return send(Object.hasOwn(known,code)?known[code]:404,{error:Object.hasOwn(known,code)?code:'IMAGE_RESOURCE_UNAVAILABLE'});
 }
}
