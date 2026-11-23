// Installation/standalone shell only. No CacheStorage/IndexedDB, fetch telemetry,
// notification, sync or background write. All APIs, photos, clips and login traffic
// bypass the worker; only same-origin top-level navigation can receive this literal.
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
const offline='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作台未连接</title><main><h1>工作台暂未连接</h1><p>请检查测试店服务和连接，再重新打开。这里不保存或显示离线店铺资料，也不会代你提交操作。</p><a href="/">重新连接工作台</a></main></html>';
self.addEventListener('fetch',event=>{
 const r=event.request,u=new URL(r.url);
 if(r.method!=='GET'||r.mode!=='navigate'||u.origin!==self.location.origin||!['/','/index.html','/pilot'].includes(u.pathname))return;
 event.respondWith(fetch(r,{cache:'no-store'}).catch(()=>new Response(offline,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}})));
});
