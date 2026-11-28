"""Reusable full-edit delivery: opening-frame title treatment, original BGM, one AVC encode."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

W,H=720,1280
NORMAL="scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24"

def run(args, mode=None):
    r=subprocess.run(args,capture_output=True,timeout=300)
    if r.returncode:
        raise RuntimeError("MEDIA_TOOL_FAILED:"+str(r.returncode))
    if mode=="json":return json.loads(r.stdout)
    return r.stdout

def load_font(path):
    from PIL import ImageFont
    path=Path(path).resolve(strict=True)
    if not path.is_file():raise ValueError("FONT_NOT_FILE")
    return ImageFont.truetype(str(path),35)

def preflight(a):
    import cv2,numpy
    enc=run([a.ffmpeg,"-nostdin","-hide_banner","-encoders"]).decode("utf-8","replace").splitlines()
    names={row.split()[1] for row in enc if len(row.split())>=2}
    if not {"libx264","aac"}<=names:raise ValueError("REQUIRED_CPU_ENCODERS_UNAVAILABLE")
    run([a.ffprobe,"-hide_banner","-version"])
    load_font(a.font)

def probe(fp,file):
    return run([fp,"-v","error","-show_streams","-show_format","-of","json",str(file)],"json")

def stream(doc,kind):
    return next(s for s in doc["streams"] if s["codec_type"]==kind)

def clean_opening(src, recipe):
    # Original picture.py's HSV masks, dilation and NS inpaint are preserved for
    # this registered reference layout, now independent of file/SKU/old wording.
    import cv2,numpy as np
    profile=recipe.get("titleProfile")
    if profile=="opening-gold-v1":
        hsv=cv2.cvtColor(src,cv2.COLOR_RGB2HSV)
        yy,xx=np.ogrid[:H,:W]
        top_bounds=((xx<307)&(yy>=153)&(yy<467))|((xx>=380)&(xx<698)&(yy>=155)&(yy<425))|((xx>=385)&(xx<479)&(yy>=425)&(yy<509))
        top_gold=(hsv[:,:,0]>=18)&(hsv[:,:,0]<=41)&(hsv[:,:,1]>=126)&(hsv[:,:,2]>=70)&top_bounds
        bottom_bounds=(xx>=208)&(xx<581)&(yy>=800)&(yy<894)
        bottom_gold=(hsv[:,:,0]>=17)&(hsv[:,:,0]<=45)&(hsv[:,:,1]>=143)&(hsv[:,:,2]>=124)&bottom_bounds
        ellipse=lambda n:cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(n,n))
        top=cv2.dilate(top_gold.astype(np.uint8),ellipse(5))
        bottom=cv2.dilate(bottom_gold.astype(np.uint8),ellipse(27))
        wide=cv2.dilate(top_gold.astype(np.uint8),ellipse(21))
        clear_black=(wide>0)&((yy<362)|((xx<153)&(yy<459))|((xx>615)&(yy<424)))
        top[clear_black]=1
        mask=top|bottom
        if mask[940:,:].any():raise ValueError("OPENING_MASK_OUTSIDE_APPROVED_REGION")
        if mask.any():src=cv2.inpaint(src,mask*255,7,cv2.INPAINT_NS)
        src[clear_black]=0
        return src,int(mask.sum())
    box=recipe.get("titleBox")
    if profile=="no-embedded-product-title":
        return src,0
    if not box:raise ValueError("REFERENCE_TITLE_RECIPE_REQUIRED")
    x,y,w,h=(box[k] for k in ("x","y","w","h"))
    if not all(type(i) is int for i in (x,y,w,h)) or min(x,y)<0 or min(w,h)<1 or x+w>W or y+h>940:
        raise ValueError("UNSAFE_TITLE_BOX")
    if box.get("startSeconds",0)<=0<box.get("endSeconds",1):
        src=src.copy();src[y:y+h,x:x+w]=0
        return src,w*h
    return src,0

def render(a):
    import numpy as np
    from PIL import Image,ImageDraw
    spec=json.loads(Path(a.spec).read_text(encoding="utf-8"))
    name=spec["name"]
    if not isinstance(name,str) or not name or len(name)>32:raise ValueError("INVALID_PRODUCT_NAME")
    source,ref,output=map(Path,(a.raw,a.reference,a.output))
    if output.exists():raise FileExistsError("OUTPUT_ALREADY_EXISTS")
    video=stream(probe(a.ffprobe,source),"video")
    audio=stream(probe(a.ffprobe,ref),"audio")
    vlen=float(video["duration"]);alen=float(audio["duration"])
    expected=float(spec["durationSeconds"])
    if abs(alen-expected)>0.25 or abs(vlen-expected)>1.0 or vlen<=10 or not 10<=expected<=180:
        raise ValueError("NOT_FULL_REFERENCE_DURATION")
    data=run([a.ffmpeg,"-nostdin","-hide_banner","-v","error","-xerror","-i",str(source),"-map","0:v:0","-vf",NORMAL,
              "-frames:v","1","-threads","1","-f","rawvideo","-pix_fmt","rgb24","-"])
    if len(data)!=W*H*3:raise ValueError("OPENING_FRAME_SIZE")
    pixels= np.frombuffer(data,np.uint8).reshape(H,W,3).copy()
    clean,treated=clean_opening(pixels,spec)
    first=Image.fromarray(clean)
    draw=ImageDraw.Draw(first)
    font=load_font(a.font)
    for size in range(35,18,-1):
        if draw.textlength(name,font=font)<W-96:break
        font=font.font_variant(size=size-1)
    if draw.textlength(name,font=font)>=W-96:raise ValueError("PRODUCT_NAME_DOES_NOT_FIT")
    draw.text((W//2,815),name,font=font,anchor="mt",fill=(232,190,84),stroke_width=2,stroke_fill=(45,28,19))
    with tempfile.TemporaryDirectory(prefix="render-",dir=output.parent) as work:
        work=Path(work); opening=work/"opening.png"; candidate=work/"output.mp4"
        first.save(opening)
        base=NORMAL
        if spec.get("titleBox") and not spec.get("titleProfile"):
            box=spec["titleBox"]
            t0=float(box.get("startSeconds",0));t1=float(box.get("endSeconds",0.042))
            if not 0<=t0<t1<=expected+0.25:raise ValueError("UNSAFE_TITLE_TIME")
            x,y,w,h=(box[k] for k in ("x","y","w","h"))
            base+=f",drawbox=x={x}:y={y}:w={w}:h={h}:color=black@1:t=fill:enable='gte(t,{t0})*lt(t,{t1})'"
        filtergraph=f"[0:v]{base}[v];[v][2:v]overlay=enable='eq(n,0)'[out]"
        run([a.ffmpeg,"-nostdin","-hide_banner","-v","error","-n","-xerror","-err_detect","explode",
            "-i",str(source),"-i",str(ref),"-i",str(opening),"-filter_complex_threads","1","-filter_complex",filtergraph,
            "-map","[out]","-map","1:a:0","-map_metadata","-1","-map_chapters","-1","-c:v","libx264","-preset","medium",
            "-profile:v","main","-level:v","3.1","-pix_fmt","yuv420p","-crf","18","-maxrate:v","4M","-bufsize:v","8M","-refs","3",
            "-tag:v","avc1","-fps_mode:v","passthrough","-video_track_timescale","12288","-x264-params","repeat-headers=0",
            "-c:a","aac","-profile:a","aac_low","-b:a","128k","-ar","44100","-ac","2","-movflags","+faststart",str(candidate)])
        loader=importlib.util.spec_from_file_location("compat_guard",Path(__file__).with_name("reference-video-guard.py"))
        guard=importlib.util.module_from_spec(loader);loader.loader.exec_module(guard)
        guard.FF=a.ffmpeg;guard.FP=a.ffprobe
        check=guard.check(candidate)
        mux=probe(a.ffprobe,candidate)
        v=stream(mux,"video");last=stream(mux,"audio")
        if not check["pass"] or abs(float(last["duration"])-alen)>0.05 or abs(float(v["duration"])-vlen)>0.09:
            raise ValueError("COMPATIBILITY_OR_DURATION_GUARD_FAILED")
        run([a.ffmpeg,"-nostdin","-hide_banner","-v","error","-xerror","-err_detect","explode","-i",str(candidate),"-map","0:v:0","-map","0:a:0","-f","null","-"])
        if output.exists():raise FileExistsError("OUTPUT_ALREADY_EXISTS")
        candidate.rename(output)
        return {"compatibility":check["checks"],"frameCount":int(v["nb_frames"]),"modelVideoSeconds":vlen,"encodedVideoSeconds":float(v["duration"]),
                "referenceAudioSeconds":alen,"encodedAudioSeconds":float(last["duration"]),"openingMaskPixels":treated,"requiresManualReview":True}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--check-deps",action="store_true")
    for key in ("ffmpeg","ffprobe","font"):p.add_argument("--"+key,required=True)
    for key in ("raw","reference","output","spec"):p.add_argument("--"+key)
    a=p.parse_args()
    preflight(a)
    print(json.dumps({"ready":True} if a.check_deps else render(a),ensure_ascii=True))

if __name__=="__main__":
    main()
