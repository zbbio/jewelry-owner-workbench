import { Agent, Runner, tool, setTracingDisabled, setTraceProcessors, OpenAIChatCompletionsModel } from '@openai/agents';
import OpenAI from 'openai';

// This application never exports customer prompts, tools or media to OpenAI tracing.
setTracingDisabled(true);
setTraceProcessors([]);

export const isVideoIntent = text => /视频|短片|成片|参考片|做片|(?:生成|制作).{0,12}片/.test(text || '') &&
  !(/列.{0,8}(?:三个|3个)?镜头/.test(text || '') && !/视频|短片|成片|方案/.test(text || ''));
const planOnly = text => /(?:先别|不要|别|先不|不再)\s*(?:(?:再|给我|马上|现在|开始|实际|真的|直接|急着)\s*){0,2}(?:生成|制作|做片|出片|做(?:个|一段|一个)?(?:视频|短片))|不(?:生成|制作)|不(?:做|制作|生成)[^，,。.!！？?;；\r\n]{0,3}(?:片|视频)|只[^，,。.!！？?;；\r\n]{0,8}(?:方案|计划|镜头)|先列[^，,。.!！？?;；\r\n]{0,8}(?:方案|计划|镜头)/.test(text);
const generationRequested = text => !planOnly(text) && text.split(/[，,。.!！？?;；\r\n]/).some(clause => /^(?:(?:请|帮我|给我|现在|直接|我要|我想)\s*)*(?:(?:用|把|为|沿用).{1,60})?(?:生成|制作|出片|做.{0,3}(?:视频|短片|样片)|换进)/.test(clause.trim()));
const selectionRequested = text => /选.{0,16}(?:一条|一件|另一)|换(?:一条|一件)|非\s*163|不是\s*163/.test(text);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const instructions = `你是本店珠宝短片助手，使用提供的真实业务工具完成普通指令，不编造商品、素材、计划、任务或作品。货号由用户原话判断并作为tool参数传入，数字163号对应DEMO163；后缀商品不可丢后缀，不默认所有视频都是163。
查询过去、已有、之前的片：调用video_find_existing，明确旧作品，不能说是本轮新制作。
用户要从商品卡选另一条、换一件或选非163且没有指定新商品时，先调用video_list_candidates（要求非163时excludeProductId为DEMO163），依据返回的真实商品卡候选自行选择符合圆珠单圈及颜色差异要求的productId，再plan、submit；不要让店主或开发者代选，不默认163，不编造货号。候选是商品卡元数据，不是你已经看图；只说按商品卡资料选择，不能说已视觉核实。候选工具willGenerate:false也只是本次查询只读，不是取消用户制作目标。
制作新短片：先video_plan_short读取真实商品与素材摘要，使用返回planId调用video_submit_short。plan回执willGenerate:false只说明这个计划工具本身不制作，不代表用户取消；generatable:false才表示当前不具备生成条件。计划本身不扣视频生成费；仅用户明确要求制作/生成时才提交；只列方案、先别做片、不要制作时绝不提交。资料缺失或工具失败如实说明，不编造成功。
提交后仅返回本地任务进度，后台自动取片，不要用模型循环查询；查询已有job进度最多调用一次video_get_status。
只支持这次已接通的4秒标准版，不扩长片，不发布/外发；AI合成不是实拍，隔片保真未通过仍明确提醒。所有回复依据tool回执。`;

