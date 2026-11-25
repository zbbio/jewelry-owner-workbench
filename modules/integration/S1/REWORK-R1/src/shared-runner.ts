import {createHash} from "node:crypto";
import {Agent, Runner, tool, OpenAIChatCompletionsModel, setSensitiveDataLoggingEnabled,
  setTracingDisabled, setTraceProcessors, type Model, type ModelRequest, type ModelResponse} from "@openai/agents";
import OpenAI from "openai";

// Same transport/SDK as N9; unlike N9 no tool is mandatory or selected by the host.
setTracingDisabled(true); setTraceProcessors([]); setSensitiveDataLoggingEnabled(false);
const base="https://api.deepseek.com", endpoint=base+"/chat/completions";
export const S1_VERSION="n99-s1-1.0.0";
export const TOOL_NAMES=["catalog_read_facts","content_find_existing"] as const;
type Name=typeof TOOL_NAMES[number];
const versions={catalog_read_facts:"catalog_read_facts/v1",content_find_existing:"n99.c1.v1"} as const;
const fields=["price","size","inventory","material","title","description"] as const;
type Field=typeof fields[number];
const id=(x:unknown):x is string=>typeof x==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const ver=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
const str=(x:unknown,max=200):x is string=>typeof x==="string"&&x.trim().length>0&&x.length<=max;
const record=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x:unknown,keys:readonly string[]):x is Record<string,unknown>=>record(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
const ids=["shopId","actorId","conversationId","messageId","runId","requestId"] as const;
export type Envelope=Record<typeof ids[number],string>;
type Ref={productId:string;productVersion:number};
export type Binding=Envelope&Ref;
export type Subject={state:"bound";productId:string;productVersion:number;source:"explicit-resolved"|"trusted-conversation-anchor"}|{state:"missing"|"ambiguous"|"stale"};
export type Turn=Envelope&{text:string;subject:Subject};
type Booked={binding:Binding;callId:string;toolVersion:string};
type Flags={catalog:boolean;content:boolean};
export type Ports={
  // Host authenticates the actor and verifies the message is immobilized in THIS conversation/run.
  // Called at entry, immediately before each upstream read and before returning display data.
  authorize:(turn:Readonly<Turn>)=>Promise<Flags|null>|Flags|null;
  readFacts?:(input:Readonly<Booked&{fields:readonly Field[]}>)=>Promise<unknown>|unknown;
  lookupExisting?:(input:Readonly<Booked&{workVersion:number|null}>)=>Promise<unknown>|unknown;
};
type Fact={field:Field;status:"recorded"|"unknown";value:string|null;source:string|null};
type Reply={status:"ok"|"not_found"|"unavailable"|"denied"|"stale";receiptId?:string;facts?:Fact[];
  workRef?:{workId:string;workVersion:number};retrievalStatus?:"playable"};
type Runtime={
  sdk:"@openai/agents";sdkVersion:"0.22.0";runnerVersion:string;mode:"disabled"|"http_fixture"|"provider";
  providerPathUsed:boolean;model:string|null;httpAttempts:number;modelResponses:number;
  providerResponseIdSha256:string[];availableTools:{name:Name;version:string}[];
  requestedTools:{name:Name;version:string;callId:string;step:number}[];
};
type Part=Reply&{name:Name;toolVersion:string;callId:string;productId:string;productVersion:number};
export type Policy={mode:"http_fixture"|"provider";modelId:string;open:(binding:Readonly<Binding>,text:string)=>Promise<{
  key:string;reserve:()=>AbortSignal|true|false}>};
class Halt extends Error{constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new Halt(code);};
function runtime():Runtime{return {sdk:"@openai/agents",sdkVersion:"0.22.0",runnerVersion:S1_VERSION,mode:"disabled",providerPathUsed:false,
  model:null,httpAttempts:0,modelResponses:0,providerResponseIdSha256:[],availableTools:[],requestedTools:[]};}
const scope=(t:Turn)=>Object.fromEntries(ids.map(k=>[k,t[k]])) as Envelope;
const names=(v:unknown):v is Name=>TOOL_NAMES.includes(v as Name);
const listFields=(x:unknown):x is Field[]=>Array.isArray(x)&&x.length>0&&x.length<=fields.length&&new Set(x).size===x.length&&x.every(y=>fields.includes(y as Field));
const sameBinding=(x:unknown,b:Binding)=>record(x)&&[...ids,"productId","productVersion"].every(k=>x[k as keyof Binding]===b[k as keyof Binding]);
const labels:Record<Field,string>={price:"售价",size:"尺寸",inventory:"库存",material:"材质",title:"名称",description:"商品说明"};
const descriptions={
  catalog_read_facts:"只读取本话题已核定的本件商品卡字段。用于明确要求的字段，例如价格/怎么卖用 price。只读所问字段；不找视频、不改卡。不确定要什么就澄清。",
  content_find_existing:"查找本话题已核定的本件商品此前拍好且获准的旧视频（不是照片）。查不到就是本件无可用旧片；不会生成、剪辑、建草稿、发布。只要报价或明确排除旧片时不调用。",
};
const instructions=[
 "你在单一珠宝店主对话中自主决定是否调用服务端提供的只读工具。不要依据代码做固定首调用；你可不调用、选一项、或对明确复合请求在同一响应并列选择两项。",
 "对象必须明确指向本次服务端已绑定的商品。若表达含糊（例如只说‘看看以前拍的’且未说是照片或视频，也无明确已给上下文），先澄清，不猜。另一件商品需重新明确，不能代换。",
 "按分句理解和同义词判断，只做明确要求且未被排除的事项‘不用讲售价’不要读价，‘不要新做’不妨碍找旧视频；‘要实拍照片’不是旧视频。只问价不查片，只找旧片不读价。拒绝一项不丢其他明确项。",
 "不要执行制作、草稿、发布或改资料。不要虚构金额、作品、库存或声明已播放。服务端将基于实际工具回执展示事实。",
 '最后只能输出 JSON {"kind":"answer"}、{"kind":"clarify"} 或 {"kind":"unsupported"}；不要发事实文字、号码、链接或 Markdown。'
].join("\n");
const clarification="请明确要查哪件商品，以及想看价格、商品资料，还是这件以前的视频。";
const unsupported="本次只支持读取本件商品资料或查本件旧视频；没有执行其他操作。";
const unavailable="本次服务未完成，请先查看原消息状态。";
const parseJSON=(x:unknown)=>{try{return typeof x==="string"&&x.length<6000?JSON.parse(x):null;}catch{return null;}};
type ToolArgs={fields:Field[];workVersion:number|null};
function argsFor(name:Name,args:unknown):ToolArgs{
  if(name==="catalog_read_facts"){
    if(!exact(args,["fields"])||!listFields(args.fields))return fail("TOOL_ARGUMENTS_INVALID");
    return {fields:[...args.fields],workVersion:null};
  }
  if(!exact(args,["workVersion"])||(args.workVersion!==null&&!ver(args.workVersion)))return fail("TOOL_ARGUMENTS_INVALID");
  return {fields:[],workVersion:args.workVersion};
}
function validateBusiness(name:Name,raw:unknown,b:Binding,callId:string,asked:ToolArgs):Reply{
  if(!record(raw)||!sameBinding(raw.binding,b)||raw.callId!==callId||!id(raw.receiptId))return fail("TOOL_RECEIPT_SCOPE_OR_VERSION");
  const receiptId=raw.receiptId;
  if(raw.status==="unavailable"||raw.status==="denied"||raw.status==="stale")return {status:raw.status,receiptId};
  if(name==="catalog_read_facts"){
    if(raw.status!=="ok"||!Array.isArray(raw.facts)||raw.facts.length!==asked.fields.length)return fail("CATALOG_RECEIPT_INVALID");
    const facts=asked.fields.map((field):Fact=>{
      const matching=(raw.facts as unknown[]).filter(x=>record(x)&&x.field===field);
      const f=matching[0];
      if(matching.length!==1||!record(f))return fail("CATALOG_RECEIPT_INVALID");
      if(f.status==="unknown"&&f.value===null)return {field,status:"unknown",value:null,source:null};
      if(f.status!=="recorded"||!str(f.value,500)||!str(f.source,160)||
        (field==="price"&&!/^\d{1,12}(?:\.\d{1,2})?$/.test(f.value)))return fail("CATALOG_RECEIPT_INVALID");
      return {field,status:"recorded",value:f.value,source:f.source};
    });
    return {status:"ok",receiptId,facts};
  }
  if(raw.status==="not_found")return {status:"not_found",receiptId};
  if(raw.status!=="ok"||raw.retrievalStatus!=="playable"||!record(raw.workRef)
    ||!id(raw.workRef.workId)||!ver(raw.workRef.workVersion)||(asked.workVersion!==null&&raw.workRef.workVersion!==asked.workVersion))return fail("CONTENT_RECEIPT_INVALID");
  return {status:"ok",receiptId,workRef:{workId:raw.workRef.workId,workVersion:raw.workRef.workVersion},retrievalStatus:"playable"};
}
function present(part:Part){
  if(part.status==="not_found")return "这件目前没有可播放的旧视频。";
  if(part.status==="denied")return "这项资料当前无权读取。";
  if(part.status==="stale")return "这件资料的版本已变化，请重新确认要查的商品。";
  if(part.status==="unavailable")return part.name==="catalog_read_facts"?"本件商品资料暂未读到。":"本件旧视频暂未查到结果。";
  if(part.facts)return part.facts.map(f=>!f.value?`${labels[f.field]}待核实`:`${labels[f.field]}：${f.value}${f.field==="price"?" 元":""}`).join("；")+"。";
  return "找到这件已获准播放的旧视频；点开才会播放。";
}
function finalKind(output:unknown){
  const x=parseJSON(output);if(exact(x,["kind"])&&(x.kind==="answer"||x.kind==="clarify"||x.kind==="unsupported"))return x.kind;
  return null;
}

export function makeSharedRunner(ports:Ports, policy?:Policy, httpFixture?:typeof fetch) {
  return async function run(t:Turn){
    const rt=runtime(), parts:Part[]=[];
    if(!t||!ids.every(k=>id(t[k])))return {status:"denied",code:"ENVELOPE_INVALID",text:"无法核对该条消息。",actions:[],runtime:rt};
    const envelope=scope(t);
    const result=(status:string,code:string,text:string,actions:Part[]=[])=>({...envelope,status,code,text,actions,runtime:rt});
    if(!str(t.text,1000)||/(?:sk-[a-z0-9_-]{12,}|-----BEGIN [^-]*PRIVATE KEY|data:(?:image|audio|video|application)\/|https?:\/\/)/i.test(t.text))
      return result("invalid","TEXT_ONLY","请只输入问题，不要粘贴凭据、链接或媒体数据。");
    // Snapshot before awaits. Only the host can supply authorization/subject; never parse a browser-supplied identity.
    const text=t.text.trim(), s=t.subject;
    if(!s||!["bound","missing","ambiguous","stale"].includes(s.state))return result("denied","SUBJECT_INVALID","商品引用无法核对。");
    const subject:Subject=s.state==="bound"?Object.freeze({state:s.state,productId:s.productId,productVersion:s.productVersion,source:s.source}):Object.freeze({state:s.state});
    const turn=Object.freeze({...envelope,text,subject});
    let flags:Flags|null;
    const check=async()=>{try{return await ports.authorize(turn);}catch{return null;}};
    flags=await check();
    if(!flags)return result("denied","SCOPE_DENIED","无权访问这条消息或商品。");
    if(subject.state!=="bound")return result("clarify",subject.state==="stale"?"SUBJECT_STALE":"SUBJECT_NEEDED",clarification);
    if(!id(subject.productId)||!ver(subject.productVersion)||!["explicit-resolved","trusted-conversation-anchor"].includes(subject.source))
      return result("denied","SUBJECT_INVALID","商品引用无法核对。");
    const b:Binding=Object.freeze({...envelope,productId:subject.productId,productVersion:subject.productVersion});
    const ready=(a:Flags,n:Name)=>n==="catalog_read_facts"?a.catalog===true&&typeof ports.readFacts==="function":a.content===true&&typeof ports.lookupExisting==="function";
    const enabled=TOOL_NAMES.filter(n=>ready(flags!,n));
    rt.availableTools=enabled.map(name=>({name,version:versions[name]}));
    if(!enabled.length)return result("unavailable","NO_READY_TOOLS","这条消息暂无有权可用的读取工具。");
    if(!policy)return result("unavailable","MODEL_DISABLED","模型未获准运行，本条没有查询。");
    if(policy.mode==="provider"&&enabled.length!==2)return result("unavailable","LIVE_REQUIRES_BOTH_TOOLS","双工具实测尚未就绪，本条没有调用模型。");
    rt.mode=policy.mode;rt.model=policy.modelId;
    const picked=new Map<Name,{callId:string;args:ToolArgs}>();
    const used=new Set<Name>();
    const tools=enabled.map(name=>{
      const catalog=name==="catalog_read_facts";
      const parameters={type:"object" as const,properties:catalog?{fields:{type:"array" as const,items:{type:"string",enum:[...fields]}}}:{workVersion:{type:["integer","null"],minimum:1}},
        required:catalog?["fields"]:["workVersion"],additionalProperties:false as const};
      return tool({name,description:descriptions[name],parameters,strict:true,errorFunction:null,
        execute:async(input:unknown)=>{
          const chosen=picked.get(name), asked=argsFor(name,input);
          if(!chosen||used.has(name)||JSON.stringify(chosen.args)!==JSON.stringify(asked))return fail("TOOL_CALL_MISMATCH");
          used.add(name);
          const callId=chosen.callId, booked=Object.freeze({binding:b,callId,toolVersion:versions[name]});
          let reply:Reply={status:"unavailable"};
          const current=await check();
          if(!current||!ready(current,name))reply={status:"denied"};
          else try{
            const raw=await (catalog?ports.readFacts!(Object.freeze({...booked,fields:Object.freeze([...asked.fields])})):ports.lookupExisting!(Object.freeze({...booked,workVersion:asked.workVersion})));
            reply=validateBusiness(name,raw,b,callId,asked);
          }catch(e){reply={status:e instanceof Halt&&e.code==="TOOL_RECEIPT_SCOPE_OR_VERSION"?"stale":"unavailable"};}
          parts.push({...reply,name,toolVersion:versions[name],callId,productId:b.productId,productVersion:b.productVersion});
          // Only status/field presence back to provider. Do not send card IDs, values, IDs or media access.
          return JSON.stringify({status:reply.status,...(reply.facts?{fields:reply.facts.map(f=>({field:f.field,status:f.status}))}:{})});
        }});
    });
    try{
      const admission=await policy.open(b,text);
      const client=new OpenAI({baseURL:base,apiKey:admission.key,organization:null,project:null,webhookSecret:null,
        maxRetries:0,timeout:25000,logLevel:"off",fetch:async(url,init)=>{
          if(String(url)!==endpoint||init?.method!=="POST"||typeof init.body!=="string")return fail("ENDPOINT_DENIED");
          const authorized=await check(); if(!authorized||!enabled.some(n=>ready(authorized,n)))return fail("SCOPE_REVOKED");
          const permit=admission.reserve();if(!permit)return fail("PROVIDER_ATTEMPT_NOT_APPROVED");
          rt.httpAttempts++;
          const signals=[...(init.signal?[init.signal]:[]),...(permit===true?[]:[permit])];
          const signal=signals.length?AbortSignal.any(signals):undefined;
          const transport=policy.mode==="http_fixture"?httpFixture!:globalThis.fetch;
          if(policy.mode==="provider")rt.providerPathUsed=true;
          return transport(endpoint,{method:"POST",body:init.body,signal,redirect:"error",
            headers:{"Content-Type":"application/json","Authorization":"Bearer "+admission.key}});
        }});
      const underlying=new OpenAIChatCompletionsModel(client,policy.modelId);
      const replyIds=new Set<string>();
      const selectionModel:Model={
        async getResponse(request:ModelRequest):Promise<ModelResponse>{
          const step=rt.modelResponses;
          if(step>1||(step===1&&(!picked.size||used.size!==picked.size)))return fail("MODEL_PROTOCOL");
          const response=await underlying.getResponse({...request,
            tools:step===0?request.tools.map(t=>t.type==="function"?{...t,strict:false}:t):[],
            modelSettings:{...request.modelSettings,toolChoice:step===0?"auto":undefined,maxTokens:400,
              providerData:{thinking:{type:"disabled"},...(step===1?{response_format:{type:"json_object"}}:{})}}});
          rt.modelResponses++;
          if(!response.responseId||!/^[a-zA-Z0-9._:-]{1,160}$/.test(response.responseId)||replyIds.has(response.responseId))
            return fail("MODEL_RECEIPT_INVALID");
          replyIds.add(response.responseId);rt.providerResponseIdSha256.push(sha256(response.responseId));
          if(response.providerData?.model!==policy.modelId||response.usage.totalTokens<=0)return fail("MODEL_RECEIPT_INVALID");
          const calls=response.output.filter(x=>x.type==="function_call");
          if(step!==0&&calls.length)return fail("MODEL_PROTOCOL");
          const batch=new Map<Name,{callId:string;args:ToolArgs}>();
          const batchIds=new Set<string>();
          for(const c of calls){
            if(!names(c.name)||!enabled.includes(c.name)||batch.has(c.name)||!id(c.callId)||batchIds.has(c.callId))
              return fail("TOOL_NOT_ALLOWED");
            batch.set(c.name,{callId:c.callId,args:argsFor(c.name,parseJSON(c.arguments))});batchIds.add(c.callId);
          }
          for(const [name,choice] of batch){
            picked.set(name,choice);rt.requestedTools.push({name,version:versions[name],step:step+1,callId:choice.callId});
          }
          return response;
        },
        async *getStreamedResponse():AsyncGenerator<never>{return fail("STREAM_NOT_ENABLED");}
      };
      const agent=new Agent({name:"店主助手｜S1只读",instructions,model:selectionModel,tools,
        modelSettings:{toolChoice:"auto",parallelToolCalls:true,retry:{maxRetries:0}},resetToolChoice:true});
      const runner=new Runner({model:selectionModel,modelProvider:{getModel:async()=>fail("MODEL_FALLBACK_DENIED")},
        tracingDisabled:true,traceIncludeSensitiveData:false});
      const r=await runner.run(agent,text,{maxTurns:2,signal:AbortSignal.timeout(54000)});
      const kind=finalKind(r.finalOutput);
      if(!kind||used.size!==picked.size)return fail("MODEL_REPLY_INVALID");
      // Permissions can change during the second model response. Never show an old unapproved playback grant.
      const final=await check();
      if(!final)return result("denied","SCOPE_REVOKED","该条消息的权限已变化。");
      const filtered=parts.map(p=>ready(final,p.name)?p:{name:p.name,toolVersion:p.toolVersion,callId:p.callId,productId:p.productId,productVersion:p.productVersion,status:"denied" as const});
      if(!filtered.length)return kind==="unsupported"?result("unsupported","MODEL_UNSUPPORTED",unsupported):result("clarify","MODEL_CLARIFY",clarification);
      const successful=filtered.filter(p=>p.status==="ok"||p.status==="not_found").length;
      const status=successful===filtered.length?(kind==="clarify"?"partial":"completed"):successful?"partial":"unavailable";
      return result(status,kind==="clarify"?"FOLLOWUP_CLARIFY":status==="completed"?"OK":"TOOL_PARTIAL_OR_UNAVAILABLE",
        filtered.map(present).join(" ")+(kind==="clarify"?" "+clarification:""),filtered);
    }catch(e){
      const final=await check();
      if(!final)return result("denied","SCOPE_REVOKED","该条消息的权限已变化。");
      const confirmed=parts.filter(p=>ready(final,p.name)&&(p.status==="ok"||p.status==="not_found"));
      const code=e instanceof Halt?e.code:"PROVIDER_OR_SDK_FAILED";
      return result(confirmed.length?"partial":"unavailable",code,
        confirmed.length?confirmed.map(present).join(" ")+" 其余结果未完成。":unavailable,confirmed);
    }
  };
}
// No system environment read, SDK runs exactly the same HTTP serialization on an isolated transport.
export function createS1FixtureRunner(ports:Ports,httpFixture:typeof fetch){
  if(typeof httpFixture!=="function")throw new TypeError("fixture transport required");
  return makeSharedRunner(ports,{mode:"http_fixture",modelId:"deepseek-flash",open:async()=>{
    let left=2;return {key:"fixture-only-not-a-secret",reserve:()=>left-->0};
  }},httpFixture);
}
