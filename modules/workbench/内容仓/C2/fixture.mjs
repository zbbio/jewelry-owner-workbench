import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';

export const sha=b=>createHash('sha256').update(b).digest('hex');
const crc32=buf=>{let c=0xffffffff;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0;};
function pngChunk(t,d){const h=Buffer.alloc(8),c=Buffer.alloc(4);h.writeUInt32BE(d.length);h.write(t,4);c.writeUInt32BE(crc32(Buffer.concat([h.subarray(4),d])));return Buffer.concat([h,d,c]);}
function fixtureImage(i){
 const w=200,h=200,head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;
 const frame=Buffer.alloc(h*(1+w*3)); const sets=[[30,58,69],[78,45,88],[42,73,42]];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const p=y*(1+w*3)+1+x*3, r=Math.hypot(x-100,y-100), c=sets[i];
  const ring=Math.abs(r-54)<11, bar=x>22&&x<177&&Math.abs(y-(i*25+28))<6;
  const pix=ring?[120+i*23,217-i*22,186-i*24]:bar?[219,192,98]:c;
  for(let j=0;j<3;j++)frame[p+j]=pix[j];
 }
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',head),pngChunk('IDAT',deflateSync(frame)),pngChunk('IEND',Buffer.alloc(0))]);
}
export const ctx={shopId:'n22-self-owned-c-fixture',actorId:'fixture-owner',role:'owner'};
export const ids={C:'fixture-C',B:'fixture-other-item'};
export const material=Object.freeze([0,1,2].map(i=>{
 const bytes=fixtureImage(i),assetId='fixture-shot-'+(i+1);
 return {bytes,assetId,sha256:sha(bytes),mime:'image/png'};
}));
export function source(msg='fixture-plan-main'){
 return {...ctx,allowPlanning:true,messageId:msg,productId:ids.C,productVersion:1,copyId:'fixture-copy',
  copyVersion:1,confirmedCopy:'几何测试图，不是店内实物',preferenceId:'one-shoot-fixture',preferenceVersion:1,
  assets:material.map(({assetId,sha256},i)=>({shopId:ctx.shopId,productId:ids.C,productVersion:1,assetId,sha256,
    grantId:'fixture-planning-'+i,grantVersion:1,active:true,kind:'product_shot',usage:'draft_planning'}))};
}
export function readFixtureAsset(trusted,{assetId,productId,productVersion,grantId,grantVersion}){
 if(trusted?.shopId!==ctx.shopId||trusted.actorId!==ctx.actorId||productId!==ids.C||productVersion!==1)return null;
 const a=material.find(x=>x.assetId===assetId), g=source().assets.find(x=>x.assetId===assetId);
 if(!a||g.grantId!==grantId||g.grantVersion!==grantVersion)return null;
 return {...g,...a};
}
