import path from "node:path";
import {readFileSync,writeFileSync,renameSync,lstatSync,mkdirSync,rmdirSync,unlinkSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {isAlbumBatch,viewAlbumRow} from "./album-map.mjs";
import {demoBase,albumV2Base} from "./paths.mjs";
const sha=b=>createHash("sha256").update(b).digest("hex");
const readJSON=p=>JSON.parse(readFileSync(p,"utf8"));
const bindingPath=path.join(albumV2Base,"已核单图货号.json");
const active=path.join(albumV2Base,"商品分类展示.json");
const manifestPath=path.join(albumV2Base,"分类结果.json");
const indexPath=path.join(demoBase,"商品卡索引.json");
const lock=path.join(albumV2Base,".album-publish.lock");
export function albumPublicationLocked(){
 try{lstatSync(lock);return true;}
 catch(e){return e.code!=="ENOENT";}
}
export function currentCatalogAlbum(){
 try{
  const m=readJSON(manifestPath);
  return isAlbumBatch(m?.batchId)&&m.classificationMode==="deepseek_vision"&&
    Array.isArray(m.items)&&m.items.length>0&&m.fileCount===m.items.length?
    {batchId:m.batchId,fileCount:m.fileCount,classificationMode:m.classificationMode}:null;
 }catch{return null;}
}
const matches=(album,pin)=>!!album&&!!pin&&album.batchId===pin.batchId&&album.fileCount===pin.total;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function snapshot(){
 const manifest=readJSON(manifestPath);
 const bindings=readJSON(bindingPath);
 if(bindings.indexSha256!==sha(readFileSync(indexPath)))throw Error("FACTS_INDEX_PIN_MISMATCH");
 if(!isAlbumBatch(manifest?.batchId)||!Array.isArray(manifest.items)||!Array.isArray(bindings.items)||
    !bindings.items.length||manifest.items.length!==manifest.fileCount||manifest.fileCount!==bindings.items.length)
   throw Error("NO_COMPLETE_LIVE_ALBUM");
 const byFile=new Map(manifest.items.map(row=>[row.file,row]));
 if(byFile.size!==bindings.items.length)throw Error("ALBUM_SET_MISMATCH");
 const rows=Object.create(null);
 for(const pin of bindings.items){
  const row=byFile.get(pin.file);
  if(!row||row.sha256!==pin.sha256||!/^[a-f0-9]{64}$/u.test(pin.sha256??"")||
      typeof pin.cardId!=="string"||!pin.cardId||Object.hasOwn(rows,pin.cardId))
    throw Error("ALBUM_FACTS_BINDING_MISMATCH");
  const view=viewAlbumRow(row,manifest);
  rows[pin.cardId]={classification:view.classification,category:view.category,subtype:view.subtype,imageSha256:row.sha256};
 }
 return {batchId:manifest.batchId,taxonomyVersion:manifest.taxonomyVersion,rows};
}
// Read-back verifies the full published rows, not only a copied status or row count.
export function readCatalogProjection(pin){
 try{
  if(!matches(currentCatalogAlbum(),pin))return null;
  const expected=snapshot(), saved=readJSON(active);
  return expected.batchId===pin.batchId&&Object.keys(expected.rows).length===pin.total&&equal(saved,expected)
    ?{batchId:pin.batchId,total:pin.total}:null;
 }catch{return null;}
}
export function applyPhotoClassifications(expected){
 const unavailable={total:0,status:"requires_album",classificationSource:"none"};
 let owns=false,pending=null;
 try {
  // Share the album publisher's filesystem writer reservation (also covers external publishers).
  mkdirSync(lock);owns=true;
  const source=currentCatalogAlbum();
  const pin=expected??(source&&{batchId:source.batchId,total:source.fileCount});
  if(!matches(source,pin))return unavailable;
  const snap=snapshot(),total=Object.keys(snap.rows).length;
  if(snap.batchId!==pin.batchId||total!==pin.total)return unavailable;
  let saved;try{saved=readJSON(active);}catch{}
  if(!equal(saved,snap)){
   const stage=path.join(albumV2Base,"projection-"+randomUUID()+".tmp");
   writeFileSync(stage,JSON.stringify(snap,null,2)+"\n",{flag:"wx",encoding:"utf8"});pending=stage;
   if(!matches(currentCatalogAlbum(),pin)||!equal(snapshot(),snap))return unavailable;
   renameSync(pending,active);pending=null;
  }
  if(!readCatalogProjection(pin))return unavailable;
  return {total,batchId:snap.batchId,taxonomyVersion:snap.taxonomyVersion,
    classificationMode:"deepseek_vision",classificationSource:"album_snapshot",visionCalls:0};
 } catch {
  return unavailable;
 } finally{
  if(pending)try{unlinkSync(pending);}catch{}
  if(owns)try{rmdirSync(lock);}catch{}
 }
}
export function projectLegacyCards(cards) {
 try {
  const p=readJSON(active), verified=snapshot();
  if(JSON.stringify(p)!==JSON.stringify(verified))return cards;
  const applied=cards.filter(c=>Object.hasOwn(p.rows,c.cardId)).map(card=>{
   const x=p.rows[card.cardId];
   return {...card,classification:x.classification,category:x.category,type:x.subtype,classificationBatchId:p.batchId};
  });
  return [...applied,...cards.filter(c=>!Object.hasOwn(p.rows,c.cardId))];
 } catch {return cards;}
}
