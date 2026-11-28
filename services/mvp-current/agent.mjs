import { executeTool, executeToolAsync, inferFixtureTool, toolDefinitions } from "./tools.mjs";
import { salesDefinition, makeSalesDraft, requestedSkus } from "./sales.mjs";
import { isAlbumIntent,isCatalogIntent } from "./album-intent.mjs";
import { isVideoIntent, runVideoAgent } from "./video-agent.mjs";
import {runReferenceVideoAgent} from './reference-video-agent.mjs';
import {isImageBackgroundIntent,runImageBackgroundAgent} from "./image-background-agent.mjs";

const endpoint = "https://api.deepseek.com/chat/completions";
const chooseTool = `客服问价、材质、形态、保养、证书或售后均调 sales_prepare_reply，不选择商品卡写入。买家没收到证书是 missing_certificate；问本件是否附证是 certificate；真假/处理是 authenticity，气味是 scent，轻重是 lightness，纹路或坑洞是 surface；要拍摄佩戴效果或列镜头用 content。用户未明确发出整理或批量建卡指令，禁止选 album 或批量建卡。`;
const liveTools = toolDefinitions.map(t => t.function.name === "sales_prepare_reply" ? salesDefinition : t);
const system = "你是珠宝店主助手。根据店主指令选择四个工具之一。销售只生成草稿不发送；内容只列镜头不制作；相册不修改原图；商品卡保存演示草稿。在线运行时，相册整理工具直接扫描图片并用 DeepSeek 视觉分类，只在完整成功时发布新分类，失败保留上一批；不要要求店主选择另一个视觉按钮。工具结果必须原样依据。";

const albumTool="album_classify_batch";
const albumClarification=(mode,model)=>({mode,tool:null,receipt:null,reply:"请明确只整理哪批照片。",model,albumJobCode:"needs_clarification"});
function fixture(text) {
  const [name,args]=inferFixtureTool(text);
  if(name===albumTool&&!isAlbumIntent(text)){const {albumJobCode,...out}=albumClarification("fixture");return out;}
  const receipt=executeTool(name,args);
  return {mode:"fixture",tool:name,receipt,reply:replyFor(name,receipt)};
}
export function replyFor(name, receipt) {
  const r = receipt.result;
  if (name === "album_classify_batch" && r.publishStatus === "not_published") return r.retainedPrevious?"本次相册整理未完成，已保留上一批结果。":"本次相册整理未完成，没有发布新结果。";
  if (name === "catalog_create_or_read_card" && r.status === "requires_album") return "还没有与现有货号资料完整匹配的分类批次，本次未改商品卡。";
  if (name === "catalog_create_or_read_card" && r.classificationSource === "album_snapshot") return `已为 ${r.total} 张既有商品卡草稿同步本批分类，没有重新识图，商品资料保持原样。`;
  if (name === "album_classify_batch") { const groupCount = Array.isArray(r.groups) ? r.groups.length : Object.keys(r.groups || {}).length; return `照片已经整理好了，共 ${r.total} 张、${groupCount} 个分类。原照片保持不变。${r.classificationMode === "deepseek_vision" ? "" : "\n本次为离线演示回执。"}\n<a class="album-result" href="/gallery" target="_blank" rel="noopener">📷 查看分好的照片 →</a>\n点开分类，就能看到里面的照片。`; }
  if (name === "catalog_create_or_read_card" && r.classificationMode === "deepseek_vision") return `商品卡已生成，共 ${r.total} 张草稿。\n<a class="album-result" href="/catalog" target="_blank" rel="noopener">🛍 查看商品卡 →</a>\n点开就能看图片、价格、颜色和详细资料。`;
  if (name === "catalog_create_or_read_card") return `已生成${r.card.id}号商品卡演示草稿：${r.card.name}，售价 ${r.card.price}，尺寸 ${r.card.size}。`;
  if (name === "sales_prepare_reply") return r.draft;
  return `已列出三个镜头：\n1. ${r.shots[0]}\n2. ${r.shots[1]}\n3. ${r.shots[2]}\n本次不制作视频。`;
}

export function createDeepSeekCompletion(apiKey,model){
  const complete = async (messages, extra) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, ...extra, temperature: 0 }), signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    return response.json();
  };
  return complete;
}

