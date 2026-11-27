import path from "node:path";
import {readFileSync,writeFileSync,renameSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {viewAlbumRow} from "./album-map.mjs";
import {demoBase,albumV2Base} from "./paths.mjs";
const sha=b=>createHash("sha256").update(b).digest("hex");
const readJSON=p=>JSON.parse(readFileSync(p,"utf8"));
const bindingPath=path.join(albumV2Base,"已核单图货号.json");
const active=path.join(albumV2Base,"商品分类展示.json");
const manifestPath=path.join(albumV2Base,"分类结果.json");
const indexPath=path.join(demoBase,"商品卡索引.json");
function snapshot(){
 const manifest=readJSON(manifestPath);
 const bindings=readJSON(bindingPath);
 if(bindings.indexSha256!==sha(readFileSync(indexPath)))throw Error("FACTS_INDEX_PIN_MISMATCH");
 if(!manifest?.batchId||manifest.fileCount!==bindings.items.length)throw Error("NO_COMPLETE_LIVE_ALBUM");
 const byFile=new Map(manifest.items.map(row=>[row.file,row]));
 if(byFile.size!==bindings.items.length)throw Error("ALBUM_SET_MISMATCH");
 const rows={};
 for(const pin of bindings.items){
  const row=byFile.get(pin.file);
  if(!row||row.sha256!==pin.sha256)throw Error("ALBUM_FACTS_BINDING_MISMATCH");
  const view=viewAlbumRow(row,manifest);
  rows[pin.cardId]={classification:view.classification,category:view.category,subtype:view.subtype,imageSha256:row.sha256};
 }
 return {batchId:manifest.batchId,taxonomyVersion:manifest.taxonomyVersion,rows};
}
export function applyPhotoClassifications(){
 try {
  const snap=snapshot();
  const pending=path.join(albumV2Base,"projection-"+randomUUID()+".tmp");
  writeFileSync(pending,JSON.stringify(snap,null,2)+"\n",{flag:"wx",encoding:"utf8"});
  renameSync(pending,active);

  return {total:Object.keys(snap.rows).length,batchId:snap.batchId,taxonomyVersion:snap.taxonomyVersion,
    classificationMode:"deepseek_vision",classificationSource:"album_snapshot",visionCalls:0};
 } catch(e) {

  return {total:0,status:"requires_album",classificationSource:"none"};
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
