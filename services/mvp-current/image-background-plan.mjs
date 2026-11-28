import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {boundProduct} from './video-service.mjs';
import {ARK_IMAGE_OUTPUT_SIZE} from './image-background-provider.mjs';

const WORKFLOW='image.replace_background';
const VERSION='image-background-plan/v2';
const sku=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const digest=x=>createHash('sha256').update(x).digest('hex');
const isSha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=code=>{throw Object.assign(Error(code),{code});};
const compatible=Object.freeze({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'});
const fields=['productId','assetId','backgroundBrief','requestedAction'];
const style='低干扰的中性背景；保留原拍摄视角与自然光感';
const protection={
 preserve:['same_item','original_ratio','position','view_angle','bead_order','color','spacers'],
 backgroundAreas:['outside','inside_loop','between_beads'],
 note:'只换背景：外圈、环内和珠缝旧底一并更换；保留珠串、金属隔片、小配件、原比例、位置和角度。保真须对照原图核验。'
};
const negativeAction=/(?:暂不|先不|不用|不必|不需要|不要|先别|别|不想|无需)\s*(?:(?:真的|实际|再|开始|现在|帮我|给我|立即|马上)\s*){0,3}(?:生图|生成|制作|出图|做图|做(?:(?:一张|一版)?(?:图|成品)|(?=$|[。！？；，,\s]))|(?:执行)?(?:换(?:底|背景)|改背景))|不(?:生成|做图|制作)/u;
const planWording=/(?:(?:先\s*)?只\s*(?:给|看|要|列|出|准备)(?:我|一下|一份|一个|下|个)?[^。！？；\n，,]{0,10}(?:方案|计划)|(?:先给|先列|先出|先看)(?:我|一下|一份|一个|下|个)?[^。！？；\n，,]{0,10}(?:方案|计划))/u;
const editIntent=/(?:换|改|替换|更换)[^。！？；\n，,]{0,18}(?:背景|底色|换底|底)|(?:背景|底色)[^。！？；\n，,]{0,18}(?:换|改|替换)|换底/u;

function validatePlanInput(args,accepted){
   if(!args||Object.getPrototypeOf(args)!==Object.prototype||Object.keys(args).some(k=>!accepted.includes(k))||
       (args.requestedAction!==undefined&&!['plan','preview'].includes(args.requestedAction))||
       (args.backgroundBrief!==undefined&&(typeof args.backgroundBrief!=='string'||[...args.backgroundBrief].length>180||
          /[\u0000-\u001f\u007f]|https?:\/\/|file:\/|[A-Z]:[\\/]/iu.test(args.backgroundBrief))))
     fail('INVALID_PLAN_INPUT');
}

function buildImageBackgroundPlan(source,args,ctx){
   const backgroundBrief=args.backgroundBrief?.trim().normalize('NFC')||style;
   const planId='img-bg-'+digest(JSON.stringify([VERSION,ARK_IMAGE_OUTPUT_SIZE,source.assetId,source.productVersion,source.sourceSha256,backgroundBrief]));
   const text=typeof ctx.userText==='string'?ctx.userText:'';
   const requestedAction=args.requestedAction==='preview'&&editIntent.test(text)&&!negativeAction.test(text)&&!planWording.test(text)
      ?'preview':'plan_only';
   return {status:'planned',workflow:WORKFLOW,planVersion:VERSION,outputSize:ARK_IMAGE_OUTPUT_SIZE,planId,source,backgroundBrief,
      requestedAction,protect:structuredClone(protection),generationStatus:'not_requested',deliveryStatus:'not_submitted',qualityStatus:'not_evaluated'};
}

// Internal upload workflow port. Only its independently verified attachment pin enters here.
export function planUploadedImageBackground(source,args,ctx={}){
 validatePlanInput(args,['backgroundBrief','requestedAction']);
 if(!source||source.sourceKind!=='message_photo'||!isSha(source.sourceSha256))fail('INVALID_SOURCE_PIN');
 return buildImageBackgroundPlan(source,args,ctx);
}

export function createImageBackgroundPlanner({catalogPath,sourceRoot}={}){
 if(typeof catalogPath!=='string'||!path.isAbsolute(catalogPath)||typeof sourceRoot!=='string'||!path.isAbsolute(sourceRoot))
   throw TypeError('Trusted catalogPath and sourceRoot required');
 const trusted={catalogPath,sourceRoot};
 function lookupCard({productId,assetId},ctx={}){
   const assetSku=assetId===undefined?undefined:typeof assetId==='string'&&assetId.startsWith('catalog:')?assetId.slice(8):null;
   if(assetId!==undefined&&!sku(assetSku))fail('INVALID_ASSET_REF');
   if(productId!==undefined&&!sku(productId))fail('INVALID_PLAN_INPUT');
   if(productId===undefined&&assetSku===undefined)fail('SOURCE_REQUIRED');
   let cards;
   try{cards=JSON.parse(fs.readFileSync(catalogPath,'utf8').replace(/^\uFEFF/,'')).cards;}catch{fail('CATALOG_UNAVAILABLE');}
   if(!Array.isArray(cards))fail('CATALOG_UNAVAILABLE');
   function match(id,shortForm=false){
     const found=cards.filter(c=>c&&(c.cardId===id||c.id===id||(shortForm&&/^\d{1,8}$/.test(id)&&
        (c.cardId==='BCMLDIY'+id||c.id==='BCMLDIY'+id))));
     if(found.length>1)fail('AMBIGUOUS_PRODUCT');
     if(!found.length)fail('UNKNOWN_PRODUCT');
     const c=found[0],actual=c.cardId||c.id;
     if(!sku(actual)||(c.cardId!==undefined&&c.id!==undefined&&c.id!==c.cardId)||
        typeof c.sourceImage!=='string'||!path.isAbsolute(c.sourceImage))fail('PRODUCT_IMAGE_BINDING_INVALID');
     return {c,actual};
   }
   const subject=productId===undefined?match(assetSku):match(productId,true);
   if(assetSku!==undefined&&subject.actual!==assetSku)fail('SOURCE_PRODUCT_MISMATCH');
   if(ctx.expectedProductId!==undefined&&match(ctx.expectedProductId,true).actual!==subject.actual)
     fail('SOURCE_PRODUCT_MISMATCH');
   // Owner's explicit SKU is a consistency check, not an image workflow dispatcher.
   const text=typeof ctx.userText==='string'?ctx.userText:'';
   const explicit=new Set([...text.matchAll(/\bBCMLDIY(\d{1,8}(?:[-_][A-Z0-9]+)*)(?![A-Z0-9_-])|(?:货号\s*[:：]?\s*(\d{1,8}(?:[-_][A-Z0-9]+)*)(?![A-Z0-9_-])|(\d{1,8}(?:[-_][A-Z0-9]+)*)\s*号\s*(?:的\s*)?(?:手串|手链|商品|这件|图片|照片|图))/giu)]
      .map(m=>'BCMLDIY'+(m[1]??m[2]??m[3]).toUpperCase()));
   if(explicit.size>1)fail('AMBIGUOUS_PRODUCT');
   if(explicit.size&&!explicit.has(subject.actual))fail('SOURCE_PRODUCT_MISMATCH');
   let lock;
   try{lock=boundProduct(trusted,subject.actual,[subject.c]);}
   catch(e){
     if(['MEDIA_OUTSIDE_SOURCE_ROOT','PRODUCT_IMAGE_BINDING_INVALID'].includes(e?.message))fail(e.message);
     fail('SOURCE_UNAVAILABLE');
   }
   return {
     file:lock.file,
     source:{assetId:'catalog:'+subject.actual,productId:subject.actual,
       productVersion:Number.isSafeInteger(subject.c.productVersion)&&subject.c.productVersion>0?subject.c.productVersion:null,
       sourceKind:'catalog_original',sourceSha256:lock.sha256,contentType:compatible[path.extname(lock.file).toLowerCase()]}
   };
 }

 function plan(args,ctx={}){
   validatePlanInput(args,fields);
   const {source}=lookupCard(args,ctx);
   return buildImageBackgroundPlan(source,args,ctx);
 }

 // Trusted backend port only. Future execution must recompute the plan and check this pin before any submit.
 function readPinnedSource(pin){
   if(!pin||!sku(pin.productId)||typeof pin.assetId!=='string'||!isSha(pin.sourceSha256)||
      pin.sourceKind!=='catalog_original'||!(pin.productVersion===null||Number.isSafeInteger(pin.productVersion)&&pin.productVersion>0))
     fail('INVALID_SOURCE_PIN');
   const lock=lookupCard({productId:pin.productId,assetId:pin.assetId});
   if(lock.source.sourceSha256!==pin.sourceSha256||lock.source.productVersion!==pin.productVersion||lock.source.contentType!==pin.contentType)
     fail('SOURCE_CHANGED');
   let bytes;
   try{bytes=fs.readFileSync(lock.file);}catch{fail('SOURCE_UNAVAILABLE');}
   if(digest(bytes)!==pin.sourceSha256)fail('SOURCE_CHANGED');
   const mime=lock.source.contentType;
   const matches=mime==='image/jpeg'?bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff:
     mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
     mime==='image/webp'?bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':false;
   if(!matches)fail('SOURCE_FORMAT_MISMATCH');
   return {bytes,contentType:mime,sourceSha256:pin.sourceSha256};
 }
 return Object.freeze({plan,readPinnedSource});
}
