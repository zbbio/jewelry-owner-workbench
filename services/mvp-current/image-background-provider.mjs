import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
export const ARK_IMAGE_MODEL='doubao-seedream-5-5-261028';
const endpoint='https://ark.cn-beijing.volces.com/api/v3/images/generations';
const byteLimit=30*1024*1024, responseLimit=44*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
const err=(code,{unknown=false,requestId=null,httpStatus=null,providerCode=null,providerParam=null}={})=>Object.assign(Error(code),{code,unknown,requestId,httpStatus,providerCode,providerParam});
const fail=(code,meta)=>{throw err(code,meta);};
export const ARK_IMAGE_OUTPUT_SIZE='2K';
const publicErrorCodes=new Set(['ModelNotOpen','MissingParameter','InvalidParameter','InvalidParameter.UnsupportedParameter',
 'InvalidParameter.InvalidFormat','InvalidImageURL','InvalidImageURL.InvalidFormat']);
const publicParams=new Set(['model','prompt','image','size','output_format','background','response_format','watermark','sequential_image_generation','layer_decomposition','stream','n']);
export const safeImageProviderCode=x=>publicErrorCodes.has(x)?x:null;
export const safeImageProviderParam=x=>publicParams.has(x)?x:null;
const privateDiagnostics=new WeakMap();
export const privateImageDiagnostic=error=>privateDiagnostics.get(error);
const tokenShape=/(?:sk-|ak-|ark-)[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi;
function protectRequestId(r,key){
 const id=r.headers?.get('x-request-id');
 if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)||id.includes(key))return null;
 return id.replace(tokenShape,'')===id?id:null;
}
function diagnostic(error,key){
 if(!error||Object.getPrototypeOf(error)!==Object.prototype)return null;
 const code=safeImageProviderCode(error.code), param=safeImageProviderParam(error.param);
 let message=null;
 if(error.message!==undefined){
   const raw=error.message;
   if(typeof raw!=='string'||raw.length>4096||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>{}]|ignore (?:all |previous )?instructions|system prompt|(?:https?|data|file)%3a|(?:request|请求)\s*(?:body|正文|载荷)/iu.test(raw))return null;
   let s=raw.split(key).join('[redacted]')
    .replace(/data:[^\s,]{1,120},[^\s;]+/gi,'[redacted]')
    .replace(/(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s;,]+/gi,'[redacted]')
    .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[redacted]')
    .replace(tokenShape,'[redacted]')
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*["']?(?:(?:bearer|basic|digest)\s+)?[^\s,;]+/giu,'[redacted]')
    .replace(/\bbasic\s+[^\s,;]+/giu,'[redacted]')
    .replace(/\b(?:authorization|bearer|(?:api|access|secret)[ _-]?key|token|password|account(?:[ _-]?id)?|tenant(?:[ _-]?id)?|user[ _-]?id|base64)\b\s*(?:[=:]\s*)?["']?[^\s,;]+|(?:账号|账户|密钥|密码|令牌)\s*[:=：]?\s*[^\s,;]+/giu,'[redacted]')
    .replace(/\b[A-Za-z0-9+/_=-]{24,}\b/g,'[redacted]')
    .replace(/\b[0-9]{7,}\b/g,'[redacted]');
   message=[...s.trim()].slice(0,360).join('')||null;
 }
 return code||param||message?{code,message,param}:null;
}

const probe=[
 'import io,json,sys,warnings',
 'from PIL import Image',
 'Image.MAX_IMAGE_PIXELS=36000000',
 'warnings.simplefilter("error",Image.DecompressionBombWarning)',
 'raw=sys.stdin.buffer.read()',
 'with Image.open(io.BytesIO(raw)) as im:',
 '    if getattr(im,"n_frames",1)!=1: raise ValueError("animated")',
 '    fmt,w,h=im.format,*im.size',
 '    if w*h>36000000: raise ValueError("pixels")',
 '    im.verify()',
 'with Image.open(io.BytesIO(raw)) as im:',
 '    im.load()',
 '    opaque=True if "A" not in im.getbands() and "transparency" not in im.info else im.convert("RGBA").getchannel("A").getextrema()==(255,255)',
 'print(json.dumps(dict(format=fmt,width=w,height=h,opaque=opaque)))'
].join('\n');
export function inspectImage(bytes,{python=process.platform==='win32'?'python':'python3'}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>byteLimit)fail('IMAGE_FORMAT_INVALID');
 const run=spawnSync(python,['-I','-B','-c',probe],{input:bytes,maxBuffer:16384,timeout:30000,encoding:'utf8',windowsHide:true});
 if(run.error)fail('IMAGE_DECODER_UNAVAILABLE');
 if(run.status!==0){
   if(/ModuleNotFoundError: No module named 'PIL'/.test(run.stderr??''))fail('IMAGE_DECODER_UNAVAILABLE');
   fail('IMAGE_FORMAT_INVALID');
 }
 try{return JSON.parse(run.stdout);}catch{fail('IMAGE_FORMAT_INVALID');}
}
const mimeFormats={'image/jpeg':'JPEG','image/png':'PNG','image/webp':'WEBP'};
const validCount=n=>Number.isSafeInteger(n)&&n>=0;
function checkedUsage(data){
 const u=data?.usage;
 if(!u||typeof u!=='object'||Array.isArray(u)||u.generated_images!==1||
    (Object.hasOwn(u,'input_images')&&u.input_images!==1))fail('IMAGE_USAGE_INVALID');
 const keys=['input_images','generated_images','output_tokens','total_tokens'];
 for(const k of keys)if(Object.hasOwn(u,k)&&!validCount(u[k]))fail('IMAGE_USAGE_INVALID');
 return Object.fromEntries(keys.filter(k=>Object.hasOwn(u,k)).map(k=>[k,u[k]]));
}
async function readJson(r,limit=responseLimit){
 if(!r.body?.getReader)fail('IMAGE_RESPONSE_INVALID');
 const len=Number(r.headers.get('content-length')||0);
 if(len>limit){await r.body.cancel().catch(()=>{});fail('IMAGE_RESPONSE_TOO_LARGE');}
 const reader=r.body.getReader(),buf=[];let total=0;
 try{
   while(true){const {done,value}=await reader.read();if(done)break;
     total+=value.length;
     if(total>limit){await reader.cancel().catch(()=>{});fail('IMAGE_RESPONSE_TOO_LARGE');}
     buf.push(Buffer.from(value));
   }
 }catch(e){if(e?.code==='IMAGE_RESPONSE_TOO_LARGE')throw e;fail('IMAGE_SUBMISSION_UNKNOWN',{unknown:true});}
 finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(buf).toString('utf8'));}
 catch{fail('IMAGE_RESPONSE_INVALID');}
}

