import {randomBytes,createHmac,scryptSync,timingSafeEqual} from 'node:crypto';
const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const required=process.env.MVP_AUTH_REQUIRED==='1';
const password=process.env.MVP_ACCESS_PASSWORD||'';
if(required && password.length<16) throw new Error('MVP access password must be configured');
const salt=randomBytes(16);
const stored=required?scryptSync(password,salt,32):null;
const signingKey=process.env.MVP_SESSION_SECRET || randomBytes(32).toString('hex');
const sign=text=>createHmac('sha256',signingKey).update(text).digest('hex');
const secure=process.env.MVP_COOKIE_SECURE==='1';
const attempts=new Map();
const cleanNext=value=>value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')?value:'/';
export async function readBody(req,maxBytes=16384){
  const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>maxBytes){const e=new Error('body too large');e.statusCode=413;throw e;}chunks.push(c);}return Buffer.concat(chunks).toString('utf8');
}
export async function allowRequest(req,res){
  if(!required)return true;
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('x-frame-options','DENY');
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok"}');return false;}
  const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('mvp_session='))?.slice(12);
  if(cookie){const [expires,nonce,signature]=cookie.split('.');const expected=sign(expires+'.'+nonce);if(Number(expires)>Date.now() && signature?.length===expected.length && timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return true;}
  if(url.pathname==='/login'){
    const next=cleanNext(url.searchParams.get('next'));
    if(req.method==='GET'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>珠宝助手 · 演示登录</title><style>body{font:22px system-ui;background:#f6f7f2;color:#17352b;max-width:440px;padding:30px;margin:12vh auto}input,button{font:inherit;width:100%;padding:16px;margin:12px 0;box-sizing:border-box;border-radius:12px;border:1px solid #bacdc0}button{background:#175640;color:white}p{font-size:18px}</style><h1>珠宝店主助手</h1><p>内部演示，请输入访问密码</p><form method="post" action="/login?next=${html(encodeURIComponent(next))}"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>进入珠宝助手</button></form>`);return false;
    }
    if(req.method==='POST'){
      const addr=req.socket.remoteAddress;
      const now=Date.now();const recent=(attempts.get(addr)||[]).filter(t=>now-t<60000);attempts.set(addr,recent);
      if(recent.length>=8){res.writeHead(429,{'retry-after':'60'});res.end('请稍后再试');return false;}recent.push(now);
      const value=new URLSearchParams(await readBody(req)).get('password')||'';
      if(!timingSafeEqual(scryptSync(value,salt,32),stored)){res.writeHead(401,{'content-type':'text/plain; charset=utf-8'});res.end('密码不正确，请返回重试。');return false;}
      attempts.delete(addr);
      const token=Date.now()+12*3600000+'.'+randomBytes(20).toString('hex');
      res.writeHead(303,{'location':next,'set-cookie':`mvp_session=${token}.${sign(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure?'; Secure':''}`});res.end();return false;
    }
  }
  if(req.method==='GET'){res.writeHead(303,{'location':'/login?next='+encodeURIComponent(cleanNext(req.url))});res.end();}
  else{res.writeHead(401,{'content-type':'application/json; charset=utf-8'});res.end('{"error":"请先登录演示"}');}
  return false;
}
