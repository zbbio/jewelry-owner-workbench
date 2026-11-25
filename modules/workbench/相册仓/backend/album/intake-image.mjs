import {execFile} from 'node:child_process';

// Same bounded Pillow decode as the workbench, without normalization, CV, lookup, or classification.
// The MIME is derived from the bytes; filenames, EXIF and client-provided category never leave this process.
const decode=String.raw`import io,json,sys,warnings
from PIL import Image
Image.MAX_IMAGE_PIXELS=20000000
warnings.simplefilter("error", Image.DecompressionBombWarning)
raw=sys.stdin.buffer.read(8*1024*1024+1)
try:
    if not 0<len(raw)<=8*1024*1024: raise ValueError()
    with Image.open(io.BytesIO(raw)) as im:
        mime=Image.MIME.get(im.format)
        if mime not in ("image/jpeg","image/png","image/webp") or im.width*im.height>20000000 or getattr(im,"n_frames",1)!=1:
            raise ValueError()
        im.verify()
    with Image.open(io.BytesIO(raw)) as im:
        im.load()
    print(json.dumps({"mime":mime,"f":None}))
except Exception:
    print('{"error":"invalid_image"}')
`;
export function inspectOriginal(bytes){
  return new Promise((resolve,reject)=>{
    const p=execFile(process.env.ALBUM_PYTHON||'python',['-B','-c',decode],
      {windowsHide:true,timeout:15000,maxBuffer:64*1024},(e,stdout)=>{
        if(e){reject(Object.assign(new Error('intake_decoder_unavailable'),{code:'intake_decoder_unavailable'}));return;}
        try{resolve(JSON.parse(stdout));}catch{reject(Object.assign(new Error('intake_decoder_unavailable'),{code:'intake_decoder_unavailable'}));}
      });
    p.stdin.on('error',()=>{});p.stdin.end(bytes);
  });
}
