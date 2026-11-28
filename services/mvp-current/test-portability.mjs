import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {demoBase,sourceRoot,priceSource,python} from './paths.mjs';

const root=fileURLToPath(new URL('./_portability-fixture',import.meta.url));
const data=path.join(root,'data');
const demo=path.join(data,'demo');
const source=path.join(data,'source');
const cards=path.join(demo,'商品卡');
const classified=path.join(demo,'分类结果','手串-手链');
await Promise.all([source,cards,classified].map(p=>mkdir(p,{recursive:true})));
const originalIndex=JSON.parse(await readFile(path.join(demoBase,'商品卡索引.json'),'utf8'));
const sample=originalIndex.cards[0];
const filename=path.basename(sample.sourceImage);
await copyFile(sample.sourceImage,path.join(source,filename));
await copyFile(sample.sourceImage,path.join(classified,filename));
await copyFile(priceSource,path.join(data,'price.xlsx'));
const card={...sample,sourceImage:path.join(source,filename),classifiedImage:path.join(classified,filename),priceSource:path.join(data,'price.xlsx')};
await writeFile(path.join(cards,card.cardId+'.json'),JSON.stringify(card));
await writeFile(path.join(demo,'商品卡索引.json'),JSON.stringify({fileCount:1,cards:[card]}));
await writeFile(path.join(demo,'分类结果.json'),JSON.stringify({fileCount:1,sourceRoot:source,classificationMode:'fixture',groups:{'手串-手链':1},items:[{file:filename,group:'手串-手链',source:card.sourceImage,classified_copy:card.classifiedImage}]}));
const env={...process.env,MVP_DATA_DIR:data,MVP_PYTHON:python};
delete env.MVP_SOURCE_DIR;delete env.MVP_PRICE_SOURCE;
const config=spawnSync(process.execPath,['--input-type=module','-e',`import {demoBase,sourceRoot,priceSource} from './paths.mjs'; console.log(JSON.stringify({demoBase,sourceRoot,priceSource}))`],{cwd:fileURLToPath(new URL('.',import.meta.url)),env,encoding:'utf8'});
assert.equal(config.status,0,config.stderr);
assert.deepEqual(JSON.parse(config.stdout),{demoBase:demo,sourceRoot:source,priceSource:path.join(data,'price.xlsx')});
for(const test of ['test-gallery.mjs','test-catalog.mjs']){
  const result=spawnSync(process.execPath,[test],{cwd:fileURLToPath(new URL('.',import.meta.url)),env,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);console.log(result.stdout.trim());
}
const py=spawnSync(python,['-X','utf8','-B','-c',`import catalog_build_cards as c; print(c.PRICE_SOURCE); p=c.load_prices(c.PRICE_SOURCE); assert p['DEMO103.jpg']==240; print('PRICE_ROWS',len(p))`],{cwd:fileURLToPath(new URL('.',import.meta.url)),env,encoding:'utf8',timeout:30000});
assert.equal(py.status,0,py.stdout+py.stderr); assert.ok(py.stdout.includes('PRICE_ROWS 130'));console.log('PASS Python uses configured data/price.xlsx and reads 130 Excel prices');
// Only delete the fixture created by this test, after checking it stays beside this test.
assert.ok(root.startsWith(fileURLToPath(new URL('.',import.meta.url))));
await rm(root,{recursive:true,force:true});
console.log('PASS portability env overrides: data/demo, data/source, data/price.xlsx, configured Python');
