export const token=x=>typeof x==='string'&&/^[\w.:-]{1,128}$/u.test(x);
export const version=x=>Number.isSafeInteger(x)&&x>0;
export const failure=(code,httpStatus)=>Object.assign(new Error(code),{code,httpStatus});
export const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
export function owner(ctx){
  if(!ctx||![ctx.shopId,ctx.actorId,ctx.sessionId].every(token))throw failure('SESSION_REQUIRED',401);
  if(ctx.role!=='owner')throw failure('FORBIDDEN',403);
  return ctx;
}
export function exact(x,required,optional=[]){
  if(!record(x)||required.some(k=>!Object.hasOwn(x,k))||Object.keys(x).some(k=>![...required,...optional].includes(k)))
    throw failure('INVALID_REQUEST',400);
  return x;
}
