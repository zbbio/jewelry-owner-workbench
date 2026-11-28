import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {demoBase} from './paths.mjs';
const host = 'http://127.0.0.1:34197';
const child = spawn(process.execPath, ['server.mjs'], {cwd:new URL('.',import.meta.url), env:{...process.env,PORT:'34197',MVP_FIXTURE:'1'},stdio:'ignore'});
try {
  let ready=false;
  for(let i=0;i<80;i++) {try{if((await fetch(host)).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'isolated server ready');
  const response=await fetch(host+'/gallery'); assert.equal(response.status,200);
  const html=await response.text(); assert.ok(html.includes('class="category-card"'),'category overview cards');
  const manifest=JSON.parse(await readFile(path.join(demoBase,'分类结果.json'),'utf8'));
  let count=0;
  for(const group of new Set(manifest.items.map(i=>i.group))) {
    const page=await fetch(host+'/gallery?group='+encodeURIComponent(group)); assert.equal(page.status,200);
    const body=await page.text(); assert.ok(body.includes(group));
    const items=manifest.items.filter(i=>i.group===group); count+=items.length;
    assert.equal((body.match(/class="tile"/g)||[]).length,items.length);
  }
  const first=manifest.items[0]; const image=await fetch(host+'/gallery/image?group='+encodeURIComponent(first.group)+'&file='+encodeURIComponent(first.file));
  assert.equal(image.status,200); assert.ok(image.headers.get('content-type').startsWith('image/')); assert.ok((await image.arrayBuffer()).byteLength>1000);
  for(let start=0; start<manifest.items.length; start+=8) {
    await Promise.all(manifest.items.slice(start,start+8).map(async item=>{
      const res=await fetch(host+'/gallery/image?group='+encodeURIComponent(item.group)+'&file='+encodeURIComponent(item.file));
      assert.equal(res.status,200,item.file); assert.ok(res.headers.get('content-type').startsWith('image/'));
      assert.ok((await res.arrayBuffer()).byteLength>0,item.file);
    }));
  }
  const blocked=await fetch(host+'/gallery/image?group='+encodeURIComponent('..')+'&file='+encodeURIComponent('分类结果.json')); assert.ok([400,404].includes(blocked.status));
  const reply=await fetch(host+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'相册整理'})}).then(r=>r.json());
  assert.ok(reply.reply.includes('href="/gallery"'));
  console.log(`PASS gallery overview, ${count} image links, group pages, real image bytes, path boundary, chat link (fixture, no paid model)`);
} finally {child.kill();}
