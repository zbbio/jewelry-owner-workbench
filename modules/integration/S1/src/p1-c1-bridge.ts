import type {Ports,Turn,Binding,Envelope} from "./shared-runner.js";

type Actor={shopId:string;actorId:string;sessionId:string;role:"owner"};
type ReadAccess={context:Actor;envelope:Envelope;subject:Turn["subject"];replyToMessageId?:string;
  catalogEnabled:boolean;contentEnabled:boolean};
type Context={conversationId:string;messageId:string;runId:string;requestId:string;replyToMessageId?:string};
type Host={
  // The same ordinary-message reservation authorizes these callbacks; no HTTP/browser call to these methods.
  getActiveRead:(binding:Readonly<Envelope>)=>ReadAccess|null|Promise<ReadAccess|null>;
  callP1?:(ctx:Actor,args:{lookup:{kind:"this_item";value:null};view:"price"|"facts"|"facts_and_price";expectedVersion:number},
    scope:Context&{reference:{shopId:string;productId:string;productVersion:number}},
    association:{modelCallId:string})=>Promise<unknown>;
  callC1?:(ctx:Actor,scope:Context,args:{productRef:null;workVersion:number|null})=>Promise<unknown>;
  // For C1 which already persisted authorized playback pin but returns no standalone receipt ID.
  appendC1Receipt?:(ctx:Actor,scope:Context,entry:{toolName:"content_find_existing";modelCallId:string;receipt:unknown})=>Promise<string|null>;
};
const refNames=["shopId","actorId","conversationId","messageId","runId","requestId"] as const;
const rec=(x:unknown):x is Record<string,any>=>!!x&&typeof x==="object"&&!Array.isArray(x);
const id=(x:unknown):x is string=>typeof x==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const at=(r:ReadAccess,b:Envelope)=>r.context.role==="owner"&&r.context.shopId===b.shopId&&r.context.actorId===b.actorId&&id(r.context.sessionId)
  &&refNames.every(k=>r.envelope[k]===b[k]);
const pin=(r:ReadAccess,b:Binding)=>r.subject.state==="bound"&&r.subject.productId===b.productId&&r.subject.productVersion===b.productVersion;
const context=(r:ReadAccess):Context=>{const {conversationId,messageId,runId,requestId}=r.envelope;
  return {conversationId,messageId,runId,requestId,...(r.replyToMessageId?{replyToMessageId:r.replyToMessageId}:{})};};
const scalar=(x:unknown)=>typeof x==="string"||typeof x==="number"&&Number.isFinite(x);
const safeLabel=(x:unknown)=>typeof x==="string"&&x.length>0&&x.length<=80&&!/[:/\\<>@\x00-\x1f]/.test(x);
const bad=()=>{throw new Error("UPSTREAM_READ_RECEIPT_UNVERIFIED");};
const versioned=(r:Record<string,unknown>,b:Binding)=>r.productId===b.productId&&r.productVersion===b.productVersion;

