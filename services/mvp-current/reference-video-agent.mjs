import {Agent, Runner, tool, setTracingDisabled, setTraceProcessors, OpenAIChatCompletionsModel} from '@openai/agents';
import OpenAI from 'openai';
import {referenceVideoIntent} from './message-photos.mjs';

setTracingDisabled(true);
setTraceProcessors([]);
const search='content_video_search_reference', plan='content_video_plan', make='content_video_make', status='content_video_status';
const legal=new Set([search,plan,make,status]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const token=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const textValue=(x,n=160)=>typeof x==='string'&&!/[<>/\\\x00-\x1f]|(?:authorization|bearer|data):/i.test(x)?x.slice(0,n):undefined;
const identifier=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)?x:null;

function safeJob(j){
 if(!j||typeof j.id!=='string'||!uuid.test(j.id)||!['unknown','processing','ready','failed'].includes(j.status))return;
 const hasMedia=j.status==='ready'&&j.mediaUrl==='/style-video/media/'+j.id;
 return {id:j.id,status:j.status,name:textValue(j.name)||'商品视频',reused:j.reused===true,aiGenerated:j.aiGenerated!==false,
   warning:textValue(j.warning,300)||'AI合成效果参考；商品细节以实物为准。',
   statusUrl:'/style-video/status/'+j.id,...(hasMedia?{mediaUrl:j.mediaUrl}:{})};
}
function project(name,receipt){
 const r=receipt?.result||{},p=r.plan||r, result={};
 const receiptId=typeof receipt?.receiptId==='string'&&/^style-video-[0-9a-f-]{36}$/.test(receipt.receiptId)?receipt.receiptId:null;
 const base={tool:name,...(receiptId?{receiptId}:{})};
 if(receipt?.status!=='completed')return {...base,status:'failed',result:{code:/^(VIDEO|REFERENCE)_[A-Z0-9_]{1,100}$/.test(r.code||'')?r.code:'REFERENCE_TOOL_REJECTED'}};
 if(name===search)result.references=(Array.isArray(r.references)?r.references:[]).filter(x=>token(x?.referenceId)).slice(0,12).map(x=>({
   referenceId:x.referenceId,name:textValue(x.name)||'已登记参考',durationSeconds:Number.isFinite(x.durationSeconds)?x.durationSeconds:null,
   ...(Array.isArray(x.tags)?{tags:x.tags.map(v=>textValue(v,36)).filter(Boolean).slice(0,8)}:{})
 }));
 if(name===plan){
   const planId=p.planId||p.id;
   if(token(planId)&&token(p.photoId)&&token(p.referenceId))
    result.plan={planId,photoId:p.photoId,referenceId:p.referenceId,name:textValue(p.name)||'商品视频',willGenerate:false,reusable:p.reusable===true,
      ...(typeof p.ruleVersion==='string'&&/^[a-z][a-z0-9-]{1,63}$/.test(p.ruleVersion)?{ruleVersion:p.ruleVersion}:{})};
 }
 if(name===make||name===status)result.job=safeJob(r.job);
 return {...base,status:'completed',result};
}
function replyFor(job,last,authorized){
 if(job?.status==='ready'&&job.mediaUrl)return job.reused?'已复用同图、同参考的已有顾客成片，未新生成。':'顾客视频已完成，可打开单条 MP4。';
 if(job?.status==='processing')return '视频任务已建立，尚未完成；请查看状态。';
 if(job?.status==='unknown')return '视频任务结果暂不明确，未自动重试。';
 if(job?.status==='failed')return '视频任务失败，未自动重试。';
 if(last?.status==='failed'){
   const code=last.result?.code;
   if(/BUDGET/.test(code||''))return '本轮新生成额度不可用；未重复提交。';
   if(/DISABLED|NOT_ENABLED|FORBIDDEN/.test(code||''))return '新视频生成未开放；未提交新生成。';
   return '风格视频工具未完成；请核对本件照片及已登记参考。';
 }
 if(last?.result?.plan)return authorized?'已准备参考视频方案，但未发起制作或取回成片；当前没有可播放视频。':'已准备参考视频方案；本次未提交制作。';
 if(last?.result?.references?.length)return '已查询已登记参考；本次未提交制作。';
 if(last?.tool===search)return '暂未找到匹配的已登记参考；本次未提交制作。';
 return '尚未取得有效的风格视频工具回执；请明确要查参考、列方案还是制作。';
}
const instructions=[
 '处理店主照片的参考视频。只查已登记素材元数据；没有收到照片像素，不宣称视觉识别。先搜索，再用本条绑定的附件ID和搜索命中的参考ID制定方案。',
 '成功方案的 nextAction 是本轮下一步。若是 content_video_make，表示店主原话已明确要成片，不再求确认；先实际调用该工具并传方案返回的同一个 planId，再答复。reusable=true 仅表示可能复用，仍须调用 content_video_make 取回成片；没有工具返回的作品，就没有可播放视频。',
 '若 nextAction 是 reply_with_plan，仅答复方案；不制作。资料不齐或工具拒绝时按真实回执说明。品名仅用明示品名或中性品类，不推断价格材质；保原参考节奏和BGM，仅商品名、无旁白无内部货号。已有任务可用状态工具，不重复提交、不外发。'
].join('\n');
const workflowDescriptions={
 [plan]:'准备本件参考视频方案，本工具只生成方案凭据，不会提交视频制作。按返回的 nextAction 完成本轮。',
 [make]:'使用本轮方案的 planId 取回同图同参考的已有成片；没有旧片时由服务端按授权和额度决定是否发起制作。方案本身不是成片。'
};

