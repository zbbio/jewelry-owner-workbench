import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('public MVP keeps original synthetic photo in its message history without making media', {timeout:20000}, async()=>{
 const data=process.env.MVP_DATA_DIR;
 assert.ok(data && process.env.MVP_FIXTURE==='1','start with create-demo-data.py in an isolated directory');
 const env={...process.env,MVP_AUTH_REQUIRED:'0',MVP_FIXTURE:'1',MVP_IMAGE_GENERATE:'0',MVP_MESSAGE_IMAGE_GENERATE:'0',MVP_VIDEO_GENERATE:'0',MVP_REFERENCE_VIDEO_GENERATE:'0'};
 for(const name of Object.keys(env)) if(/^(DEEPSEEK_|ARK_|OPENAI_)/.test(name)) delete env[name];
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
 env.PORT=String(socket.address().port);await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env,stdio:['ignore','pipe','inherit']});
 try{
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([c])=>{throw Error('server exit '+c)})]);
  const base='http://127.0.0.1:'+env.PORT, assets='/api/message-photos/assets', history='/api/message-photos/messages';
  assert.match(await (await fetch(base)).text(),/message-photo-ui\.mjs/);
  assert.equal((await fetch(base+'/message-photo-ui.mjs')).status,200);
  const init=await fetch(base+history);assert.equal(init.status,200);
  const cookie=init.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  const original=await readFile(path.join(data,'source','DEMO103.jpg'));
  const upload=await fetch(base+assets,{method:'POST',headers:{Cookie:cookie,Origin:base,'content-type':'image/jpeg','x-message-photo-key':randomUUID()},body:original});
  assert.equal(upload.status,201);const {asset}=await upload.json();
  const text='保存这张示意图片到本条对话';
  const sent=await fetch(base+'/api/chat',{method:'POST',headers:{Cookie:cookie,Origin:base,'content-type':'application/json'},body:JSON.stringify({text,attachments:[asset.id],requestId:randomUUID()})});
  assert.equal(sent.status,200);
  const ack=await sent.json(); assert.equal(ack.received,true);
  assert.equal(ack.message.generationSubmitted,false);
  const get=route=>fetch(base+route,{headers:{Cookie:cookie}});
  const after=await (await get(history)).json();
  const restored=after.messages.find(x=>x.messageId===ack.messageId);
  assert.equal(restored.text,text);assert.equal(restored.attachments[0].id,asset.id);
  const image=await get(assets+'/'+asset.id);assert.equal(image.status,200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),original);
  assert.equal((await get(assets+'/'+asset.id+'/thumbnail')).status,200);
 }finally{
  if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
 }
});
