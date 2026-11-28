import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const password=randomBytes(24).toString('hex');
const base='http://127.0.0.1:34199';
const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,MVP_AUTH_REQUIRED:'1',MVP_ACCESS_PASSWORD:password,MVP_COOKIE_SECURE:'1',MVP_FIXTURE:'1',PORT:'34199'},stdio:'ignore'});
try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  for(const path of ['/','/catalog','/gallery','/catalog/image?id=DEMO103']){
    const r=await fetch(base+path,{redirect:'manual'});assert.equal(r.status,303);assert.ok(r.headers.get('location').startsWith('/login'));
  }
  assert.equal((await fetch(base+'/api/chat',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+'/login',{method:'POST',body:new URLSearchParams({password:'wrong'})})).status,401);
  const login=await fetch(base+'/login?next=%2Fcatalog',{method:'POST',body:new URLSearchParams({password}),redirect:'manual'});
  assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/catalog');
  const setCookie=login.headers.get('set-cookie');assert.ok(setCookie.includes('HttpOnly'));assert.ok(setCookie.includes('Secure'));assert.ok(setCookie.includes('SameSite=Lax'));
  const headers={Cookie:setCookie.split(';')[0]};
  assert.equal((await fetch(base+'/catalog',{headers})).status,200);
  assert.equal((await fetch(base+'/gallery',{headers})).status,200);
  const chat=await fetch(base+'/api/chat',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({text:'客人问证书，先别发'})}).then(r=>r.json());assert.equal(chat.receipt.status,'completed');
  assert.equal((await fetch(base+'/api/chat',{method:'POST',headers,body:'x'.repeat(17000)})).status,413);
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');new vm.Script(html.split('<script>')[1].split('</script>')[0]);
  assert.ok(html.includes('document.createTextNode(text)'));assert.ok(!html.includes('log.innerHTML'));
  console.log('PASS access: protected pages/images/API, login, Secure HttpOnly cookie, authenticated reads/fixture chat, payload cap, safe UI syntax (no paid model)');
}finally{child.kill();}
