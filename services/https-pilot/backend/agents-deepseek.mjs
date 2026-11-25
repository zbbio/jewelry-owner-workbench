import { Agent, Runner, tool, OpenAIChatCompletionsModel, setSensitiveDataLoggingEnabled, setTracingDisabled, setTraceProcessors } from "@openai/agents";
import OpenAI from "openai";
// Remote generations are never traced/exported. SDK and HTTP-client debugging must not log prompts.
setTracingDisabled(true);
setTraceProcessors([]);
setSensitiveDataLoggingEnabled(false);
const base = "https://api.deepseek.com";
const endpoint = base + "/chat/completions";
const allowedModels = new Set(["deepseek-flash", "deepseek-v4-pro"]);
const toolName = "read_selected_jewelry_card";
function freshRuntime() {
    return { sdk: "@openai/agents", version: "0.22.0", offline: false, live: false, model: null,
        providerModels: [], responseIds: [], modelTurns: 0, httpAttempts: 0,
        toolCalls: [], toolReceipts: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        replySource: "local-clarification" };
}
export class TurnError extends Error {
    status;
    code;
    runtime;
    constructor(status, code, message, runtime) {
        super(message);
        this.status = status;
        this.code = code;
        this.runtime = runtime;
    }
}
function providerFailure(err, rt) {
    if (err instanceof TurnError)
        return err;
    // Never pass through raw client or provider errors: they may contain input/headers.
    const e = err;
    const fallback = (status, code, msg) => new TurnError(status, code, msg, rt);
    if (e.status === 401 || e.status === 403)
        return fallback(502, "PROVIDER_AUTH", "模型服务未通过身份校验，请在后端检查凭据。");
    if (e.status === 402)
        return fallback(502, "PROVIDER_BALANCE", "模型服务返回余额不足，本次没有完成回答。");
    if (e.status === 429)
        return fallback(429, "PROVIDER_RATE_LIMIT", "模型服务当前限流，请稍后再试。");
    if (e.status === 408 || /timeout|abort/i.test(e.name ?? ""))
        return fallback(504, "PROVIDER_TIMEOUT", "模型请求超时，本次没有完成回答。");
    if (typeof e.status === "number")
        return fallback(502, "PROVIDER_HTTP_" + e.status, "模型服务未接受或未完成这次请求。");
    return fallback(502, "MODEL_REQUEST_FAILED", "这次模型联络或工具结果校验没有完成，请稍后再试。");
}
const instructions = [
    "你是珠宝店主的只读问答助手。只处理本次选择的商品，勿依据用户声称的数据推断事实，勿执行操作。",
    "第一步调用无参数 read_selected_jewelry_card 一次。根据用户问的是哪几项和工具回传，只返回一个 JSON 对象，不要 Markdown。",
    '答本件时输出 {"kind":"facts","fields":["price"]}。fields 只取 price（售价）、size（尺寸）、inventory（库存），按用户问题选择，可多选；通问三项全选。缺数据也照选，由界面明确显示待核实。',
    '若用户要问别件或要求切换店铺/商品，输出 {"kind":"switch","fields":[]}。未支持的操作或其余字段输出 {"kind":"unsupported","fields":[]}。',
    "不得输出价格数值、说明文字、ID 或额外键；卡片事实将在店主端按已核工具回执呈现。"
].join("\n");
function parseFields(output, rt) {
    const invalid = () => new TurnError(502, "MODEL_FORMAT", "收到的模型回答没有通过商品事实格式校验。", rt);
    if (typeof output !== "string" || output.length > 900)
        throw invalid();
    let o;
    try {
        o = JSON.parse(output);
    }
    catch {
        throw invalid();
    }
    if (!o || typeof o !== "object" || Object.keys(o).sort().join(",") !== "fields,kind" ||
        !["facts", "switch", "unsupported"].includes(o.kind) || !Array.isArray(o.fields) ||
        o.fields.length > 3 || (o.kind === "facts") !== (o.fields.length > 0) ||
        new Set(o.fields).size !== o.fields.length || o.fields.some((k) => !["price", "size", "inventory"].includes(k)))
        throw invalid();
    return o;
}
function render(f, fields) {
    const evidence = [], phrases = [];
    for (const field of fields) {
        let label, value, phrase;
        if (field === "price") {
            label = "售价";
            value = f.priceText === null ? "待核实" : f.priceText + " 元";
            phrase = f.priceText === null ? "卡上没有填写售价，价格待店主核实" : "卡上记录的售价是 " + value;
        }
        else if (field === "size") {
            label = "尺寸";
            value = f.size ?? "待核实";
            phrase = f.size === null ? "卡上没有填写尺寸，需核实" : "卡上记录的尺寸是 " + value;
        }
        else {
            label = "库存";
            value = "待核实";
            phrase = "库存还没有核实，暂不承诺现货";
        }
        evidence.push({ productId: f.productId, label, value });
        phrases.push(phrase);
    }
    return { evidence, text: "商品卡 " + f.productId + "：" + phrases.join("；") + "。" };
}
export function makeTurnService(catalog, {getApiKey=()=>null, modelId='deepseek-flash'}={}) {
    return async function perform(turn) {
        const rt = freshRuntime();
        const local = (text) => ({ text, productId: turn.productId, evidence: [], runtime: rt });
        const productId = turn.productId;
        if (productId === null)
            return local("请先选择一张商品卡，再问我这一件的价格、尺寸或库存。");
        // Explicit cross-reference is not permission to switch the selection.
        const other = productId === "A" ? "B" : "A";
        if (new RegExp("(?:卡|商品|样品)\\s*" + other + "(?![A-Za-z])|(?:^|[^A-Za-z])" + other + "\\s*(?:卡|这件|多少钱|的价格)", "i").test(turn.text)) {
            return local("当前选中商品卡 " + productId + "。请先切换到你想问的那件，再问我。");
        }
        if (/(?:sk-[a-z0-9_-]{12,}|-----BEGIN [^-]*PRIVATE KEY|data:(?:image|audio|video|application)\/|https?:\/\/)/i.test(turn.text)) {
            throw new TurnError(400, "TEXT_ONLY", "请只输入本件的问题，勿粘贴密钥、链接或媒体数据。", rt);
        }
        const key = getApiKey();
        if (!key)
            throw new TurnError(503, "MODEL_NOT_CONFIGURED", "服务端尚未配置 DeepSeek API 密钥。本次没有调用模型，也没有给出报价。", rt);
        if (!allowedModels.has(modelId))
            throw new TurnError(503, "MODEL_CONFIG_INVALID", "服务端选择的模型不在本次联测清单中。", rt);
        rt.model = modelId;
        rt.replySource = "not-completed";
        // The final outbound transport only forwards the DeepSeek authorization and JSON content-type;
        // SDK organization, project, debug, beta or tracing environment variables never reach this host.
        const client = new OpenAI({ baseURL: base, apiKey: key, organization: null, project: null, webhookSecret: null,
            maxRetries: 0, timeout: 25000, logLevel: "off", fetch: async (url, init) => {
                if (String(url) !== endpoint || init?.method !== "POST" || typeof init.body !== "string")
                    throw new Error("ENDPOINT_DENIED");
                rt.httpAttempts++;
                return globalThis.fetch(endpoint, { method: "POST", body: init.body, signal: init.signal,
                    redirect: "error", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key } });
            } });
        const underlying = new OpenAIChatCompletionsModel(client, modelId);
        const facts = [];
        const badProtocol = () => new TurnError(502, "MODEL_PROTOCOL", "模型未按顺序完成当前商品的只读查卡，本次没有给出回答。", rt);
        const model = {
            async getResponse(request) {
                const step = rt.modelTurns;
                if (step > 1 || (step === 1 && facts.length !== 1))
                    throw badProtocol();
                const ms = request.modelSettings;
                const r = await underlying.getResponse({ ...request, tools: step === 0 ? request.tools.map(t => t.type === "function" ? { ...t, strict: false } : t) : [],
                    modelSettings: { ...ms, toolChoice: step === 0 ? toolName : undefined, maxTokens: 220,
                        providerData: { thinking: { type: "disabled" }, ...(step === 1 ? { response_format: { type: "json_object" } } : {}) } } });
                rt.modelTurns++;
                if (r.responseId && /^[a-zA-Z0-9._:-]{1,160}$/.test(r.responseId))
                    rt.responseIds.push(r.responseId);
                const m = r.providerData?.model;
                if (typeof m === "string" && /^[a-zA-Z0-9._:/-]{1,160}$/.test(m))
                    rt.providerModels.push(m);
                rt.usage.inputTokens += r.usage.inputTokens;
                rt.usage.outputTokens += r.usage.outputTokens;
                rt.usage.totalTokens += r.usage.totalTokens;
                if (step === 0) {
                    const calls = r.output.filter(x => x.type === "function_call");
                    if (calls.length !== 1 || calls[0].name !== toolName || typeof calls[0].arguments !== "string")
                        throw badProtocol();
                    let args;
                    try {
                        args = JSON.parse(calls[0].arguments);
                    }
                    catch {
                        throw badProtocol();
                    }
                    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0)
                        throw badProtocol();
                }
                else if (r.output.some(x => x.type === "function_call"))
                    throw badProtocol();
                return r;
            },
            async *getStreamedResponse() { throw badProtocol(); }
        };
        const readCard = tool({ name: toolName, description: "读取服务端已选中的本店商品。没有参数；不可选择或覆盖店铺及商品。", strict: true,
            parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, errorFunction: null,
            execute: async () => {
                if (facts.length)
                    throw badProtocol();
                const f = catalog.read(productId);
                if (f.productId !== productId)
                    throw badProtocol();
                facts.push(f);
                rt.toolCalls.push(toolName);
                rt.toolReceipts.push({ name: toolName, productId: f.productId, cardId: f.cardId, version: f.version });
                // Only whitelist these facts for this model call. Never send internal UUIDs, media, local paths,
                // source history, session credentials, other goods, or other conversations.
                return JSON.stringify({ selected: f.productId, priceYuan: f.priceText, size: f.size, inventory: "未核实" });
            } });
        const agent = new Agent({ name: "店主只读查卡", instructions: instructions + "\n当前选中商品卡 " + productId + "。", model, tools: [readCard],
            modelSettings: { retry: { maxRetries: 0 } } });
        const runner = new Runner({ model, modelProvider: { getModel: async () => { throw badProtocol(); } }, tracingDisabled: true, traceIncludeSensitiveData: false });
        try {
            const result = await runner.run(agent, turn.text, { maxTurns: 2, signal: AbortSignal.timeout(52000) });
            if (facts.length !== 1 || rt.modelTurns !== 2 || rt.responseIds.length !== 2 || rt.providerModels.length !== 2 || rt.usage.totalTokens <= 0)
                throw badProtocol();
            const decision = parseFields(result.finalOutput, rt);
            rt.live = true;
            rt.replySource = "deepseek-field-selection+verified-tool-facts";
            if (decision.kind === "switch")
                return local("你问到的不是当前这件。请先切换到要询问的商品卡。");
            if (decision.kind === "unsupported")
                return local("当前只支持查询本件卡上记录的售价、尺寸和库存；没有执行其他操作。");
            return { ...render(facts[0], decision.fields), productId, runtime: rt };
        }
        catch (e) {
            throw providerFailure(e, rt);
        }
    };
}
