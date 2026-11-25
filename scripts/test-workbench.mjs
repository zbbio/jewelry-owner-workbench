import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const paths=readdirSync(new URL('../tests/',import.meta.url))
  .filter(file=>file.endsWith('.test.mjs')).sort().map(file=>'tests/'+file);
const child=spawnSync(process.execPath,['--test','--test-concurrency=1',...paths],{
  cwd:root,stdio:'inherit',
  env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENCV_FOR_THREADS_NUM:'1'}
});
if(child.error)console.error(child.error.message);
process.exitCode=child.status??1;