export function createN99ReadPorts(host:Host):Ports{
  const guard=async(b:Readonly<Binding>)=>{
    const a=await host.getActiveRead(b);
    if(!a||!at(a,b)||!pin(a,b))return bad();
    return a;
  };
  return {
    async authorize(t){
      const a=await host.getActiveRead(t);
      if(!a||!at(a,t)||a.subject.state!==t.subject.state)return null;
      if(a.subject.state==="bound"&&t.subject.state==="bound"&&
        (a.subject.productId!==t.subject.productId||a.subject.productVersion!==t.subject.productVersion||a.subject.source!==t.subject.source))return null;
      return {catalog:a.catalogEnabled&&typeof host.callP1==="function",
        content:a.contentEnabled&&typeof host.callC1==="function"&&typeof host.appendC1Receipt==="function"};
    },
    readFacts:host.callP1?async x=>{
      const b=x.binding, a=await guard(b), c=context(a);
      if(!a.catalogEnabled)return bad();
      const price=x.fields.includes("price");
      const view=price?(x.fields.length===1?"price":"facts_and_price"):"facts";
      const call=await host.callP1!(a.context,{lookup:{kind:"this_item",value:null},view,expectedVersion:b.productVersion},
        {...c,reference:{shopId:b.shopId,productId:b.productId,productVersion:b.productVersion}},{modelCallId:x.callId});
      if(!rec(call)||!rec(call.result)||!id(call.receiptId)||
        call.toolName!=="catalog_read_facts"||call.toolVersion!=="catalog_read_facts/v1"||
        !["conversationId","messageId","requestId","runId"].every(k=>call[k]===c[k as keyof Context]))return bad();
      const raw=call.result;
      const standard={binding:b,callId:x.callId,receiptId:call.receiptId};
      if(raw.status!=="matched")return {...standard,status:raw.status==="version_conflict"?"stale":"unavailable"};
      if(raw.readOnly!==true||!versioned(raw,b)||raw.source?.system!=="catalog"||!versioned(raw.source,b))return bad();
      const facts=x.fields.map(field=>{
        const unknown={field,status:"unknown",value:null};
        if(field==="price"){
          const p=raw.price;
          if(p?.status!=="recorded"||p.currency!=="CNY"||!scalar(p.amount)||!safeLabel(p.recordedSource))return unknown;
          return {field,status:"recorded",value:String(p.amount),source:p.recordedSource};
        }
        const f=raw.facts?.[field];
        // P1 does not attest a saleable stock count; keep it unknown, do not infer it from display labels.
        if(field==="inventory"||!f||!scalar(f.value)||!safeLabel(f.source))return unknown;
        return {field,status:"recorded",value:String(f.value)+(safeLabel(f.unit)?" "+f.unit:""),source:f.source};
      });
      return {...standard,status:"ok",facts};
    }:undefined,
    lookupExisting:host.callC1&&host.appendC1Receipt?async x=>{
      const b=x.binding,a=await guard(b),c=context(a);
      if(!a.contentEnabled)return bad();
      const raw=await host.callC1!(a.context,c,{productRef:null,workVersion:x.workVersion});
      if(!rec(raw)||!rec(raw.receipt))return bad();
      const p=raw.receipt;
      if(p.shopId!==b.shopId||p.action!=="old_video"||p.writesPerformed!==false||p.deliveryStatus!=="not_submitted"||
        !["conversationId","messageId","requestId"].every(k=>p[k]===c[k as keyof Context]))return bad();
      const matched=["existing_available","no_verified_old_clip"].includes(p.outcome);
      if(matched&&!versioned(p,b))return bad();
      if((p.productId!==undefined||p.productVersion!==undefined)&&!versioned(p,b))return bad();
      const canonical={...c,shopId:b.shopId,productId:b.productId,productVersion:b.productVersion,
        action:"old_video",source:"studio.approved_works",deliveryStatus:"not_submitted",writesPerformed:false};
      let mapped:Record<string,unknown>, toRecord:Record<string,unknown>;
      if(p.outcome==="existing_available"){
        const w=p.workRef;
        if(p.retrievalStatus!=="playable"||!rec(w)||!id(w.workId)||!Number.isSafeInteger(w.workVersion)||w.workVersion<1||
          (x.workVersion!==null&&x.workVersion!==w.workVersion))return bad();
        // Only C1 generates the signed/unlocked authorization pin; verify the fixed, same-origin authenticated route shape.
        const expect="/api/n22/content/works/"+w.workId+"/"+w.workVersion+"/play?"+
          new URLSearchParams({messageId:b.messageId,productId:b.productId,productVersion:String(b.productVersion)});
        if(p.pinnedPlayUrl!==expect||p.mime!=="video/mp4"||!Number.isSafeInteger(p.fileBytes)||p.fileBytes<1||
          typeof p.sha256!=="string"||!/^[a-f0-9]{64}$/.test(p.sha256)||!Number.isFinite(p.durationSeconds)||p.durationSeconds<=0)return bad();
        const workRef={workId:w.workId,workVersion:w.workVersion};
        mapped={status:"ok",workRef,retrievalStatus:"playable"};
        toRecord={...canonical,outcome:"existing_available",workRef,retrievalStatus:"playable",
          pinnedPlayUrl:expect,sha256:p.sha256,durationSeconds:p.durationSeconds,fileBytes:p.fileBytes,mime:p.mime};
      }else{
        mapped={status:p.outcome==="no_verified_old_clip"?"not_found":p.outcome==="needs_review"?"stale":"unavailable"};
        toRecord={...canonical,outcome:mapped.status==="not_found"?"no_verified_old_clip":mapped.status==="stale"?"needs_review":"source_unavailable"};
      }
      await guard(b);
      const receiptId=await host.appendC1Receipt!(a.context,c,{toolName:"content_find_existing",modelCallId:x.callId,receipt:toRecord});
      if(!id(receiptId))return bad();
      return {...mapped,binding:b,callId:x.callId,receiptId};
    }:undefined,
  };
}
