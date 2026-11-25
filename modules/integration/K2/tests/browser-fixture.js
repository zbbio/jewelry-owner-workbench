/* Executed ONLY by CDP in the isolated Chromium fixture. Never shipped as a host reader binding. */
((seed)=>{
'use strict';
const copy=x=>structuredClone(x),calls=[], effects={confirmed:0,cancelled:0};
let rows=copy(seed), mode='ok', held=null, readIndex=0, finishedLatches=0;
const statusError=n=>Object.assign(Error('FIXTURE_ONLY_'+n),{status:n});
const api=Object.freeze({
  async listPending(){calls.push(['list']);if(mode==='list403')throw statusError(403);return copy(rows.filter(x=>x.status==='pending').map(x=>mode==='newListVersion'?{...x,objectVersion:x.objectVersion+1}:x));},
  async readPending(id){calls.push(['read',id]);readIndex++;const row=rows.find(x=>x.confirmationId===id);if(!row)throw statusError(404);
    if(mode==='hold'){const old=copy(row);await new Promise(r=>held=r);return old;}
    if(mode==='holdSecond403' && readIndex===2){await new Promise(r=>held=r);finishedLatches++;throw statusError(403);}
    if(['holdSecondOK','newListVersion'].includes(mode) && readIndex===2){const old=copy(row);await new Promise(r=>held=r);finishedLatches++;return old;}
    if(mode==='403')throw statusError(403);
    if(mode==='409')throw statusError(409);
    if(mode==='expired')return {...copy(row),expiresAt:'2001-01-01T00:00:00Z'};
    if(mode==='newVersion')return {...copy(row),objectVersion:row.objectVersion+1};
    if(mode==='wrongRun')return {...copy(row),runId:'55555555-5555-4555-8555-555555555555'};
    return copy(row);
  },
  async decide(ticket,choice){calls.push(['decide',ticket.confirmationId,choice,ticket.objectVersion]);if(mode==='commit409')throw statusError(409);
    if(mode==='holdDecision'){await new Promise(r=>held=r);finishedLatches++;}
    const row=rows.find(x=>x.confirmationId===ticket.confirmationId);
    if(!row || row.status!=='pending'|| row.objectVersion!==ticket.objectVersion||Date.parse(row.expiresAt)<=Date.now())throw statusError(409);
    if(choice!=='confirm'&&choice!=='cancel')throw Error('unexpected decision');
    row.status=choice==='cancel'?'cancelled':'confirmed';effects[row.status]++;return copy(row);
  },
  async readiness(){calls.push(['ready']);return [{warehouse:'catalog',state:'ready',detail:'合成：只读已就绪'},
    {warehouse:'sales',state:'unavailable',detail:'合成：无计费时段'}];}
});
Object.defineProperty(globalThis,'K2TestOnly',{value:Object.freeze({api,
 mode:v=>{mode=v;readIndex=0;},release:()=>{const f=held;held=null;f?.();},peek:()=>({calls:copy(calls),effects:copy(effects),held:!!held,finishedLatches}),
 reset:()=>{mode='ok';rows=copy(seed);}
})});
})(/*K2_TEST_SEED*/);
