import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Agent,Runner,tool} from '@openai/agents';
import OpenAI from 'openai';
import {makeTurnService} from './agents-deepseek.mjs';
import {sha} from './config.mjs';

const files=['config.mjs','serve.mjs','state.mjs','ops.mjs','agents-deepseek.mjs','public/pair.mjs'];
const lock=JSON.parse(readFileSync(new URL('package-lock.json',import.meta.url),'utf8'));
if(lock.packages['node_modules/@openai/agents']?.version!=='0.22.0'||lock.packages['node_modules/openai']?.version!=='7.62.0')throw Error('LOCK_MISMATCH');
if([Agent,Runner,tool,OpenAI,makeTurnService].some(x=>typeof x!=='function'))throw Error('IMPORT_FAILED');
const db=new DatabaseSync(':memory:');db.exec('SELECT 1');db.close();
for(const f of files){const child=spawnSync(process.execPath,['--check',fileURLToPath(new URL(f,import.meta.url))],{encoding:'utf8'});if(child.status!==0)throw Error('SYNTAX_FAILURE');}
console.log(JSON.stringify({state:'offline_build_verified',node:process.version,platform:process.platform,
  compiledAndImportedRealSdk:true,providerRequests:0,validated:files.map(name=>({name,sha256:sha(readFileSync(new URL(name,import.meta.url)))}))}));
