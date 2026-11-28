import {Agent,Runner,tool,OpenAIChatCompletionsModel} from '@openai/agents';
import OpenAI from 'openai';
import {imageToolName,isImageBackgroundIntent} from './image-background-agent.mjs';

export function isUploadedImageTurn(text,attached=false){
 return typeof text==='string'&&isImageBackgroundIntent(text)&&(attached||
   /这(?:一|两|三)?张|那张|上面那张|刚才[^。！？；]{0,16}(?:图|照)|刚(?:刚)?发[^。！？；]{0,16}(?:图|照)|(?:本次|我)上传的?(?:原图|照片|图片)/u.test(text));
}
const jobId=/^img-job-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const safeCode=value=>typeof value==='string'&&/^(?:IMAGE_[A-Z0-9_]{1,80}|INVALID_PLAN_INPUT)$/.test(value)?value:null;
const matchKinds=['exact_match','unmatched','ambiguous','lookup_unavailable'];
const publicPin=(x,sha)=>x?.sourceSha256===sha&&digest.test(sha)&&matchKinds.includes(x.catalogMatch)?
 {sourceSha256:sha,catalogMatch:x.catalogMatch,matchedProductId:x.catalogMatch==='exact_match'&&/^[A-Za-z0-9_-]{1,100}$/.test(x.matchedProductId||'')?x.matchedProductId:null}:null;
function publicJob(j,sha){
 const pin=publicPin(j,sha);
 if(!pin||!jobId.test(j.id||'')||!['intent_recorded','submission_unknown','failed','preview_ready'].includes(j.status))return;
 const root='/style-image/media/'+j.id+'/';
 const ready=j.status==='preview_ready'&&j.version===1&&j.previewUrl===root+'generated'&&j.thumbnailUrl===root+'thumbnail';
 if(j.status==='preview_ready'&&!ready)return;
 const statusUrl='/style-image/jobs/'+j.id,watchUrl='/style-image/watch/'+j.id;
 if(j.statusUrl!==statusUrl||j.watchUrl!==watchUrl||j.originalUrl!==root+'original')return;
 return {id:j.id,status:j.status,...pin,statusUrl,watchUrl,originalUrl:j.originalUrl,aiGenerated:ready,
  ...(ready?{version:1,previewUrl:j.previewUrl,thumbnailUrl:j.thumbnailUrl,warnings:j.warnings?.includes('SOURCE_ASPECT_RATIO_CHANGED')?['SOURCE_ASPECT_RATIO_CHANGED']:[]}:{}),
  ...(j.reused===true?{reused:true}:{}),...(safeCode(j.code)?{code:j.code}:{})};
}
const prompt='你是上传照片的换背景工具选择器。当前只处理本条可信附件，未看到照片像素，不声称识别珠宝，不要求货号。用户要换背景且未说不生成时，调用 image_replace_background，requestedAction=preview；只要方案或先不生成用 plan。背景未指定可省略，使用默认中性背景。只换背景，不改商品、不换库封面、不发布；工具没返回图就不说已生成。';
function describe(result,job){
 if(job?.status==='preview_ready')return '本次上传图的换背景预览可查看。请用原图复核珠宝细节，未发布。';
 if(job?.status==='submission_unknown'||job?.status==='intent_recorded')return '图片提交结果尚未确认；只查原任务，未自动重试。';
 if(result?.status==='planned')return '已列出本次上传图的换背景方案，未提交生成。';
 if(result?.status==='generation_disabled')return '换背景方案已准备，当前未开放生成，未提交。';
 if(result?.code||job?.status==='failed')return '本次换背景未完成，未取得新的预览。';
 return '模型本次未选择换背景工具，未提交生成。';
}
export async function runUploadedImageAgent(context,{workflow,apiKey,model='deepseek-chat',fetchImpl}){
 const photo=context.photos?.[0];
 const definition=workflow.definitions.find(d=>d.type==='function'&&d.function?.name===imageToolName)?.function;
 if(!apiKey||!definition||context.photos?.length!==1)return {reply:'上传图换背景工具暂未连接；本条未提交生成。'};
 let called=false,receipt,job,result;
 const adapter=tool({name:imageToolName,description:definition.description,parameters:definition.parameters,strict:false,errorFunction:null,execute:async args=>{
   if(called)return {code:'IMAGE_TOOL_ALREADY_CALLED'};
   called=true;
   if(args.photoId!==undefined&&args.photoId!==photo.photoId)return {code:'IMAGE_UPLOAD_SOURCE_UNAUTHORIZED'};
   const raw=await workflow.execute(imageToolName,args,context), output=raw.result||{};
   job=publicJob(output.job,photo.sha256);
   const pin=publicPin(output.plan,photo.sha256);
   const plan=pin&&['planned','generation_disabled'].includes(output.status)?{...pin,status:output.status,requestedAction:'plan_only'}:null;
   const code=safeCode(output.code)||'IMAGE_UPLOAD_WORKFLOW_FAILED';
   const safe=job?{status:job.status,job}:plan?{status:output.status,plan}:{code};
   receipt={tool:imageToolName,status:job||plan?'completed':'failed',result:safe,
    ...(/^style-image-[a-f0-9-]{36}$/.test(raw.receiptId||'')?{receiptId:raw.receiptId}:{})};
   return job?{status:job.status}:plan?{status:plan.status}:{code};
 }});
 const client=new OpenAI({apiKey,baseURL:'https://api.deepseek.com',maxRetries:0,timeout:45000,...(fetchImpl?{fetch:fetchImpl}:{})});
 const agent=new Agent({name:'UploadedImageBackground',instructions:prompt,model:new OpenAIChatCompletionsModel(client,model),
  modelSettings:{temperature:0,parallelToolCalls:false,providerData:{thinking:{type:'disabled'}}},tools:[adapter],
  toolUseBehavior:{stopAtToolNames:[imageToolName]}});
 try{
  result=await new Runner({tracingDisabled:true,traceIncludeSensitiveData:false}).run(agent,
   '本条可信附件 ID：'+photo.photoId+'（仅元数据）\n店主原话：'+context.userText,{maxTurns:3});
 }catch(e){
  if(called&&!receipt)throw e;
 }
 const marker=result?.lastResponseId;
 return {runtime:'openai_agents_sdk',mode:'deepseek',model,routeRequestId:typeof marker==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(marker)?marker:null,
  ...(receipt?{tool:receipt.tool}:{}),receipts:receipt?[receipt]:[],reply:describe(receipt?.result,job),...(job?{job}:{})};
}
