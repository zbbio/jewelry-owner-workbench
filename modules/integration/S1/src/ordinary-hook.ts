import type {Envelope,Subject,Turn} from "./shared-runner.js";
type Input={context:{role:string;shopId:string;actorId:string;sessionId:string};text:string;
 scope:Omit<Envelope,"shopId"|"actorId">&{replyToMessageId?:string|null};tools:Readonly<Record<string,unknown>>};
type Result={status:string;code:string;text:string;actions:unknown[];runtime:unknown};
type Opened={subject:Subject;close:()=>void|Promise<void>};
type Hooks={
  // Verify the reservation and bind identity only, from this authenticated ordinary message and its
  // explicit product or verified reference. Register this run with createN99ReadPorts/getActiveRead.
  openReadContext:(input:Input,envelope:Envelope)=>Opened|null|Promise<Opened|null>;
  execute:(turn:Turn)=>Promise<Result>;
  // Write to the existing P1 message/run, never submit a new message. On history use existing authorized GET.
  savePresentation:(envelope:Envelope,result:Result)=>boolean|Promise<boolean>;
};
const statuses:Record<string,string>={completed:"completed",partial:"partial_success",clarify:"needs_clarification",unsupported:"unsupported"};
export function createS1OrdinaryTurnHook(h:Hooks){
  return async function p1Runner(incoming:Input){
    const {context,scope,text}=incoming;
    if(context?.role!=="owner"||!scope||typeof text!=="string")return {status:"failed",code:"S1_HOST_SCOPE_DENIED"};
    const e:Envelope={shopId:context.shopId,actorId:context.actorId,conversationId:scope.conversationId,
      messageId:scope.messageId,runId:scope.runId,requestId:scope.requestId};
    const run=await h.openReadContext(incoming,Object.freeze(e));
    if(!run)return {status:"failed",code:"S1_HOST_SCOPE_DENIED"};
    try{
      const result=await h.execute({...e,subject:run.subject,text});
      if(await h.savePresentation(e,result)!==true)return {status:"failed",code:"S1_PRESENTATION_UNCOMMITTED"};
      return {status:statuses[result.status]??"failed",code:result.code};
    }finally{await run.close();}
  };
}