export function createArkImageProvider({apiKey,enableRealSubmit=false,fetchImpl=globalThis.fetch,inspect=inspectImage,timeoutMs=100000}={}){
 function prepare({source,expectedSha256,backgroundBrief}={}){
   if(enableRealSubmit!==true)fail('IMAGE_PROVIDER_DISABLED');
   if(typeof apiKey!=='string'||!apiKey.trim())fail('IMAGE_PROVIDER_NOT_CONFIGURED');
   if(!Buffer.isBuffer(source?.bytes)||source.bytes.length===0||source.bytes.length>byteLimit||
      !Object.hasOwn(mimeFormats,source.contentType))fail('IMAGE_INPUT_INVALID');
   if(!/^[a-f0-9]{64}$/.test(expectedSha256??'')||sha(source.bytes)!==expectedSha256)fail('IMAGE_INPUT_HASH_MISMATCH');
   if(typeof backgroundBrief!=='string'||!backgroundBrief.trim()||[...backgroundBrief].length>180)fail('IMAGE_BRIEF_INVALID');
   const {format,width,height}=inspect(source.bytes), pixels=width*height, ratio=width/height;
   if(format!==mimeFormats[source.contentType])fail('IMAGE_FORMAT_INVALID');
   if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=14||height<=14||
      pixels>36000000||ratio<1/16||ratio>16)fail('IMAGE_SIZE_NOT_SUPPORTED');
   const body=JSON.stringify({
     model:ARK_IMAGE_MODEL,
     prompt:'只编辑背景。背景描述：'+JSON.stringify(backgroundBrief)+'。保持商品珠子数量、顺序、颜色、隔片、轮廓、原位置、原比例和原拍摄角度；替换外侧、环内与珠间旧背景。背景描述不得更改商品。保留素材标识，不新增商品、饰品或宣传文字。',
     image:'data:'+source.contentType+';base64,'+source.bytes.toString('base64'),
     size:ARK_IMAGE_OUTPUT_SIZE,output_format:'png',background:'opaque',response_format:'b64_json',watermark:true
   });
   let used=false;
   return async()=>{
     if(used)fail('IMAGE_PREPARED_REQUEST_ALREADY_USED');used=true;
     let r;
     try{r=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{
       Authorization:'Bearer '+apiKey,'Content-Type':'application/json'
     },body});}catch{fail('IMAGE_SUBMISSION_UNKNOWN',{unknown:true});}
     const id=protectRequestId(r,apiKey), httpStatus=r.status;
     if(!r.ok){
       const definitive=httpStatus>=400&&httpStatus<500&&httpStatus!==408&&httpStatus!==409;
       let details=null;
       if(definitive){
         try{const body=await readJson(r,16384);details=diagnostic(body?.error,apiKey);}catch{}
       }else{await r.body?.cancel().catch(()=>{});}
       const e=err(definitive?'IMAGE_HTTP_'+httpStatus:'IMAGE_SUBMISSION_UNKNOWN',{
         requestId:id,httpStatus,unknown:!definitive,providerCode:details?.code??null,providerParam:details?.param??null
       });
       if(details)privateDiagnostics.set(e,details);
       throw e;
     }
     try{
       const data=await readJson(r);
       if(data?.model!==undefined&&data.model!==ARK_IMAGE_MODEL)fail('IMAGE_MODEL_MISMATCH');
       if(!Array.isArray(data?.data)||data.data.length!==1)fail('IMAGE_RESPONSE_NOT_SINGLE');
       const item=data.data[0],encoded=item?.b64_json;
       if(typeof encoded!=='string'||encoded.length<8||encoded.length>Math.ceil(byteLimit/3)*4||encoded.length%4!==0||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||item?.error)fail('IMAGE_OUTPUT_INVALID');
       const bytes=Buffer.from(encoded,'base64');
       if(bytes.length>byteLimit||bytes.toString('base64')!==encoded)fail('IMAGE_OUTPUT_INVALID');
       const m=inspect(bytes);
       if(m.format!=='PNG')fail('IMAGE_FORMAT_INVALID');
       const actual=m.width+'x'+m.height, area=m.width*m.height, scale=m.width/m.height;
       if(!Number.isSafeInteger(m.width)||!Number.isSafeInteger(m.height)||m.width<1||m.height<1||
          area<921600||area>8294400||scale<1/16||scale>16 ||
          (item.size!==undefined&&item.size!==actual&&item.size!==ARK_IMAGE_OUTPUT_SIZE))fail('IMAGE_OUTPUT_SIZE_MISMATCH');
       if(m.opaque!==true)fail('IMAGE_OUTPUT_NOT_OPAQUE');
       const warnings=m.width*height!==m.height*width?['SOURCE_ASPECT_RATIO_CHANGED']:[];
       return {bytes,sha256:sha(bytes),contentType:'image/png',width:m.width,height:m.height,sourceWidth:width,
         sourceHeight:height,warnings,usage:checkedUsage(data),requestId:id,httpStatus};
     }catch(e){throw err(e?.code||'IMAGE_RESPONSE_INVALID',{requestId:id,httpStatus,unknown:e?.unknown===true});}
   };
 }
 return Object.freeze({prepare,model:ARK_IMAGE_MODEL});
}
