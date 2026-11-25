
export type ProductId="A"|"B";
export type Mode="album"|"catalog"|"sales"|"style"|null;
export interface Turn {text:string; productId:ProductId|null; mode:Mode}
export interface Evidence {label:string;value:string;productId:ProductId}
export interface ProductFacts {
  productId:ProductId; cardId:string; shopId:string; version:number;
  price:number|null; priceText:string|null; size:string|null; inventory:null;
}
export interface CatalogPort {read:(pid:ProductId)=>ProductFacts}

// Self-contained examples; never reads a merchant database.
const shop = "local-demo-shop";
const fields = {
  A: {price:{value:240,unit:"元"},size:{value:16,unit:"cm"}},
  B: {price:null,size:{value:18,unit:"cm"}},
} as const;
const bindings = {
  A: {id:"demo-card-a",version:1},
  B: {id:"demo-card-b",version:1},
} as const;
function isRecord(v:unknown):v is Record<string,unknown>{
  return typeof v==="object" && v!==null && !Array.isArray(v);
}
// Missing or explicitly null is not zero; malformed, negative, or non-CNY
// prices must not turn into a fabricated offer.
export function readCnyPrice(field:unknown):Pick<ProductFacts,"price"|"priceText"> {
  if(field==null || (isRecord(field) && field.value==null))
    return {price:null,priceText:null};
  if(!isRecord(field)||field.unit!=="元"||typeof field.value!=="number"||
     !Number.isFinite(field.value)||field.value<0||
     !Number.isSafeInteger(Math.round(field.value*100))||
     Number(field.value.toFixed(2))!==field.value)
    throw Error("INVALID_CARD_PRICE");
  return {price:field.value,priceText:field.value.toFixed(2)};
}
function sizeOf(field:unknown):string|null {
  if(field==null || (isRecord(field) && field.value==null))return null;
  if(!isRecord(field)||!(typeof field.value==="number" || typeof field.value==="string")||
     !String(field.value).trim()||typeof field.unit!=="string"||!field.unit.trim())
    throw Error("INVALID_CARD_SIZE");
  return String(field.value).trim()+" "+field.unit.trim();
}
export async function prepareCatalog():Promise<{catalog:CatalogPort;close:()=>void}> {
  let closed=false;
  return {catalog:{read(pid:ProductId){
    if(closed)throw Error("CATALOG_CLOSED");
    if(arguments.length!==1)throw Error("UNEXPECTED_SCOPE_ARGUMENT");
    if(pid==null)throw Error("NO_SELECTED_PRODUCT");
    if(pid!=="A"&&pid!=="B")throw Error("UNKNOWN_PRODUCT");
    const expected=bindings[pid], data=fields[pid];
    return {productId:pid,cardId:expected.id,shopId:shop,version:expected.version,
      ...readCnyPrice(data.price),size:sizeOf(data.size),inventory:null};
  }},close(){closed=true;}};
}
export const prepareFixture=prepareCatalog;
