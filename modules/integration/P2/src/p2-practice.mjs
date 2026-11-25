import {localFactRead} from './p1-host.mjs';
import {createP2Confirmations} from './p2-confirmations.mjs';
import {failure} from './p1-contract.mjs';

export function createP2Practice({db,write,isLiveOwner,clock,ttlMs,canDecide}){
  const confirmations=createP2Confirmations({db,catalogWrite:write,isLiveOwner,clock,ttlMs,canDecide});
  function buildRunner(ports){
    return async i=>{
      if(!await ports.authorizeTurn(i))throw failure('PRACTICE_OWNER_REQUIRED',401);
      // Only the existing isolated P34 preview parser. No HTTP/SDK write tool,
      // no free text decision, no fallback to the old confirmation operation.
      const draft=await write.previewForConfirmation(i.context,{messageId:i.scope.messageId,text:i.text},
        ()=>ports.readBoundProduct(i,'catalog_read_facts'));
      if(draft){
        if(!await ports.authorizeTurn(i))throw failure('PRACTICE_OWNER_REQUIRED',401);
        confirmations.register(i.context,i.scope,draft);
        return {status:'needs_confirmation',code:'P2_OWNER_CONFIRMATION_REQUIRED'};
      }
      return localFactRead(i);
    };
  }
  return Object.freeze({buildRunner,route:confirmations.route,forMessage:confirmations.forMessage});
}
