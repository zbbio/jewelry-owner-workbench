const fail = code => { throw Object.assign(new Error(code),{code}); };
const key = c => JSON.stringify([c.shopId,c.actorId,c.sessionId]);
const positive = x=>Number.isSafeInteger(x)&&x>0;
const nonEmpty = x=>typeof x==='string'&&x.trim().length>0;
function validPrice(result, expected) {
  const q=result.actions.find(x=>x.action==='quote');
  const r=q?.modelReceipt;
  const want=expected==='a'?'known':'unknown';
  return q?.status===want && r?.providerHttpAttempts===2 &&
    r?.modelTurns===2 && r?.providerResponseHashes?.length===2 && new Set(r.providerResponseHashes).size===2;
}
export function createS1QaGate({ authorizeAdmin=()=>false, record=()=>{}, timeoutMs=75000, allowFixture=false, allowLaneBinding=false, now=Date.now }={}) {
  if (!positive(timeoutMs)||timeoutMs>90000) throw new TypeError('bounded hold required');
  let plan=null,used=false,seq=0;
  const end=(g,reason) => {
    if(g!==plan || !['armed','a_held','b_ready','b_visible'].includes(g.phase)) return;
    clearTimeout(g.timer); g.phase='closed'; g.proceed?.(false); emit('QA_HOLD_CLOSED',{reason});
  };
  const emit=(type,fields={})=>record({type,eventSeq:++seq,eventAt:new Date(now()).toISOString(),...fields});
  const control=(op, auth, params={})=>{
    if(authorizeAdmin(auth,op)!==true)fail('QA_CONTROL_FORBIDDEN');
    if(op==='arm') {
      if(used || !params.scope || ![params.scope.shopId,params.scope.actorId,params.scope.sessionId].every(nonEmpty) ||
         !params.a || !params.b || params.a.productId===params.b.productId ||
         params.a.requestId!=null && params.a.requestId===params.b.requestId || params.a.messageId!=null && params.a.messageId===params.b.messageId)fail('QA_ARM_REJECTED');
      for(const x of [params.a,params.b]) if(!nonEmpty(x.productId)||!positive(x.productVersion)||(![x.requestId,x.messageId].every(nonEmpty)&&!(allowLaneBinding&&x.requestId===null&&x.messageId===null)))fail('QA_ARM_REJECTED');
      plan={scope:key(params.scope),a:{...params.a},b:{...params.b},phase:'armed',consumed:new Set()};
      const g=plan;
      g.timer=setTimeout(()=>end(g,'timeout'),timeoutMs);g.timer.unref?.();
      used=true;emit('QA_ARMED');return snapshot();
    }
    if(!plan)fail('QA_NOT_ARMED');
    if(op==='b_visible'){
      if(plan.phase!=='b_ready'||params.requestId!==plan.b.requestId||params.messageId!==plan.b.messageId)fail('QA_B_NOT_VISIBLE');
      plan.phase='b_visible';emit('QA_B_VISIBLE',{requestId:params.requestId,messageId:params.messageId});return snapshot();
    }
    if(op==='release'){
      if(plan.phase!=='b_visible')fail('QA_B_NOT_VISIBLE');
      clearTimeout(plan.timer);plan.phase='released';emit('QA_RELEASE_ACK',{requestId:plan.a.requestId,messageId:plan.a.messageId});
      plan.proceed(true);return snapshot();
    }
    if(op==='end'){end(plan,'operator_end');return snapshot();}
    if(op==='status')return snapshot();
    return fail('QA_CONTROL_UNKNOWN');
  };
  const snapshot=()=>({phase:plan?.phase??'idle',used,laneBudgetConsumed:plan?.consumed.size??0});
  function matches(pin,x){return pin?.productId===x.productId&&pin.productVersion===x.productVersion&&
    pin.requestId===x.requestId&&pin.messageId===x.messageId;}
  // Pass this as authorizeProvider for the one-shot QA rehearsal. Never call
  // this from a general client route or set allowFixture in a live process.
  function permitProvider(ctx,meta,pin){
    const g=plan;if(!g||g.scope!==key(ctx))return false;
    const x={...meta,productId:pin.productId,productVersion:pin.productVersion};
    const lane=g.phase==='armed'?'a':g.phase==='a_held'?'b':null;
    if(!lane)return false;
    const wanted=g[lane], other=g[lane==='a'?'b':'a'];
    if(!matches(wanted,x)) {
      if(!allowLaneBinding||wanted.requestId!==null||wanted.messageId!==null||
         x.productId!==wanted.productId||x.productVersion!==wanted.productVersion||
         ![x.requestId,x.messageId].every(nonEmpty)||x.requestId===other.requestId||x.messageId===other.messageId)return false;
      wanted.requestId=x.requestId;wanted.messageId=x.messageId;
    }
    if(!lane||g.consumed.has(lane))return false;
    g.consumed.add(lane);emit('QA_PROVIDER_RESERVED',{requestId:x.requestId,messageId:x.messageId});
    return true;
  }
  async function holdSuccessful(ctx,result) {
    const g=plan;
    if(!g||g.scope!==key(ctx)||result.status!=='completed') return;
    const lane=matches(g.a,result)?'a':matches(g.b,result)?'b':null;
    if(!lane || !validPrice(result,lane))return;
    const q=result.actions.find(x=>x.action==='quote');
    const movie=result.actions.find(x=>x.action==='old_video');
    if((q.modelReceipt.mode!=='deepseek' && !(allowFixture&&q.modelReceipt.mode==='fixture_transport')) ||
        (lane==='a'?movie?.status!=='existing_available':movie?.status!=='no_verified_old_clip') ||
        (!allowFixture&&!g.consumed.has(lane))) return;
    const meta={requestId:result.requestId,messageId:result.messageId,shopId:result.shopId,productId:result.productId,productVersion:result.productVersion};
    if(lane==='b'&&g.phase==='a_held'){
      g.phase='b_ready';emit('QA_B_READY',meta);return;
    }
    if(lane==='a'&&g.phase==='armed'){
      let proceed;const wait=new Promise(r=>{proceed=r;});
      g.proceed=proceed;g.phase='a_held';emit('QA_A_HELD',meta);
      if(!(await wait))fail('QA_HOLD_CLOSED_NO_REPLAY');
      emit('QA_A_RELEASED',meta);
    }
  }
  return {control,permitProvider,holdSuccessful};
}
