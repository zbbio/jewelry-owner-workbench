import {readFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(new URL('./taxonomy.json',import.meta.url),'utf8'));
const error=code=>Object.assign(new Error(code),{code});
const fail=code=>{throw error(code);};
const norm=s=>typeof s==='string'?s.normalize('NFKC').trim().replace(/\s+/gu,''):'';
const opaque=x=>typeof x==='string'&&x.length>0&&x.length<=240&&x===x.trim()&&!/[\u0000-\u001f\u007f]/u.test(x);
const cats=new Map(data.categories.map(x=>[x.id,x])), subs=new Map(data.subtypes.map(x=>[x.id,x]));
if(cats.size!==data.categories.length||subs.size!==data.subtypes.length)fail('TAXONOMY_DUPLICATE_ID');
const labels=new Map(), words=new Map(data.categories.map(c=>[c.id,new Map()]));
function put(map,k,v){
 const n=norm(k);
 if(!n||map.has(n)&&map.get(n)!==v)fail('TAXONOMY_ALIAS_CONFLICT');
 map.set(n,v);
}
for(const x of cats.values()){
 if(x.parentId!==null||subs.has(x.id))fail('TAXONOMY_INVALID_TREE');
 for(const a of [x.label,x.legacyGroup,...x.aliases])put(labels,a,x.id);
}
for(const x of subs.values()){
 if(!cats.has(x.parentId))fail('TAXONOMY_INVALID_TREE');
 for(const a of [x.label,...x.aliases])put(words.get(x.parentId),a,x.id);
}
export const taxonomyVersion=data.taxonomyVersion;
const keys=['taxonomyVersion','categoryId','subtypeId','status','evidenceRefs'];
export function validateClassification(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k)))fail('INVALID_CLASSIFICATION');
 if(v.taxonomyVersion!==taxonomyVersion)fail('TAXONOMY_VERSION_MISMATCH');
 if(v.categoryId!==null&&!cats.has(v.categoryId))fail('UNKNOWN_CATEGORY');
 if(v.subtypeId!==null&&!subs.has(v.subtypeId))fail('UNKNOWN_SUBTYPE');
 if(v.subtypeId!==null&&subs.get(v.subtypeId).parentId!==v.categoryId)fail('SUBTYPE_OUT_OF_TREE');
 if(!['classified','needs_review'].includes(v.status)||v.status==='classified'&&(v.categoryId===null||v.subtypeId===null))fail('INVALID_CLASSIFICATION_STATUS');
 if(!Array.isArray(v.evidenceRefs)||v.evidenceRefs.length>64||!v.evidenceRefs.every(opaque)||new Set(v.evidenceRefs).size!==v.evidenceRefs.length)fail('INVALID_CLASSIFICATION_EVIDENCE');
 if(v.status==='classified'&&!v.evidenceRefs.length)fail('CLASSIFICATION_EVIDENCE_REQUIRED');
 return {taxonomyVersion,categoryId:v.categoryId,subtypeId:v.subtypeId,status:v.status,evidenceRefs:[...v.evidenceRefs]};
}
export function fromLegacy({group,type,evidenceRefs=[]}={}){
 const categoryId=labels.get(norm(group))??null;
 const subtypeId=words.get(categoryId)?.get(norm(type))??null;
 return validateClassification({taxonomyVersion,categoryId,subtypeId,status:subtypeId!==null&&evidenceRefs?.length?'classified':'needs_review',evidenceRefs});
}
export function displayClassification(input){
 const {categoryId,subtypeId,status}=validateClassification(input);
 const c=cats.get(categoryId);
 return {group:c?.legacyGroup??data.unknown.legacyGroup,category:c?.label??'待确认',
  subtype:subtypeId===null?'细类待确认':subs.get(subtypeId).label,status};
}
export function readAlbumClassification(row){
 // Old filename/hash/group are display data, never a verified same-item group or evidence.
 if(!row||typeof row!=='object'||Array.isArray(row))fail('INVALID_ALBUM_ROW');
 return {...row,classification:Object.hasOwn(row,'classification')?validateClassification(row.classification):fromLegacy({group:row.group})};
}