export async function runReferenceVideoAgent(context,{workflow,apiKey,model='deepseek-chat',fetchImpl}){
 if(!apiKey)return {reply:'视频模型暂未连接，未提交新视频。'};
 if(!workflow?.execute||!Array.isArray(workflow?.definitions)||context.photos?.length!==1)throw Error('REFERENCE_WORKFLOW_CONTEXT_INVALID');
 const definitions=workflow.definitions.filter(d=>d.type==='function'&&legal.has(d.function?.name));
 if(new Set(definitions.map(x=>x.function.name)).size!==4||definitions.length!==4)throw Error('REFERENCE_WORKFLOW_TOOL_SCHEMA_INVALID');
 const photo=context.photos[0];
 if(!token(photo.photoId))throw Error('REFERENCE_WORKFLOW_PHOTO_ID_INVALID');
 const authorized=referenceVideoIntent(context.userText)==='make';
 let receipt,job,chosenPlan,result,submitted=false;
 const receipts=[];
 const summary=()=>({runtime:'openai_agents_sdk',mode:'deepseek',model:identifier(model),
   routeRequestId:identifier(result?.lastResponseId),receipts});
 const registered=new Set();
 const tools=definitions.filter(d=>authorized||d.function.name!==make).map(({function:d})=>tool({
   name:d.name,description:workflowDescriptions[d.name]??d.description,parameters:d.parameters,strict:false,errorFunction:null,
   execute:async args=>{
     const n=d.name;
     if((n===plan&&(args.photoId!==photo.photoId||!registered.has(args.referenceId)))||
        (n===make&&(!authorized||submitted||!chosenPlan||args.planId!==chosenPlan))||
        (n===status&&!(typeof args.jobId==='string'&&uuid.test(args.jobId)))){
       receipt={tool:n,status:'failed',result:{code:'REFERENCE_TOOL_ARGUMENTS_OUT_OF_SCOPE'}};
       receipts.push(receipt);
       return receipt;
     }
     if(n===make)submitted=true;
     const out=await workflow.execute(n,args,context);
     receipt=project(n,out);
     if(n===search)for(const item of receipt.result.references||[])registered.add(item.referenceId);
     if(n===plan)chosenPlan=receipt.result.plan?.planId;
     if(n===make||n===status)job=receipt.result.job;
     receipts.push(receipt);
     if(n===plan&&receipt.result.plan){
       const {willGenerate,...modelPlan}=receipt.result.plan;
       return {...receipt,result:{plan:modelPlan,nextAction:authorized&&!submitted?make:'reply_with_plan'}};
     }
     if(!receipt.result.job)return receipt;
     const {statusUrl,mediaUrl,...modelJob}=receipt.result.job;
     return {...receipt,result:{...receipt.result,job:modelJob}};
   }
 }));
 const client=new OpenAI({apiKey,baseURL:'https://api.deepseek.com',timeout:45000,maxRetries:0,...(fetchImpl?{fetch:fetchImpl}:{})});
 const agent=new Agent({name:'ReferenceVideoAgent',instructions,model:new OpenAIChatCompletionsModel(client,model),
  modelSettings:{temperature:0,parallelToolCalls:false,providerData:{thinking:{type:'disabled'}}},
  tools,toolUseBehavior:{stopAtToolNames:[make,status]}});
 const runner=new Runner({tracingDisabled:true,traceIncludeSensitiveData:false});
 const label=textValue(photo.name||context.productName);
 const info={attachmentId:photo.photoId,...(label?{trustedName:label}:{}),makeAllowed:authorized};
 try{
  result=await runner.run(agent,'服务端已绑定照片元数据（不是视觉输入）：'+JSON.stringify(info)+'\n店主原话：'+context.userText,{maxTurns:6});
 }catch(e){
  if(submitted)return {...summary(),state:'uncertain',reply:'制作请求结果暂不明确，未自动重试。',...(job?{job}:{})};
  if(e?.name!=='ModelBehaviorError'&&e?.constructor?.name!=='ModelBehaviorError')throw e;
 }
 return {...summary(),reply:replyFor(job,receipt,authorized),...(job?{job}:{})};
}
