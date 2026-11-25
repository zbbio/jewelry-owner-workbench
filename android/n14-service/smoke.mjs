import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLocal} from './服务.mjs';
import {prepareCatalog} from './agent/dist/catalog.js';
const dir=await mkdtemp(join(tmpdir(),'jewelry-public-usb-'));
let server;
try {
  const fixture=await prepareCatalog();
  try {
    assert.equal(fixture.catalog.read('A').priceText,'240.00');
    assert.equal(fixture.catalog.read('B').priceText,null);
    assert.throws(()=>fixture.catalog.read('other'),/UNKNOWN_PRODUCT/);
  } finally { fixture.close(); }
  server=await startLocal({dir,port:0,live:false});
  const h=await fetch(new URL('/api/health',server.origin));
  assert.equal(h.status,200);
  assert.equal((await h.json()).model,'paused');
  const home=await fetch(new URL('/',server.origin));
  assert.equal(home.status,200);
  assert.match(await home.text(),/配对/);
  console.log('demo A = 240.00, demo B = no price, unknown card rejected; health and pairing page = 200; model paused');
} finally {
  if(server){server.close();await server.done;}
  await rm(dir,{recursive:true,force:true});
}
