// A fixed-size appearance witness in the existing SIFT reference frame.
// No stored carrier, centre crop, training data, source ID or input pathname.
export const surfaceCore = String.raw`
import base64
_SIDE=96
_WITNESS_BYTES=_SIDE*_SIDE + 2*(_SIDE//2)**2 + _SIDE*_SIDE//8
def pack_surface(rgb,m,x,y,w,h):
    r=rgb[y:y+h,x:x+w].copy()
    inner=m[y:y+h,x:x+w]
    r[inner==0]=127
    l=cv.resize(cv.cvtColor(r,cv.COLOR_RGB2GRAY),(_SIDE,_SIDE),interpolation=cv.INTER_AREA)
    chroma=cv.resize(cv.cvtColor(r,cv.COLOR_RGB2LAB)[:,:,1:],(_SIDE//2,_SIDE//2),interpolation=cv.INTER_AREA)
    mask=cv.resize(inner.astype(np.float32),(_SIDE,_SIDE),interpolation=cv.INTER_AREA)>.97
    raw=l.tobytes()+chroma.tobytes()+np.packbits(mask).tobytes()
    return {"v":2,"data":base64.b64encode(raw).decode("ascii")}

def unpack_surface(f):
    if not isinstance(f,list) or len(f)<3 or not isinstance(f[2],dict) or f[2].get("v")!=2: return None
    s=f[2].get("data")
    if not isinstance(s,str) or len(s)!=4*((_WITNESS_BYTES+2)//3): return None
    try: r=np.frombuffer(base64.b64decode(s,validate=True),np.uint8)
    except ValueError: return None
    if len(r)!=_WITNESS_BYTES: return None
    n=_SIDE*_SIDE
    a=r[:n].reshape(_SIDE,_SIDE).astype(np.float32)
    ab=cv.resize(r[n:n+n//2].reshape(_SIDE//2,_SIDE//2,2),(_SIDE,_SIDE)).astype(np.float32)
    mask=np.unpackbits(r[n+n//2:]).reshape(_SIDE,_SIDE).astype(np.float32)
    return a,ab,mask

def surface_vote(source,target,M):
    # Forward affine registration maps normalized bbox coordinates. Evaluate
    # the overlapping interiors only; never use boundary/outline correlations.
    a,ab,ma=source;b,bc,mb=target
    T=M.copy();T[:,2]*=_SIDE
    def warp(v): return cv.warpAffine(v,T,(_SIDE,_SIDE),flags=cv.INTER_LINEAR)
    a,ab,ma=warp(a),warp(ab),warp(ma)
    joint=((ma>.98)&(mb>.98)).astype(np.uint8)
    overlap=int(joint.sum()); denom=max(int(np.count_nonzero(ma>.98)),int(mb.sum()),1)
    if overlap/denom<.75: return 1,"insufficient_overlap"
    def core(w):
        return cv.erode(joint,np.ones((w,w),np.uint8),borderType=cv.BORDER_CONSTANT,borderValue=0)>0
    inside=core(7)
    if int(inside.sum())<100: return 1,"insufficient_interior"
    # A global exposure or white-balance change is not an insert swap.
    dl=a-b;dl-=np.median(dl[inside]);dc=ab-bc
    tint=np.median(dc[inside],axis=0);dc-=tint
    colour=np.linalg.norm(dc,axis=2)
    votes=[];supported=[]
    for w in (7,13):
        def mean(x): return cv.blur(x,(w,w))
        am,bm=mean(a),mean(b)
        va=np.maximum(0,mean(a*a)-am*am);vb=np.maximum(0,mean(b*b)-bm*bm)
        rho=np.clip((mean(a*b)-am*bm)/np.sqrt(np.maximum(1,va*vb)),-1,1)
        valid=core(w)
        texture=valid&(va>=16)&(vb>=16)
        # Low correlation on BOTH visibly textured surfaces, or a spatially
        # coherent change in chroma. Not merely the absence of matched points.
        bad=texture&(rho<.47)
        chromatic=valid&(mean(colour)>15)
        changed=bad|chromatic
        ambiguous=valid&((np.maximum(va,vb)>=36)&(np.minimum(va,vb)<.18*np.maximum(va,vb)) | (abs(mean(dl))>20))
        votes.append((changed,ambiguous))
        supported.append((texture&(rho>=.74),texture))
    def component(bits):
        _,_,stats,_=cv.connectedComponentsWithStats(bits.astype(np.uint8),connectivity=8)
        return int(stats[1:,cv.CC_STAT_AREA].max()) if len(stats)>1 else 0
    # Require agreement across scales and a contiguous patch, not scattered
    # JPEG noise. A detail visible on only one side is ambiguous (e.g. glare).
    if component(votes[0][0]&votes[1][0])>=max(24,.006*int(inside.sum())): return 0,"local_surface_conflict"
    if component(votes[0][1]&votes[1][1])>=max(35,.012*int(inside.sum())): return 1,"possible_occlusion"
    if np.linalg.norm(tint)>15: return 1,"inconsistent_global_colour"
    agree,inform=supported[0]
    if int(agree.sum())<max(60,.15*int(inside.sum())) or int(agree.sum())<.82*int(inform.sum()):
        return 1,"insufficient_surface_agreement"
    return 2,"surface_agreement"
`;
