import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const sha=value=>createHash('sha256').update(value).digest('hex');
export class Fault extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
export const fail=(code,status)=>{throw new Fault(code,status);};
export const record=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function exact(x,keys,code='INVALID_BODY'){
  if(!record(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail(code);return x;
}
const artifact=fileURLToPath(new URL('./',import.meta.url));
const opaque=/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/;
const modelIDs=new Set(['deepseek-flash','deepseek-v4-pro']);
export function secureFile(p,max){
  if(typeof p!=='string'||!isAbsolute(p))fail('PRIVATE_FILE_PATH',500);
  const fd=openSync(p,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
    const s=fstatSync(fd);
    if(!s.isFile()||s.size<1||s.size>max||(process.platform==='linux'&&(s.mode&0o007)!==0))fail('PRIVATE_FILE_UNSAFE',500);
    const b=Buffer.alloc(max+1);let n=0;
    for(;;){const count=readSync(fd,b,n,b.length-n,null);if(!count)break;n+=count;if(n>max)fail('PRIVATE_FILE_TOO_LARGE',500);}
    return b.subarray(0,n);
  }finally{closeSync(fd);}
}
const parse=b=>JSON.parse(b.toString('utf8'));
export function approvedOrigin(x,allowTest=false){
  let u;try{u=new URL(x);}catch{fail('APPROVED_HTTPS_ORIGIN_REQUIRED');}
  const reserved=/(?:^|\.)(?:localhost|local|example|invalid|test|internal|home|onion)$|(?:^|\.)(?:example\.com|example\.net|example\.org)$/i;
  if(u.protocol!=='https:'||u.origin!==x||u.port||u.username||u.password||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u.test(u.hostname)||(!allowTest&&reserved.test(u.hostname)))fail('APPROVED_HTTPS_ORIGIN_REQUIRED');
  return {origin:u.origin,host:u.hostname};
}
const outsideArtifact=p=>{const sub=relative(artifact,resolve(p));return sub==='..'||sub.startsWith('..'+sep)||isAbsolute(sub);};
export function validateConfig(raw,{test=false}={}){
  exact(raw,['schema','publicOrigin','storeRef','snapshotFile','snapshotSha256','stateDir','socketPath','modelId','modelPolicy','modelSecretFile'],'CONFIG_FIELDS');
  const oh=approvedOrigin(raw.publicOrigin,test);
  if(raw.schema!==1||!opaque.test(raw.storeRef)||!modelIDs.has(raw.modelId)||!['enabled','disabled'].includes(raw.modelPolicy)||
    !/^[a-f0-9]{64}$/.test(raw.snapshotSha256)||[raw.snapshotFile,raw.stateDir,raw.modelSecretFile]
      .some(p=>typeof p!=='string'||!isAbsolute(p)||(!test&&!outsideArtifact(p))))fail('CONFIG_POLICY');
  if(typeof raw.socketPath!=='string'||(!test&&(!isAbsolute(raw.socketPath)||!outsideArtifact(raw.socketPath)))||
    !raw.socketPath.length||Buffer.byteLength(raw.socketPath)>100)fail('CONFIG_PRIVATE_SOCKET');
  return Object.freeze({...raw,...oh});
}
export const loadConfig=p=>validateConfig(parse(secureFile(p,8192)));
export function loadCatalog(cfg){
  const bytes=secureFile(cfg.snapshotFile,16000);
  if(sha(bytes)!==cfg.snapshotSha256)fail('SNAPSHOT_DIGEST_MISMATCH',503);
  return catalogFromObject(cfg,parse(bytes));
}
export function catalogFromObject(cfg,value){
  const x=exact(value,['schema','storeRef','cards'],'SNAPSHOT_FIELDS');
  if(x.schema!==1||x.storeRef!==cfg.storeRef||!Array.isArray(x.cards)||x.cards.length!==2)fail('SNAPSHOT_SCOPE',503);
  const map=new Map(), ids=new Set();
  for(const row of x.cards){
    exact(row,['alias','productId','productVersion','priceYuan','size'],'SNAPSHOT_CARD_FIELDS');
    if(!['A','B'].includes(row.alias)||map.has(row.alias)||ids.has(row.productId)||
      typeof row.productId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.productId)||
      !Number.isSafeInteger(row.productVersion)||row.productVersion<1||
      (row.priceYuan!==null&&(typeof row.priceYuan!=='string'||!/^(?:0|[1-9][0-9]{0,8})\.\d{2}$/.test(row.priceYuan)))||
      (row.size!==null&&(typeof row.size!=='string'||row.size.length>72||!/^[\p{L}\p{N}.×x +\-]+$/u.test(row.size))))fail('SNAPSHOT_CARD_VALUE',503);
    ids.add(row.productId);map.set(row.alias,Object.freeze({productId:row.alias,cardId:row.productId,shopId:cfg.storeRef,
      version:row.productVersion,price:row.priceYuan===null?null:Number(row.priceYuan),priceText:row.priceYuan,size:row.size,inventory:null}));
  }
  return Object.freeze({read(alias){if(!map.has(alias))fail('CARD_NOT_FOUND',404);return map.get(alias);}});
}
export function readModelSecret(cfg){
  if(cfg.modelPolicy!=='enabled')return null;
  let b;
  try{b=secureFile(cfg.modelSecretFile,512);const s=b.toString('ascii').trim();
    return /^sk-[A-Za-z0-9_-]{20,220}$/.test(s)?s:null;
  }catch{return null;}finally{if(b)b.fill(0);}
}
