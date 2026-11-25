
import base64
_SR,_SA=32,96
def make_subject(rgb,mask):
    m=(mask>0).astype(np.uint8)
    x,y,w,h=cv.boundingRect(m)
    if not w or not h:return {"v":1,"state":"unresolved"}
    ma=np.pad(m[y:y+h,x:x+w],2)
    r=cv.copyMakeBorder(rgb[y:y+h,x:x+w],2,2,2,2,cv.BORDER_REPLICATE)
    yv,xv=np.nonzero(ma);cx,cy=xv.mean(),yv.mean()
    radius=float(np.sqrt(np.mean((xv-cx)**2+(yv-cy)**2)))
    if radius<3:return {"v":1,"state":"unresolved"}
    dt=cv.distanceTransform(ma,cv.DIST_L2,5)
    # The outer rim and all hole boundaries are equally ineligible.
    inner=dt>=max(2.1,min(float(dt.max())*.50,1.3+.08*radius))
    if np.count_nonzero(inner)<28:return {"v":1,"state":"unresolved"}
    lab=cv.cvtColor(np.ascontiguousarray(r),cv.COLOR_RGB2LAB).astype(np.float32)
    tint=np.median(lab[inner],axis=0)
    maskf=inner.astype(np.float32)
    sigma=max(1.6,.21*radius)
    def blur(a):return cv.GaussianBlur(a,(0,0),sigma)
    # Mask-normalized filtering cannot inject a carrier or hole colour.
    lp=blur(lab*maskf[:,:,None])/np.maximum(.001,blur(maskf))[:,:,None]
    hp=(lab-lp)*maskf[:,:,None]
    # A uniform bezel concentric with a boundary is not an identifying mark.
    # Detrend the repeated effect of distance to ANY silhouette/hole boundary.
    band=(dt/max(1.,radius*.10)).astype(np.int32)
    for k in np.unique(band[inner]):
        z=inner&(band==k)
        if np.count_nonzero(z)>=12: hp[z]-=np.median(hp[z],axis=0)
    # Require native-scale microstructure as an independent qualification.
    # Smooth shading or a single broad hotspot can align in many boundary
    # sectors; those are not several distinct internal marks.
    fs=max(.85,min(3.,radius*.075))
    def fineblur(a):return cv.GaussianBlur(a,(0,0),fs)
    fine=lab-fineblur(lab*maskf[:,:,None])/np.maximum(.001,fineblur(maskf))[:,:,None]
    fine[~inner]=0
    for k in np.unique(band[inner]):
        z=inner&(band==k)
        if np.count_nonzero(z)>=12:fine[z]-=np.median(fine[z],axis=0)
    contrast=np.linalg.norm(fine,axis=2)*maskf
    peaks=0;Exx=Eyy=Exy=Et=0.
    nx=cv.Sobel(dt,cv.CV_32F,1,0,ksize=3);ny=cv.Sobel(dt,cv.CV_32F,0,1,ksize=3)
    nl=np.maximum(1.,np.hypot(nx,ny));nx/=nl;ny/=nl
    for c in range(3):
        # Shape/border gradients are not allowed to qualify the structure.
        dx=cv.Sobel(lab[:,:,c],cv.CV_32F,1,0,ksize=3);dy=cv.Sobel(lab[:,:,c],cv.CV_32F,0,1,ksize=3)
        Exx+=float(np.sum(dx[inner]**2));Eyy+=float(np.sum(dy[inner]**2));Exy+=float(np.sum(dx[inner]*dy[inner]))
        Et+=float(np.sum((dx[inner]*ny[inner]-dy[inner]*nx[inner])**2))
    isotropy=1.-np.hypot(Exx-Eyy,2*Exy)/max(1.,Exx+Eyy)
    for _ in range(8):
        _,mx,_,pt=cv.minMaxLoc(contrast)
        if mx<6.:break
        peaks+=1;cv.circle(contrast,pt,max(3,round(radius*.30)),0,-1)
    rr=(np.arange(_SR,dtype=np.float32)[:,None]+.55)*radius*.069
    theta=np.arange(_SA,dtype=np.float32)[None,:]*(2*np.pi/_SA)
    xx=(cx+rr*np.cos(theta)).astype(np.float32);yy=(cy+rr*np.sin(theta)).astype(np.float32)
    def polar(a):return cv.remap(a,xx,yy,cv.INTER_LINEAR,borderMode=cv.BORDER_CONSTANT)
    ok=polar(maskf)>.96
    out=np.clip(np.rint(polar(hp)),-100,100).astype(np.int8)
    out[~ok]=0
    # Moderate, bounded storage. No filenames, IDs, external templates or labels.
    enc=lambda b:base64.b64encode(b).decode("ascii")
    pix=len(xv)
    kp,ds=cv.SIFT_create(nfeatures=120,contrastThreshold=.016).detectAndCompute(
        cv.cvtColor(r,cv.COLOR_RGB2GRAY),maskf.astype(np.uint8))
    pp,dd,seen=[],[],set()
    if ds is not None:
        for k,v in sorted(zip(kp,ds),key=lambda kv:-kv[0].response):
            u,t=k.pt;tile=(round(u/3),round(t/3))
            if tile in seen or dt[round(t),round(u)]<max(3.2,3.5*k.size):continue
            seen.add(tile);pp.append([round((u-cx)/radius,3),round((t-cy)/radius,3)]);dd.append(v.astype(np.uint8))
            if len(pp)>=48:break
    return {"v":1,"state":"localized","polar":enc(out.tobytes()+np.packbits(ok).tobytes()),
            "tint":np.rint(tint).astype(int).tolist(),"points":pp,"sift":enc(np.asarray(dd,np.uint8).tobytes()),
            "nativeCore":int(inner.sum()),"finePeaks":peaks,"orientationDiversity":round(float(isotropy),3),
            "boundaryIndependent":round(Et/max(1.,Exx+Eyy),3)}

