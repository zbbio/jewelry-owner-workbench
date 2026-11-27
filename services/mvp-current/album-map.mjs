import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const sha=x=>createHash('sha256').update(x).digest('hex');
const pins={
 'taxonomy.json':'16631c686ff4d5550ae5ffe4e72c7f10823d02052bf2263bd595b06a7683f421',
 'taxonomy.mjs':'d863bf1ce005f183b134428360bf7da76ef99a512684d8139cfc402617c83f33'
};
for(const [file,pin] of Object.entries(pins)){
 if(sha(readFileSync(new URL(file,import.meta.url)))!==pin)throw Error('ALBUM_TAXONOMY_DIGEST_MISMATCH');
}
const taxonomy=await import('./taxonomy.mjs');
const {fromLegacy,displayClassification,taxonomyVersion}=taxonomy;
export const isAlbumBatch=x=>typeof x==='string'&&/^[a-f0-9]{32}$/u.test(x);

export function mapBatch(input){
 if(!isAlbumBatch(input?.batchId)||!Array.isArray(input.rows)||!input.rows.length)throw Error('ALBUM_INVALID_BATCH');
 const {batchId}=input, evidence={}, names=new Set(), items=[];
 for(const row of input.rows){
  const {file,sha256:assetSha256,category,type}=row;
  if(typeof file!=='string'||!file||names.has(file)||!(/^[a-f0-9]{64}$/u.test(assetSha256))||
     typeof category!=='string'||category.length>128||typeof type!=='string'||type.length>128)
    throw Error('ALBUM_INVALID_CLASSIFICATION_ROW');
  names.add(file);
  const observation={batchId,file,assetSha256,source:'image_inference',observedCategory:category,observedSubtype:type||null};
  const ref='album-observation:'+sha(JSON.stringify(observation));
  evidence[ref]=observation;
  const classification=fromLegacy({group:category,type,evidenceRefs:[ref]});
  items.push({file,group:displayClassification(classification).group,classification});
 }
 return {taxonomyVersion,items,evidence};
}
export function viewAlbumRow(row,manifest){
 const current=Object.hasOwn(row??{},'classification')||Object.hasOwn(manifest??{},'batchId');
 try{
  if(current&&(!Object.hasOwn(row,'classification')||!isAlbumBatch(manifest.batchId)||
     manifest.taxonomyVersion!==taxonomyVersion))throw Error('ALBUM_INVALID_CLASSIFICATION_SNAPSHOT');
  const c=taxonomy.readAlbumClassification(row).classification;
  const view=displayClassification(c);
  if(current){
    const ref=c.evidenceRefs[0],e=manifest.evidence?.[ref];
    if(view.group!==row.group||c.evidenceRefs.length!==1||e?.batchId!==manifest.batchId||
       e?.file!==row.file||e?.assetSha256!==row.sha256||e?.source!=='image_inference'||
       ref!=='album-observation:'+sha(JSON.stringify(e)))
      throw Error('ALBUM_INVALID_CLASSIFICATION_EVIDENCE');
    const observed=fromLegacy({group:e.observedCategory,type:e.observedSubtype,evidenceRefs:[ref]});
    if(c.categoryId!==observed.categoryId||c.subtypeId!==observed.subtypeId||c.status!==observed.status)
      throw Error('ALBUM_CLASSIFICATION_OBSERVATION_CONFLICT');
  }
  return {classification:c,...view};
 }catch{
  const c=fromLegacy();
  return {classification:c,...displayClassification(c)};
 }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 let input='';process.stdin.setEncoding('utf8');
 for await(const line of process.stdin){input+=line;if(input.length>8*1024*1024)throw Error('ALBUM_BATCH_TOO_LARGE');}
 process.stdout.write(JSON.stringify(mapBatch(JSON.parse(input))));
}