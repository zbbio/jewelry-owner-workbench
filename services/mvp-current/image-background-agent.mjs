import {Agent,Runner,tool,setTracingDisabled,setTraceProcessors,OpenAIChatCompletionsModel} from '@openai/agents';
import OpenAI from 'openai';

setTracingDisabled(true);
setTraceProcessors([]);
export const imageToolName='image_replace_background';
// This selects the candidate tool group, not execution or arguments.
export const isImageBackgroundIntent=text=>(!/(?:视频|短片|原片|成片)/u.test(text??'')||/(?:原图|商品图|图片|照片)/u.test(text??''))&&/(?:换|改|替换|更换)[^。！？；\n，,]{0,24}(?:背景|底色)|(?:背景|底色)[^。！？；\n，,]{0,16}(?:换|改|替换)|换底/u.test(text??'');
const parameters={type:'object',additionalProperties:false,properties:{
 productId:{type:'string',description:'使用原指令中的货号，保留完整后缀；数字简称可直接传'},
 assetId:{type:'string',description:'已由可信来源提供的本店素材引用，不编造路径或网址'},
 backgroundBrief:{type:'string',description:'只描述背景环境；不改变本件珠宝、构图或拍摄角度'},
 requestedAction:{type:'string',enum:['plan','preview']}
},required:['backgroundBrief','requestedAction']};
const instruction='你是珠宝助手中的图片换背景工具选择器。若店主指定本件和背景，使用 image_replace_background 并从原话提取货号和背景，完整保留字母和后缀。通常“把…换成…背景，给我预览”用 preview；只给方案、不生成用 plan；“先别发布”不阻止预览但不要发布。不明确哪件就澄清，不猜商品。此工具不给图就不要说已完成；不改商品卡，不外发，不用工具重复生成、查价或制作视频。';
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{2,79}$/.test(e.code)?e.code:'IMAGE_WORKFLOW_FAILED';
const metadata={mode:'deepseek',runtime:'openai_agents_sdk'};
export function publicImageJob(r){
 if(typeof r?.jobId!=='string'||!/^img-job-[a-f0-9-]{36}$/.test(r.jobId))return null;
 const version=r.status==='preview_ready'?r.work?.version??null:null;
 return {id:r.jobId,status:r.status,productId:r.source?.productId,version,
  ...(version===1&&r.warnings?.includes('SOURCE_ASPECT_RATIO_CHANGED')?{warnings:['SOURCE_ASPECT_RATIO_CHANGED']}:{}),
  ...(r.errorCode?{errorCode:r.errorCode}:{}),...(r.providerCode?{providerCode:r.providerCode}:{})};
}
function businessReply(r){
 if(!r)return '本次未选择换背景工具；请说明本件货号和想换的背景。';
 if(r.status==='planned')return '已为 '+r.source.productId+' 列出换背景方案：'+r.backgroundBrief+'。没有提交生成。';
 if(r.status==='generation_disabled')return '已为 '+r.source.productId+' 准备换背景方案：'+r.backgroundBrief+'。当前未开放生成，没有提交。';
 if(r.status==='preview_ready')return r.source.productId+' 的合成预览已保存，原图没改。'+(r.warnings?.includes('SOURCE_ASPECT_RATIO_CHANGED')?'生成图与原图宽高比不同，请复核。':'')+'请对照原图核珠子和隔片。未发布。';
 if(r.status==='intent_recorded'||r.status==='submission_unknown')return '原任务可能仍在处理或提交结果未确认；只查询原任务，不会自动重试。';
 if(r.errorCode==='IMAGE_UNRESOLVED_SUBMISSION')return '已有图片提交结果未确认；本次未提交新任务。';
 if(r.providerCode==='ModelNotOpen')return '图片服务未开通此模型（ModelNotOpen），本次未产出图片，也未重试。';
 if(['SOURCE_REQUIRED','UNKNOWN_PRODUCT','AMBIGUOUS_PRODUCT','SOURCE_PRODUCT_MISMATCH'].includes(r.errorCode))
   return '本件原图未核对成功。请确认商品货号，本次未生成。';
 return '换背景未完成，没有可查看的新图。';
}
export async function runImageBackgroundAgent(text,{apiKey,model='deepseek-chat',imageService,imageContext,imageFetch,requestId}={}){
 const base={...metadata,model,tool:null,receipt:null,routeRequestId:null};
 if(!imageService||!apiKey||!imageContext)return {...base,reply:'换背景工具尚未连接，本次未生成。'};
 let receipt=null,called=false;
 const adapter=tool({name:imageToolName,description:'只处理已有本件原图换背景。按店主意图返回方案或单张内部预览，不发布。',parameters,strict:false,errorFunction:null,execute:async args=>{
   if(called)return {status:'not_executed',errorCode:'IMAGE_TOOL_ALREADY_CALLED'};
   called=true;
   let result;
   try{result=await imageService.execute({...imageContext,userText:text},{requestId,args});}
   catch(e){result={status:'failed',errorCode:safeCode(e),deliveryStatus:'not_submitted'};}
   receipt={tool:imageToolName,status:result.status==='failed'?'failed':'completed',result,sideEffects:[]};
   return result;
 }});
 const client=new OpenAI({apiKey,baseURL:'https://api.deepseek.com',timeout:45000,maxRetries:0,...(imageFetch?{fetch:imageFetch}:{})});
 const sdk=new Agent({name:'JewelryImageBackground',model:new OpenAIChatCompletionsModel(client,model),instructions:instruction,
  modelSettings:{temperature:0,parallelToolCalls:false,providerData:{thinking:{type:'disabled'}}},tools:[adapter]});
 const runner=new Runner({tracingDisabled:true,traceIncludeSensitiveData:false});
 let out;
 try{out=await runner.run(sdk,text,{maxTurns:3});}
 catch{if(!receipt)return {...base,reply:'换背景工具暂时不可用，没有提交生成。'};}
 const job=publicImageJob(receipt?.result);
 return {...base,tool:receipt?.tool??null,receipt,reply:businessReply(receipt?.result),routeRequestId:out?.lastResponseId??null,...(job?{imageJob:job}:{})};
}
