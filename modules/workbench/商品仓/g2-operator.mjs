/** The authorized PC operator owns this private console and its child IPC.
 * No fixture mode, no phone actions, no shell command strings, no HTTP admin routes.
 */
import {fork} from 'node:child_process';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {existsSync,readFileSync,realpathSync,lstatSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {g2IpcType} from './g2-service.mjs';

function unique(p){
  const full=resolve(p??'');
  if(realpathSync(full)!==full||lstatSync(full).nlink!==1||!lstatSync(full).isFile())throw Error('N22_G2_PRIVATE_LOCAL_FILE');
  return full;
}
const [cfgArg,codeArg]=process.argv.slice(2);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/u.test(x);
let owned,done;
const stop=()=>{if(owned?.connected)owned.send('N17_STOP');};
async function main(){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('N22_G2_PRIVATE_CONSOLE_REQUIRED');
  const conf=unique(cfgArg), module=unique(codeArg), area=dirname(conf);
  const cfg=JSON.parse(readFileSync(conf,'utf8'));
  if(basename(conf)!=='runtime.json'||cfg.n22G2PrivateCandidate!==true||cfg.n22G2Fixture||cfg.modelPolicy!=='disabled'||
     cfg.origin!=='http://127.0.0.1:17869'||dirname(module)!==join(area,'operator-private')||
     cfg.stateDir!==join(area,'state')||!basename(area).startsWith('test-g2-live-')||
     dirname(area)!==join(cfg.n22Root,'商品仓','仅本机只读')||
     !existsSync(join(cfg.n22Root,'共享','真机放行.md')))throw Error('N22_G2_PRIVATE_RELEASE_REQUIRED');
  // Plain occupancy probe; never contact/control another server, even if it looks like N22.
  await new Promise((ok,no)=>{
    const t=createServer();
    t.once('error',()=>no(Error('N22_G2_PORT_OCCUPIED')));
    t.listen({host:'127.0.0.1',port:17869,exclusive:true},()=>t.close(ok));
  });
  const entry=unique(join(area,'run','backend','local-n22.mjs'));
  const allow=new Set(['PATH','SystemRoot','WINDIR','PATHEXT','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allow.has(k)||k==='Path'));
  // Never inherit provider env values; the trusted host module gets a callable, not a stored key.
  owned=fork(entry,[],{cwd:area,env:{...env,N17_CONFIG:conf},execArgv:['--import',pathToFileURL(module).href],
    stdio:['ignore','ignore','ignore','ipc']});
  done=new Promise(r=>owned.once('exit',(code,signal)=>r({code,signal})));
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const time=Date.now()+20000;
  let online=false;
  while(Date.now()<time&&owned.exitCode===null){
    try{
      const s=await fetch(cfg.origin+'/healthz',{signal:AbortSignal.timeout(1000)}),h=await s.json();
      const m=JSON.parse(readFileSync(join(cfg.stateDir,'instance.json'),'utf8'));
      if(h.runId===m.runId&&m.pid===owned.pid){
        if(h.model!=='approval_armed')throw Error('N22_G2_APPROVAL_REJECTED');
        online=true;break;
      }
    }catch(e){if(e.message==='N22_G2_APPROVAL_REJECTED')throw e;}
    await wait(100);
  }
  if(!online)throw Error('N22_G2_OWN_START_NOT_CONFIRMED');
  const io=createInterface({input:process.stdin,output:process.stdout,terminal:true});
  const callbacks=new Map();
  owned.on('message',x=>{
    if(x?.type!==g2IpcType||!callbacks.has(x.id))return;
    callbacks.delete(x.id);process.stdout.write(JSON.stringify({ok:x.ok,result:x.result,code:x.code})+'\n');
  });
  io.on('line',line=>{
    const [op,...args]=line.trim().split(/\s+/u);
    if(op==='stop'&&args.length===0){io.close();stop();return;}
    if(!['status','b_visible','release','end'].includes(op)||args.length!==(op==='b_visible'?2:0)||!args.every(id)){
      process.stdout.write('N22_G2_CONTROL_INVALID\n');return;
    }
    if(callbacks.size>=16||!owned.connected)return;
    const reqId=randomUUID();callbacks.set(reqId,true);
    owned.send({type:g2IpcType,id:reqId,op,params:op==='b_visible'?{requestId:args[0],messageId:args[1]}:{}});
  });
  io.once('close',stop);
  process.stdout.write('N22_G2_APPROVAL_ARMED — status | b_visible <requestId> <messageId> | release | end | stop\n');
  const exit=await done;io.close();process.exitCode=exit.code??1;
}
try{await main();}
catch(e){stop();if(done)await done;process.stderr.write((/^N22_G2_[A-Z_]+$/u.test(e.message)?e.message:'N22_G2_PRIVATE_BOOT_FAILED')+'\n');process.exitCode=1;}
