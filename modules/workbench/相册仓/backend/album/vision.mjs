import {surfaceCore} from './local-surface.mjs';
import {fileURLToPath} from 'node:url';
// Short, transparent, local Python loaders keep Windows command lines bounded
// even when offline diagnostics append their own fixtures. No generated code,
// hidden payloads, or runtime writes to the installation directory.
function moduleLoader(name){
  const path=JSON.stringify(fileURLToPath(new URL(name,import.meta.url)));
  return '\nwith open('+path+', "rb") as _mod: exec(compile(_mod.read(), '+path+', "exec"), globals())\n';
}
const subjectLocateCore=moduleLoader('./subject-locate.py'),subjectMatchCore=moduleLoader('./subject-match.py');
export const recognitionMethod='foreground-nested-subject-polar-v2.2';
export const visionCore = String.raw`import sys, json, io, warnings
from PIL import Image, ImageOps
warnings.simplefilter("error", Image.DecompressionBombWarning)
Image.MAX_IMAGE_PIXELS = 20000000
import numpy as np
import cv2 as cv
cv.setNumThreads(1)
` + surfaceCore + subjectLocateCore + subjectMatchCore + String.raw`

def inspect(raw, trace=None):
    with Image.open(io.BytesIO(raw)) as im:
        mime = Image.MIME.get(im.format)
        if trace is not None:
            trace.update(format=im.format, inputSize=list(im.size), decoded=False)
        if mime not in ("image/jpeg","image/png","image/webp") or im.width*im.height>20000000 or getattr(im,"n_frames",1)!=1:
            raise ValueError("unsupported_image")
        im.verify()
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im).convert("RGBA")
        im.thumbnail((640,640))
        a = np.asarray(im)
    if trace is not None:
        trace.update(decoded=True, featureImageSize=[int(a.shape[1]),int(a.shape[0])])
    return {"mime":mime,"f":features(a,trace)}

def features(a,trace=None):
    witness=None
    def stop(code):
        if trace is not None: trace["firstReject"]=code
        return [[],[],None,witness] if witness and witness["mode"]!="none" else None
    if trace is not None:
        trace.update(firstReject=None, foreground=None, siftDetected=None, validKeypoints=None, descriptorRows=0)
    rgb = np.ascontiguousarray(a[:,:,:3])
    if min(rgb.shape[:2])<48: return stop("short_side_below_48")
    if np.mean(a[:,:,3]<10)>.08:
        m = a[:,:,3]>245
        if trace is not None: trace["foreground"]={"route":"alpha"}
    else:
        lab = cv.cvtColor(rgb,cv.COLOR_RGB2LAB).astype(np.float32)
        edge = np.concatenate([lab[:3].reshape(-1,3),lab[-3:].reshape(-1,3),lab[:,:3].reshape(-1,3),lab[:,-3:].reshape(-1,3)])
        bg = np.median(edge,axis=0)
        spread = np.percentile(np.linalg.norm(edge-bg,axis=1),95)
        if trace is not None: trace["foreground"]={"route":"border_lab","borderP95":float(spread),"maxP95":22}
        if spread>22: return stop("border_p95_gt_22")
        m = np.linalg.norm(lab-bg,axis=2)>max(20,spread+12)
    m = cv.morphologyEx(m.astype(np.uint8),cv.MORPH_OPEN,np.ones((3,3),np.uint8))
    n,labels,stats,_ = cv.connectedComponentsWithStats(m)
    if trace is not None: trace["foreground"]["components"]=int(n-1)
    if n<2: return stop("no_foreground_component")
    i = 1+np.argmax(stats[1:,cv.CC_STAT_AREA])
    x,y,w,h,area = stats[i]
    H,W = m.shape
    if trace is not None:
        trace["foreground"].update(areaPixels=int(area),areaFraction=float(area/(H*W)),
            dominantFraction=float(area/m.sum()),borderClearance=int(min(x,y,W-x-w,H-y-h)))
    if area<.02*H*W: return stop("area_below_minimum")
    if area>.86*H*W: return stop("area_above_maximum")
    if area<.80*m.sum(): return stop("ambiguous_components")
    if min(x,y,W-x-w,H-y-h)<2: return stop("component_touches_border")
    m = (labels==i).astype(np.uint8)
    mode,inner,diag=locate_inner(rgb,m)
    witness={"v":22,"mode":mode,"diag":diag}
    if mode=="found": witness["subject"]=make_subject(rgb,inner)
    if trace is not None:
        trace["innerSubject"]={"mode":mode,**diag}
        if mode=="found":trace["innerSubject"]["state"]=witness["subject"].get("state")
    dist = cv.distanceTransform(m,cv.DIST_L2,5)
    gray = cv.cvtColor(rgb,cv.COLOR_RGB2GRAY)
    gray[m==0] = 127
    kp,d = cv.SIFT_create(nfeatures=600).detectAndCompute(gray,m)
    if trace is not None: trace.update(siftDetected=len(kp),validKeypoints=0)
    if d is None: return stop("no_sift_descriptors")
    p,desc,seen = [],[],set()
    for k,v in sorted(zip(kp,d),key=lambda z:-z[0].response):
        u,t=k.pt
        tile=(round(u/3),round(t/3))
        if tile in seen or dist[round(t),round(u)] < max(5,4*k.size): continue
        seen.add(tile); p.append([round(float((u-x)/w),4),round(float((t-y)/h),4)]); desc.append(v.astype(np.uint8).tolist())
        if len(p)==140: break
    if trace is not None: trace["validKeypoints"]=len(p)
    if len(p)<12: return stop("fewer_than_12_safe_keypoints")
    if trace is not None: trace["descriptorRows"]=len(desc)
    return [p,desc,pack_surface(rgb,m,x,y,w,h),witness]

def carrier_compare(a,b,cache=None):
    if not a or not b: return [0,0,0,"no_features"]
    p,d=a[:2]; q,e=b[:2]
    if len(p)<2 or len(q)<2: return [0,0,0,"no_carrier_keypoints"]
    d,e=np.asarray(d,np.float32),np.asarray(e,np.float32)
    bf=cv.BFMatcher()
    def good(d,e):
        return {u.queryIdx:u.trainIdx for u,v in bf.knnMatch(d,e,k=2) if u.distance<.72*v.distance}
    forward,reverse=good(d,e),good(e,d)
    pairs=[(p[i],q[j]) for i,j in forward.items() if reverse.get(j)==i]
    if len(pairs)<6: return [0,len(pairs),0,"no_correspondence"]
    s,t=(np.ascontiguousarray(v) for v in np.asarray(pairs,np.float32).transpose(1,0,2))
    M,ok=cv.estimateAffine2D(s,t,method=cv.RANSAC,ransacReprojThreshold=.035)
    if M is None: return [0,len(pairs),0,"no_geometry"]
    ok=ok.ravel().astype(bool); n=int(ok.sum())
    if n<3: return [0,len(pairs),n,"no_geometry"]
    spread=min(cv.contourArea(cv.convexHull(v[ok])) for v in (s,t))
    geom=np.linalg.det(M[:,:2])>0 and np.linalg.cond(M[:,:2])<3
    strong=geom and n>=12 and n>=.75*len(pairs) and spread>=.09
    if not geom or n<8 or n<.68*len(pairs) or spread<.06: return [1,len(pairs),n,"weak_geometry"]
    def surf(f):
        if cache is None: return unpack_surface(f)
        if id(f) not in cache: cache[id(f)]=unpack_surface(f)
        return cache[id(f)]
    a,b=surf(a),surf(b)
    if a is None or b is None: return [1,len(pairs),n,"missing_current_surface"]
    level,reason=surface_vote(a,b,M)
    if level in (0,2):
        # Sampling a scaled/rotated field in just one direction may conceal
        # small details. Disagreement is not a sufficient match OR mismatch.
        reverse,_=surface_vote(b,a,cv.invertAffineTransform(M))
        if reverse!=level: level,reason=1,"asymmetric_surface_evidence"
    if level==2 and not strong: level,reason=1,"weak_geometry"
    return [level,len(pairs),n,reason]

def compare_detail(a,b,cache=None):
    if not a or not b:return [0,0,0,"no_features"]
    def current(f):
        return f[3] if isinstance(f,list) and len(f)>3 and isinstance(f[3],dict) and f[3].get("v")==22 else {}
    A,B=current(a),current(b)
    if not A or not B:
        old=carrier_compare(a,b,cache)
        return [min(old[0],1),*old[1:3],"missing_current_subject"]
    am,bm=A.get("mode"),B.get("mode")
    if am=="found" and bm=="found": return compare_subject(A.get("subject"),B.get("subject"))
    if am=="none" and bm=="none":return carrier_compare(a,b,cache)
    # Mixed/ambiguous localization is never evidence of identity. Treat it as
    # a weak competing edge only when geometry suggests a related reference.
    old=carrier_compare(a,b,cache)
    return [int(old[0]>0),*old[1:3],"subject_localization_inconsistent"]

def compare(a,b):
    return compare_detail(a,b)[:3]

`;

export const vision = visionCore + String.raw`if sys.argv[1]=="image":
    try: print(json.dumps(inspect(sys.stdin.buffer.read())))
    except (OSError,ValueError,SyntaxError,Image.DecompressionBombError,Image.DecompressionBombWarning): print('{"error":"invalid_image"}')
else:
    f,pairs=json.load(sys.stdin)
    cache={}
    print(json.dumps([compare_detail(f[i],f[j],cache) for i,j in pairs]))
`;
