// Concurrent registration fixture: separate worker owns its SQLite connection.
import {parentPort,workerData} from 'node:worker_threads';
import {openState} from '../state.mjs';
parentPort.once('message',()=>{
  let db;
  try{
    db=openState(workerData.cfg);
    const q=db.qaStart(workerData.ownerId);
    parentPort.postMessage({ok:true,publicTestNo:q.publicTestNo});
  }catch(e){parentPort.postMessage({ok:false,code:e.code??'WORKER_FAILED'});}
  finally{db?.close();}
});
parentPort.postMessage({ready:true});
