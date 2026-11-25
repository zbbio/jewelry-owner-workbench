import {startServer} from './dist/server.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
const kind=process.argv[2]||'desktop';
if(!['desktop','phone'].includes(kind))throw Error('unknown mode');
const app=await startServer(0), configured=Boolean(process.env.DEEPSEEK_API_KEY?.trim());
try{
 const env={PYTHONIOENCODING:'utf-8'};
 for (const k of ['Path','SystemRoot','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','COMSPEC','ProgramFiles','ProgramFiles(x86)','HOMEDRIVE','HOMEPATH','USERNAME'])if(process.env[k])env[k]=process.env[k];
 env.N9_LAUNCH_URL=app.issueLaunch();
 const mode=configured?'full':'unconfigured';
 const args=kind==='phone'?['-B','-X','utf8',fileURLToPath(new URL('../真机/phone_n9.py',import.meta.url)),'--mode',mode]:['-B','-c','import os; os.startfile(os.environ.pop("N9_LAUNCH_URL"))'];
 const child=spawn('python',args,{windowsHide:true,stdio:'inherit',env});
 const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes)});
 if(kind==='phone'){
 const name='phone-'+mode+'-'+Date.now()+'.json';
 await fs.writeFile(fileURLToPath(new URL('../总控核验/'+name,import.meta.url)),JSON.stringify({scope:'android-'+mode,code,log:app.getAudit()},null,2));process.exitCode=code??1;
 }else if(code===0){
 console.log('已打开测试店原卡助手（30分钟会话），关闭窗口即可停止。模型密钥'+(configured?'已配置。':'未配置；已选商品不会生成报价。'));
 await new Promise(r=>{process.once('SIGINT',r);process.once('SIGTERM',r);setTimeout(r,30*60*1000).unref()});
 }else process.exitCode=code??1;
}finally{app.server.closeAllConnections();await app.close();}
