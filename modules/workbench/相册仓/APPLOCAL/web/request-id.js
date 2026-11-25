const aliasOk=v=>v==='A'||v==='B';
const requestIdV4=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function newRequestId(source) {
  verify(source&&typeof source.getRandomValues==='function','WEB_CRYPTO_UNAVAILABLE');
  if(typeof source.randomUUID==='function') {
    const id=source.randomUUID();
    verify(requestIdV4(id),'INVALID_RANDOM_UUID');
    return id;
  }
  const b=new Uint8Array(16);
  source.getRandomValues(b);
  b[6]=(b[6]&0x0f)|0x40; // version 4
  b[8]=(b[8]&0x3f)|0x80; // RFC variant 10xxxxxx
  const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}
const verify=(ok,code)=>{if(!ok)throw Error(code);};
if(typeof module!=='undefined'&&module.exports)module.exports={newRequestId,requestIdV4};
