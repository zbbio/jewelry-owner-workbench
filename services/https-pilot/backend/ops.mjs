import http from 'node:http';
import {Fault,fail,loadConfig,loadCatalog,readModelSecret} from './config.mjs';
import {openState,PUBLIC_TEST_NO} from './state.mjs';

function probe(cfg,path){return new Promise((yes,no)=>{
  const req=http.request({socketPath:cfg.socketPath,path,method:'GET',headers:{Host:cfg.host},timeout:2500},res=>{
    const b=[];res.on('data',x=>b.push(x));res.on('end',()=>{try{yes({http:res.statusCode,body:JSON.parse(Buffer.concat(b).toString('utf8'))});}catch{no(Error('PROBE_INVALID'));}});
  });req.on('timeout',()=>req.destroy());req.on('error',no);req.end();
});}
async function main(){
  const [op='selfcheck',id,...extra]=process.argv.slice(2);
  const needsId=['revoke','qa-start','qa-end','qa-release'].includes(op);
  if((needsId?!(/^[0-9a-f-]{36}$/u.test(id||'')):op==='audit'?id!==undefined&&!PUBLIC_TEST_NO.test(id):id!==undefined)||
    (op==='qa-release'?(extra.length!==1||extra[0]!=='--b-visible'):extra.length!==0))fail('INVALID_OPERATOR_ARGUMENT');
  if(process.platform==='linux')process.umask(0o077);
  const cfg=loadConfig(process.env.N15_CONFIG);
  if(op==='selfcheck'){
    loadCatalog(cfg);const model=Boolean(readModelSecret(cfg)),ok=cfg.modelPolicy==='disabled'||model;
    console.log(JSON.stringify({ok,source:'verified_digest_and_scope',transport:'private_socket_expected',modelPolicy:cfg.modelPolicy,modelFormatReady:model,providerRequests:0}));return ok?0:2;
  }
  if(op==='health'||op==='ready'){const r=await probe(cfg,op==='health'?'/healthz':'/readyz');console.log(JSON.stringify(r));return r.http===200?0:3;}
  if(!['pair-issue','list','revoke','audit','qa-start','qa-end','qa-release'].includes(op))fail('INVALID_OPERATOR_ACTION');
  if(op==='pair-issue'&&(!process.stdin.isTTY||!process.stdout.isTTY))fail('LOCAL_PRIVATE_INTERACTIVE_TERMINAL_REQUIRED');
  const s=openState(cfg);
  try{
    if(op==='pair-issue'){
      const p=s.issue();console.log('请在不记录的本机终端私下读取并交本人输入；切勿写入工单或日志。');
      console.log(p.code);console.log('到期 UTC：'+p.expiresAt);return 0;
    }
    const out=op==='list'?s.list():op==='audit'?s.auditList().filter(x=>!id||x.publicTestNo===id):op==='revoke'?s.revoke(id):op==='qa-start'?s.qaStart(id):
      op==='qa-release'?s.qaRelease(id,true):s.qaEnd(id);
    console.log(JSON.stringify(out));return 0;
  }finally{s.close();}
}
main().then(x=>{process.exitCode=x;}).catch(e=>{console.error(e instanceof Fault?e.code:'N15_OPERATOR_UNAVAILABLE');process.exitCode=2;});
