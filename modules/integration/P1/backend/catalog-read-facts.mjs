import {recordedSalePrice} from './product-read.mjs';
import {summarizeCatalogFacts} from './p1-read-turn.mjs';
import {token,version,owner,exact,failure} from './p1-contract.mjs';

export const TOOL_VERSION='catalog_read_facts/v1';
export const catalogReadFactsTool=Object.freeze({
  name:'catalog_read_facts',version:TOOL_VERSION,
  description:'只读当前已登录本店已核商品卡。按货号或明确描述查，或沿原消息找本件。无所指先澄清；缺价不是零。不会改卡、查旧片或引用外店价格。',
  parameters:{type:'object',additionalProperties:false,required:['lookup','view','expectedVersion'],
    properties:{lookup:{type:'object',additionalProperties:false,required:['kind','value'],
      properties:{kind:{type:'string',enum:['product_id','query','this_item']},value:{type:['string','null']}}},
      view:{type:'string',enum:['facts','price','facts_and_price']},expectedVersion:{type:['integer','null'],minimum:1}}}
});

const viewKinds=new Set(['facts','price','facts_and_price']);
const hasPriceField=fields=>['retailPrice','salePrice','price'].some(k=>fields?.[k]?.value!=null);

export function createCatalogReadFacts({catalog,product}){
  if(!['get','list','getSummary'].every(k=>typeof catalog?.[k]==='function')||typeof product?.identify!=='function')
    throw new TypeError('P1 existing catalog and verified identity resolver required');
  return async (ctx,input,scope)=>{
    owner(ctx);
    const {lookup,view,expectedVersion=null}=exact(input,['lookup','view'],['expectedVersion']);
    const {kind,value}=exact(lookup,['kind','value']);
    if(!viewKinds.has(view)||expectedVersion!==null&&!version(expectedVersion)||
       !['product_id','query','this_item'].includes(kind)||
       (kind==='product_id'&&!token(value))||
       (kind==='query'&&(typeof value!=='string'||!value.trim()||value.length>500))||
       (kind==='this_item'&&value!==null))throw failure('INVALID_TOOL_ARGUMENT',400);
    if(!scope||![scope.messageId,scope.requestId].every(token))throw failure('TOOL_SCOPE_REQUIRED',403);
    const base={tool:'catalog_read_facts',toolVersion:TOOL_VERSION,readOnly:true,view};
    const end=(status,reason,extra)=>({...base,status,reason,...extra});
    // The reference comes only from the actual scoped ledger; never from tool arguments.
    const pin=scope.reference??null;
    if(pin!==null&&(!token(pin.productId)||!version(pin.productVersion)||pin.shopId!==ctx.shopId))
      throw failure('TOOL_SCOPE_CONFLICT',403);
    if(kind==='this_item'&&!pin)return end('needs_clarification','NO_VERIFIED_REFERENCE');
    try{
      let row;
      if(kind==='query'){
        const r=await product.identify(ctx,{requestId:scope.requestId,messageId:scope.messageId,
          text:value.trim(),reference:null,intent:'detail'});
        if(r?.storeId!==ctx.shopId||r.requestId!==scope.requestId||r.messageId!==scope.messageId)
          return end('source_unavailable','CATALOG_SCOPE_MISMATCH');
        if(r.status==='multiple'){
          if(pin)return end('needs_clarification','REFERENCE_DOES_NOT_DISAMBIGUATE');
          if(!Array.isArray(r.cards)||!r.cards.every(c=>token(c.productId)&&version(c.productVersion)))
            return end('source_unavailable','CATALOG_SCOPE_MISMATCH');
          return end('needs_clarification','MULTIPLE_MATCHES',{candidates:r.cards.map(({productId,productVersion,alias})=>
            ({productId,productVersion,...(typeof alias==='string'&&/^[\p{L}\p{N}_.:-]{1,36}$/u.test(alias)?{alias}:{})}))});
        }
        if(r.status!=='matched')return end(
          ['not_found','version_conflict','needs_clarification','source_unavailable'].includes(r.status)?r.status:'needs_clarification',
          r.reason??'NO_VERIFIED_MATCH');
        if(r.cards?.length!==1||!token(r.cards[0]?.productId)||!version(r.cards[0]?.productVersion))
          return end('source_unavailable','CATALOG_SCOPE_MISMATCH');
        row=r.cards[0];
      }else{
        const productId=kind==='this_item'?pin.productId:value;
        const got=await catalog.get(ctx,productId);
        if(!got)return end('not_found','NOT_IN_VISIBLE_CATALOG');
        if(got.productId!==productId||!version(got.productVersion)||got.shopId!=null&&got.shopId!==ctx.shopId)
          return end('source_unavailable','CATALOG_SCOPE_MISMATCH');
        row={productId,productVersion:got.productVersion};
      }
      if(pin&&pin.productId!==row.productId)return end('needs_clarification','REFERENCE_PRODUCT_CONFLICT');
      if(pin&&pin.productVersion!==row.productVersion||expectedVersion!==null&&expectedVersion!==row.productVersion)
        return end('version_conflict','CARD_VERSION_CHANGED');
      const summary=await catalog.getSummary(ctx,row.productId);
      if(!summary)return end('not_found','NOT_IN_VISIBLE_CATALOG');
      if(summary.productId!==row.productId||summary.shopId!=null&&summary.shopId!==ctx.shopId)
        return end('source_unavailable','CATALOG_SCOPE_MISMATCH');
      if(summary.productVersion!==row.productVersion)return end('version_conflict','CARD_VERSION_CHANGED');
      const out=summarizeCatalogFacts(summary,row,false);
      const source=out.source;
      const sale=recordedSalePrice(summary.fields);
      const price=sale
        ?{status:'recorded',amount:sale.amount,currency:sale.currency,field:sale.field,recordedSource:sale.source}
        :{status:hasPriceField(summary.fields)?'needs_review':'unfilled',amount:null,currency:null,field:null,recordedSource:null};
      return end('matched','CATALOG_RECORDED',{
        productId:row.productId,productVersion:row.productVersion,source,
        ...(view!=='price'?out:{}),...(view!=='facts'?{price}:{})
      });
    }catch{
      return end('source_unavailable','CATALOG_READ_FAILED');
    }
  };
}
