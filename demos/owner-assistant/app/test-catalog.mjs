import assert from 'node:assert/strict';
import path from 'node:path';
import { demoBase, sourceImagePath } from './paths.mjs';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const host='http://127.0.0.1:34198';
const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,PORT:'34198',MVP_FIXTURE:'1'},stdio:'ignore'});
try{
  let ready=false;
  for(let i=0;i<80;i++){try{if((await fetch(host)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready);
  const response=await fetch(host+'/catalog'); assert.equal(response.status,200);
  const html=await response.text(); assert.ok(html.includes('我的商品卡'),'visual catalog page');
  const index=JSON.parse(await readFile(path.join(demoBase,'商品卡索引.json'),'utf8'));
  assert.equal((html.match(/class="product-card"/g)||[]).length,index.cards.length);
  assert.ok(!html.includes('E:\\'),'no filesystem path shown');
  for(let start=0;start<index.cards.length;start+=8){
    await Promise.all(index.cards.slice(start,start+8).map(async card=>{
      assert.ok(html.includes('data-card-id="'+card.cardId+'"'));
      const page=await fetch(host+'/catalog?id='+encodeURIComponent(card.cardId)); assert.equal(page.status,200);
      const detail=await page.text(); assert.ok(detail.includes('颜色')); assert.ok(detail.includes(String(card.color)));
      if(typeof card.price==='number') assert.ok(detail.includes(card.price.toFixed(2)));
      const image=await fetch(host+'/catalog/image?id='+encodeURIComponent(card.cardId)); assert.equal(image.status,200);
      assert.ok(image.headers.get('content-type').startsWith('image/'));
      const bytes=Buffer.from(await image.arrayBuffer()); const original=await readFile(sourceImagePath(card.sourceImage));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(original).digest('hex'));
    }));
  }
  assert.equal((await fetch(host+'/catalog?id=NO_SUCH_CARD')).status,404);
  assert.equal((await fetch(host+'/catalog/image?id=../../server.mjs')).status,404);
  const {replyFor}=await import('./agent.mjs');
  const reply=replyFor('catalog_create_or_read_card',{result:{classificationMode:'deepseek_vision',total:index.cards.length}});
  assert.ok(reply.includes('href="/catalog"'),'completion reply links visual catalog');
  assert.ok(!reply.includes('JSON')); assert.ok(!reply.includes('E:\\'));
  const {renderCatalog}=await import('./catalog-page.mjs');
  const escaped=renderCatalog([{...index.cards[0],name:'<script>bad()</script>'}]);
  assert.ok(escaped.includes('&lt;script&gt;')); assert.ok(!escaped.includes('<script>bad()'));
  console.log(`PASS catalog ${index.cards.length} cards: pages, prices/colors, source-image SHA256, no local paths, unknown IDs blocked, completion link (no paid model)`);
}finally{child.kill();}