export async function runAgent(text, { apiKey = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_MODEL || "deepseek-chat", fixtureMode = process.env.MVP_FIXTURE === "1", albumOnly=false,catalogOnly=false,catalogBatch, videoService, videoFetch, imageService, imageContext, imageFetch, requestId, referenceVideoContext, referenceVideoWorkflow, referenceVideoFetch } = {}) {
  if(!albumOnly&&!catalogOnly&&referenceVideoContext&&referenceVideoWorkflow) return runReferenceVideoAgent(referenceVideoContext,{apiKey:fixtureMode?null:apiKey,model,workflow:referenceVideoWorkflow,fetchImpl:referenceVideoFetch});
  if(!albumOnly&&!catalogOnly&&isImageBackgroundIntent(text)) return runImageBackgroundAgent(text,{apiKey:fixtureMode?null:apiKey,model,imageService,imageContext,imageFetch,requestId});
  if(videoService&&!albumOnly&&!catalogOnly&&isVideoIntent(text)) return runVideoAgent(text,{apiKey:fixtureMode?null:apiKey,model,videoService,videoFetch,requestId});
  if(catalogOnly){
    const name="catalog_create_or_read_card";
    const recovered=text===undefined&&catalogBatch;
    if(albumOnly||(!recovered&&!isCatalogIntent(text))||!catalogBatch)
      return {mode:"catalog_snapshot",tool:null,receipt:null,reply:"请明确同步哪批已完成相册分类。"};
    const receipt=await executeToolAsync(name,{mode:"vision",expectedAlbum:catalogBatch});
    return {mode:"catalog_snapshot",tool:name,receipt,reply:replyFor(name,receipt)};
  }
  if(albumOnly&&!isAlbumIntent(text))return albumClarification("deepseek",model);
  if(albumOnly&&(fixtureMode||!apiKey))throw Error("ALBUM_ROUTER_UNAVAILABLE");
  if (fixtureMode || !apiKey) return fixture(text);
  const complete = createDeepSeekCompletion(apiKey,model);
  const messages = [{ role: "system", content: system + (albumOnly?"本请求只允许选择相册整理；若不明确，不调用工具。":"") + chooseTool }, { role: "user", content: text }];
  const data = await complete(messages, { tools: albumOnly?liveTools.filter(t=>t.function.name===albumTool):liveTools, tool_choice: "auto" });
  const msg = data.choices?.[0]?.message; const call = msg?.tool_calls?.[0];
  if(albumOnly&&(msg?.refusal||msg?.tool_calls?.length!==1||call?.function?.name!==albumTool))
    return albumClarification("deepseek",model);
  if (!call) return { mode: "deepseek", reply: msg?.content || "模型没有返回内容。", tool: null, receipt: null };
  let args;
  try{args=JSON.parse(call.function.arguments||"{}");}catch(e){if(!albumOnly)throw e;return albumClarification("deepseek",model);}
  if(albumOnly&&(!args||typeof args!=="object"||Array.isArray(args)||
    Object.keys(args).some(k=>k!=="mode")||(args.mode!==undefined&&!["vision","demo"].includes(args.mode))))
    return albumClarification("deepseek",model);
  const tool = call.function.name;
  if (tool === "album_classify_batch") {
    if (!isAlbumIntent(text)) return { mode:"deepseek", tool:null, receipt:null, reply:"请明确要整理的相册或照片批次。", model };
    args.mode = "vision";
  }
  if (tool === "catalog_create_or_read_card") {
    // Only the owned catalog task can publish classifications. The ordinary response stays synchronous.
    delete args.mode;
    if (args.mode !== "vision" && requestedSkus(text).length) return { mode:"deepseek", tool:null, receipt:null, reply:"请说明是要查商品资料，还是要起草一条客服回复。", model };
  }
  const receipt = tool === "sales_prepare_reply"
    ? await makeSalesDraft(text, args.topic, complete, id => executeTool("catalog_create_or_read_card", { productId:id }).result.card)
    : await executeToolAsync(tool, args);
  if (tool === "content_prepare_shooting_checklist" && !/(?:商品卡|测试店|演示)\s*[AB]/i.test(text)) {
    receipt.result.productId = null;
    receipt.result.reference = null;
  }
  return { mode: "deepseek", tool, receipt, reply: replyFor(tool, receipt), model, routeRequestId: data.id ?? null };
}