function modelReceipt(receipt) {
  // Tool results contain local links only; signed remote URLs never enter model context.
  return JSON.parse(JSON.stringify(receipt, (_key,value) => typeof value==='string' && /^https?:\/\//i.test(value) ? '[remote URL omitted]' : value));
}
function publicJob(raw) {
  if (!raw || typeof raw!=='object' || typeof raw.id!=='string') return null;
  const fields=['id','status','origin','productId','title','progress','error','aiGenerated','separatorPassed','warning'];
  const job=Object.fromEntries(fields.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]]));
  if (typeof raw.watchUrl==='string' && /^\/video\/watch(?:[/?]|$)/.test(raw.watchUrl) && !/[<>"'\r\n]/.test(raw.watchUrl)) job.watchUrl=raw.watchUrl;
  return job;
}
function receiptJob(receipt) {
  const r=receipt?.result;
  return publicJob(r?.job || (r?.id?r:null) || r?.jobs?.[0]);
}
function replyForVideo(receipt, job, finalOutput) {
  if (!receipt) return escape(finalOutput || '本次没有执行视频工具。');
  if (receipt.status==='failed' || receipt.result?.status==='failed') return '本次视频操作未完成，请查看任务失败信息。';
  if (job) {
    const old=job.origin==='imported' || receipt.tool==='video_find_existing';
    const intro=old?'这是之前保存的旧作品，不是本轮新生成。':job.status==='ready'?'AI合成短片已保存。':job.status==='failed'?'短片任务失败。':'短片任务已交后台处理，页面会自动刷新进度，无需重复提交。';
    const warning=job.separatorPassed===false?'隔片位置保真未通过，不能当作实物一致性证明。':'AI合成效果不当作实拍。';
    return `${intro}\n商品：${escape(job.productId)}；状态：${escape(job.status)}。\n${warning}${job.status==='ready' && job.watchUrl?`\n<a class="album-result" href="${escape(job.watchUrl)}" target="_blank" rel="noopener">▶ 查看短片 →</a>`:''}`;
  }
  const plan=receipt.result?.plan || (receipt.result?.planId ? receipt.result : null);
  if (plan) return `已根据商品 ${escape(plan.product?.id || plan.productId)} 的真实资料列出短片方案，计划号 ${escape(plan.planId)}。\n本次只列方案，没有提交制作。`;
  if (receipt.tool==='video_find_existing') return '本店暂未查到符合条件的旧作品；本次没有制作新片。';
  return escape(finalOutput || '已返回视频工具回执。');
}

export async function runVideoAgent(text, {apiKey,model='deepseek-chat',videoService,videoFetch,requestId}={}) {
  if (!apiKey) return {mode:'deepseek',model,tool:null,receipt:null,reply:'视频模型尚未连接，本次没有创建任务。',routeRequestId:null,runtime:'openai_agents_sdk'};
  if (!videoService?.execute || !Array.isArray(videoService.definitions)) throw new Error('VIDEO_SERVICE_REQUIRED');
  const receipts=[];
  const allowed=new Set(['video_list_candidates','video_find_existing','video_plan_short','video_submit_short','video_get_status']);
  const tools=videoService.definitions.filter(d=>allowed.has(d.function?.name) && !(planOnly(text) && d.function.name==='video_submit_short')).map(({function:definition})=>tool({
    name:definition.name,description:definition.description,parameters:definition.parameters,strict:false,errorFunction:null,
    execute:async args=>{
      if(definition.name==='video_plan_short' && selectionRequested(text)){
        const listed=receipts.findLast(r=>r.tool==='video_list_candidates' && r.status==='completed');
        if(!listed?.result?.candidates?.some(c=>(c.productId||c.id)===args.productId))throw new Error('SELECT_FROM_RETURNED_CANDIDATES_REQUIRED');
      }
      const receipt=await videoService.execute(definition.name,args,{userText:text,requestId});
      receipts.push(receipt);
      return modelReceipt(receipt);
    },
  }));
  const client=new OpenAI({apiKey,baseURL:'https://api.deepseek.com',timeout:45_000,maxRetries:0,...(videoFetch?{fetch:videoFetch}:{})});
  const agent=new Agent({name:'JewelryVideoAgent',instructions,model:new OpenAIChatCompletionsModel(client,model),modelSettings:{temperature:0,parallelToolCalls:false,providerData:{thinking:{type:'disabled'}}},tools,toolUseBehavior:{stopAtToolNames:['video_submit_short','video_get_status']}});
  const runner=new Runner({tracingDisabled:true,traceIncludeSensitiveData:false});
  let result=await runner.run(agent,text,{maxTurns:6});
  const initialPlanReceipt=receipts.at(-1);
  const initialPlan=initialPlanReceipt?.result?.plan || initialPlanReceipt?.result;
  const listStopped=initialPlanReceipt?.tool==='video_list_candidates' && Array.isArray(initialPlan?.candidates) && initialPlan.candidates.length>0;
  const planStopped=initialPlanReceipt?.tool==='video_plan_short' && initialPlan?.planId && initialPlan.generatable!==false;
  const correctionTools=tools.filter(t=>t.name==='video_submit_short' || listStopped && t.name==='video_plan_short');
  const needsCorrection=generationRequested(text) && initialPlanReceipt?.status==='completed' && (planStopped||listStopped) && !receipts.some(r=>r.tool==='video_submit_short') && correctionTools.some(t=>t.name==='video_submit_short');
  if(needsCorrection){
    const next=listStopped?'候选查询；请自行从上面真实候选中按原要求选择productId，再调用video_plan_short取得计划，条件满足后选择video_submit_short':'计划 '+initialPlan.planId+'；条件满足时选择video_submit_short并使用该planId，不重新列计划';
    const correction=`执行状态核对：原始目标仍是当轮明确请求的短片制作，当前只完成了${next}，还没有提交。willGenerate:false 仅说明候选/计划工具只读，不是用户取消制作。若条件不满足，明确说明没有生成。只核对这一次，不重新查候选、不轮询进度、不发布。`;
    result=await runner.run(agent.clone({tools:correctionTools}),[...result.history,{role:'user',content:correction}],{maxTurns:listStopped?2:1,errorHandlers:{maxTurns:()=>({finalOutput:'本次没有提交生成，也未创建新视频任务。',includeInHistory:false})}});
  }
  const receipt=receipts.at(-1)||null;
  const videoJob=receiptJob(receipt);
  const incomplete=needsCorrection && !receipts.some(r=>r.tool==='video_submit_short');
  const listed=receipts.findLast(r=>r.tool==='video_list_candidates' && r.status==='completed');
  const plannedReceipt=receipts.findLast(r=>r.tool==='video_plan_short' && r.status==='completed');
  const planned=plannedReceipt?.result?.plan||plannedReceipt?.result;
  const chosen=listed?.result?.candidates?.find(c=>(c.productId||c.id)===(planned?.productId||planned?.product?.id));
  const selection=chosen?{productId:chosen.productId||chosen.id,sourceReceiptId:listed.receiptId,observation:listed.result.observation||'catalog_metadata_only',candidate:modelReceipt(chosen),excludedProductIds:listed.result.excludedProductIds||[],planId:planned.planId}:null;
  let reply=incomplete?'已读取商品候选或短片方案，但本次没有提交生成，也未创建新视频任务。':replyForVideo(receipt,videoJob,result.finalOutput);
  if(selection)reply+=`\n按商品卡资料选择：${escape(selection.productId)}，${escape(chosen.name)}，${escape(chosen.color)}。这是元数据选择，未做视觉识别。`;
  return {mode:'deepseek',model,runtime:'openai_agents_sdk',tool:receipt?.tool||null,receipt,receipts,reply,routeRequestId:result.lastResponseId||null,...(needsCorrection?{goalCorrectionAttempted:true}:{}),...(incomplete?{generationStatus:'not_submitted'}:{}),...(selection?{selection}:{}),...(videoJob?{videoJob}:{})};
}
