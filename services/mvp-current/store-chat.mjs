import {createAnranSales} from './anran-sales.mjs';
import {createDeepSeekCompletion} from './agent.mjs';
import {requestedSkus} from './sales.mjs';
export {requestedSkus as storeRequestedSkus};
export async function storeChat(text, context, allowedProductIds) {
 const apiKey=process.env.DEEPSEEK_API_KEY,model=process.env.DEEPSEEK_MODEL||'deepseek-chat';
 if(!apiKey||process.env.MVP_FIXTURE==='1')throw Error('Live sales model not configured');
 const run=createAnranSales({complete:createDeepSeekCompletion(apiKey,model),allowedProductIds,model});
 return run(text,context);
}