def _sm_unpack(obj):
    if not isinstance(obj,dict) or obj.get("v")!=1 or obj.get("state")!="localized":return None
    try:
        n=_SR*_SA;s=obj.get("polar","")
        if len(s)!=4*((3*n+n//8+2)//3):return None
        raw=base64.b64decode(s,validate=True)
        if len(raw)!=3*n+n//8:return None
        val=np.frombuffer(raw,np.int8,count=3*n).reshape(_SR,_SA,3).astype(np.float32)
        m=np.unpackbits(np.frombuffer(raw,np.uint8,offset=3*n)).reshape(_SR,_SA).astype(np.float32)
        val[:,:,1:]*=.83
        return val,m
    except (ValueError,TypeError):return None

def _sm_points(a,b):
    try:
        p,q=[np.asarray(v["points"],np.float32) for v in (a,b)]
        if not (8<=len(p)<=48 and 8<=len(q)<=48):return 0,0,False
        d,e=[np.frombuffer(base64.b64decode(v["sift"],validate=True),np.uint8).reshape(-1,128).astype(np.float32) for v in (a,b)]
        if len(d)!=len(p) or len(e)!=len(q):return 0,0,False
    except (ValueError,TypeError,KeyError):return 0,0,False
    bf=cv.BFMatcher()
    def rat(d,e):return {u.queryIdx:u.trainIdx for u,v in bf.knnMatch(d,e,k=2) if u.distance<.70*v.distance}
    f,z=rat(d,e),rat(e,d)
    pairs=[(i,j) for i,j in f.items() if z.get(j)==i];n=len(pairs)
    if n<7:return n,0,False
    s=p[[x for x,y in pairs]];t=q[[y for x,y in pairs]]
    M,ok=cv.estimateAffinePartial2D(s,t,method=cv.RANSAC,ransacReprojThreshold=.095)
    if M is None:return n,0,False
    ok=ok.ravel()>0;k=int(ok.sum())
    return n,k,k>=7 and k>=.80*n and .48<np.linalg.det(M[:,:2])<1.9 and min(cv.contourArea(cv.convexHull(v[ok])) for v in (s,t))>.28

def compare_subject(a,b):
    aa,bb=_sm_unpack(a),_sm_unpack(b)
    if aa is None or bb is None:return [1,0,0,"subject_unresolved"]
    A,m=aa;B,n=bb
    matches,inliers,kstrong=_sm_points(a,b)
    # Full circular shift search. Fourier sums evaluate all possible in-plane
    # orientations, without using the carrier axes or a fixed crop centre.
    def corr(x,y):
        return np.fft.irfft(np.sum(np.fft.rfft(x,axis=1).conj()*np.fft.rfft(y,axis=1),axis=0),n=_SA)
    w=(np.arange(_SR,dtype=np.float32)[:,None]+.55)/12
    area=corr(m*w,n);overlap=area/max(float((w*m).sum()),float((w*n).sum()),1.)
    energyA=np.sum(A*A,axis=2);energyB=np.sum(B*B,axis=2)
    ea=corr(energyA*w,n);eb=corr(m*w,energyB)
    dot=sum(corr(A[:,:,i]*w,B[:,:,i]) for i in range(3))
    score=dot/np.sqrt(np.maximum(1.,ea*eb))
    permitted=(overlap>.59)&(area>70)
    if not np.any(permitted):
        return [0 if overlap.max()<.31 else 1,matches,inliers,"subject_conflict" if overlap.max()<.31 else "subject_partial_overlap"]
    score=np.where(permitted,score,-1);k=int(np.argmax(score));sim=float(score[k])
    # corr(x,y)[k] compares x[j] to y[j+k].
    B=np.roll(B,-k,axis=1);n=np.roll(n,-k,axis=1);joint=(m*n)>0
    eA=np.sqrt(np.sum(A*A,axis=2));eB=np.sqrt(np.sum(B*B,axis=2))
    tint=float(np.linalg.norm(np.asarray(a["tint"])[1:]-np.asarray(b["tint"])[1:]))
    sel=joint&(np.maximum(eA,eB)>6.)
    agreement=np.sum(A*B,axis=2)/np.maximum(1.,eA*eB)
    good=sel&(np.minimum(eA,eB)>4.5)&(agreement>.67)&(np.minimum(eA,eB)>.31*np.maximum(eA,eB))
    # Require corroboration from multiple spatial areas in the subject's own
    # frame. A single pixel, a homogeneous coloured chip, or a ring outline is
    # never sufficient. Avoid treating duplicated centre samples as many marks.
    radial=np.arange(_SR)[:,None]
    informative=good&(radial>=4)
    sectors=int(np.count_nonzero(informative.reshape(_SR,12,8).sum(axis=(0,2))>=3))
    radialBands=int(np.count_nonzero(informative.reshape(8,4,_SA).sum(axis=(1,2))>=4))
    mass=float((w*informative).sum());fraction=mass/max(1.,float((w*sel).sum()))
    enough=int(a.get("nativeCore",0))>=36 and int(b.get("nativeCore",0))>=36
    # Wholly different chroma is contradictory on an isolated common subject
    # type; colour alone remains deliberately insufficient for a positive.
    if tint>30 and sim<.63:return [0,matches,inliers,"subject_conflict"]
    complexDetail=all(z.get("finePeaks",0)>=3 and z.get("orientationDiversity",0)>=.20 and
                      z.get("boundaryIndependent",0)>=.17 for z in (a,b))
    if tint<=24 and enough and complexDetail and ((sim>=.74 and mass>=26 and sectors>=3 and radialBands>=2 and fraction>=.50) or
       (kstrong and sim>=.36 and mass>=24 and sectors>=3)):
        return [2,matches,inliers,"subject_internal_agreement"]
    powerA=float(np.sqrt(np.sum(w*eA**2*m)/max(1.,np.sum(w*m))))
    powerB=float(np.sqrt(np.sum(w*eB**2*n)/max(1.,np.sum(w*n))))
    if enough and sim<.46 and min(powerA,powerB)>3.5 and not kstrong:
        return [0,matches,inliers,"subject_conflict"]
    return [1,matches,inliers,"subject_insufficient_marks"]
