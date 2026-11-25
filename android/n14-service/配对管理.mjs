import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {Fault,PORT,openStore,privateDir} from './会话库.mjs';

const origin=`http://127.0.0.1:${PORT}`;
const [op='status',arg,...extra]=process.argv.slice(2);
const output=x=>console.log(JSON.stringify(x));
const dir=privateDir();
const needsArg=new Set(['revoke','qa-start','qa-release','qa-end','qa-audit']);
async function publicState(){
  try{const r=await fetch(origin+'/api/health',{redirect:'error',signal:AbortSignal.timeout(1200)});
    const x=await r.json();return r.ok&&x.service==='n14-local-readonly'&&typeof x.runId==='string'?x:null;}catch{return null;}
}
async function main(){
  if(extra.length||Boolean(arg)!==needsArg.has(op)||arg&&!/^[0-9a-f-]{36}$/.test(arg))throw Error('INVALID_ARGUMENT');
  if(op==='status'){const health=await publicState();output(health?{listening:true,binding:origin,...health}:{listening:false,binding:origin});return health?0:3;}
  if(op==='stop'){
    const health=await publicState();if(!health){output({stopped:true,alreadyOffline:true});return 0;}
    const meta=JSON.parse(await readFile(join(dir,'service.json'),'utf8'));
    if(meta.runId!==health.runId||meta.origin!==origin)throw Error('N14_INSTANCE_MISMATCH');
    await writeFile(join(dir,'stop.request'),meta.runId,{mode:0o600});
    for(let i=0;i<30;i++){await pause(200);const next=await publicState();if(next?.runId!==meta.runId){output({stopped:true,runId:meta.runId});return 0;}}
    throw Error('STOP_PENDING');
  }
  if(op==='issue'&&(!process.stdout.isTTY||!process.stdin.isTTY))throw Error('PRIVATE_INTERACTIVE_TERMINAL_REQUIRED');
  if(!['issue','list',...needsArg].includes(op))throw Error('INVALID_ARGUMENT');
  const s=openStore(dir);
  try{
    if(op==='issue'){
      const p=s.issue();console.log('请本人输入以下一次性配对码；不要录屏、重定向、复制到工单。');console.log(p.code);
      console.log('到期 UTC：'+new Date(p.expires).toISOString());return 0;
    }
    if(op==='list'){output(s.list());return 0;}
    if(op==='revoke'){output(s.revoke(arg));return 0;}
    if(op==='qa-start'){output(s.qaStart(arg));return 0;}
    if(op==='qa-release'){output(s.qaRelease(arg));return 0;}
    if(op==='qa-end'){output(s.qaEnd(arg));return 0;}
    if(op==='qa-audit'){output(s.getAudit(arg));return 0;}
  }finally{s.close();}
}
main().then(x=>{process.exitCode=x??0;}).catch(e=>{
  console.error(e instanceof Fault?e.code:typeof e?.message==='string'&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'N14_CONTROL_FAILED');process.exitCode=2;});
