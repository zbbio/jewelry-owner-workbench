
def locate_inner(rgb,carrier):
    h0,w0=carrier.shape
    scale=min(1.,360/max(w0,h0));w,h=max(1,round(w0*scale)),max(1,round(h0*scale))
    image=cv.resize(rgb,(w,h),interpolation=cv.INTER_AREA)
    support=(cv.resize(carrier.astype(np.uint8),(w,h),interpolation=cv.INTER_NEAREST)>0).astype(np.uint8)
    if w<40 or h<40 or support.sum()<350: return "none",None,{}
    # Boundary pixels can contain JPEG halos from the outer background.
    dis=cv.distanceTransform(np.pad(support,1),cv.DIST_L2,5)[1:-1,1:-1]
    scale_s=float(np.sqrt(support.sum())); quiet=dis>max(2.5,.016*scale_s)
    rim=quiet&(dis<max(7,.12*scale_s))
    if np.count_nonzero(rim)<80: return "none",None,{}
    lab=cv.cvtColor(image,cv.COLOR_RGB2LAB).astype(np.float32)
    lab=cv.GaussianBlur(lab,(0,0),1.25)
    # Learn the distribution of the carrier rim separately for each image.
    # Illumination varies most strongly in L; no assumed hue, dimensions or centre.
    metric=lab*np.array([.56,1.15,1.15],np.float32)
    edge=metric[rim]
    bins=(edge//8).astype(np.int32)
    keys=bins[:,0]*4096+bins[:,1]*64+bins[:,2]
    uk,cnt=np.unique(keys,return_counts=True)
    d2=np.full((h,w),np.inf,np.float32)
    for j in np.argsort(-cnt,kind="stable")[:48]:
        v=edge[keys==uk[j]].mean(axis=0)
        d2=np.minimum(d2,np.sum((metric-v)**2,axis=2))
    novelty=np.sqrt(d2)
    base=max(9.,float(np.percentile(novelty[rim],99.5))+3)
    st=np.ones((3,3),np.uint8)
    amount=int(support.sum());minimum=max(55,int(.0045*amount))
    votes=[]
    def fill_pinholes(mask):
        # Close tiny specular islands, preserving meaningful holes in rings.
        n,lab0,stat,_=cv.connectedComponentsWithStats((1-mask).astype(np.uint8))
        for i in range(1,n):
            x,y,ww,hh,ar=stat[i]
            if x and y and x+ww<w and y+hh<h and ar<.035*mask.sum():mask[lab0==i]=1
        return mask
    def propose(mask,kind,strength):
        ys,xs=np.nonzero(mask);area=len(ys)
        if area<minimum or area>.67*amount: return
        if np.percentile(dis[ys,xs],1)<max(2.8,.012*scale_s): return
        bw,bh=int(np.ptp(xs))+1,int(np.ptp(ys))+1
        if min(bw,bh)<9 or area/(bw*bh)<.09: return
        votes.append((mask.astype(bool),kind,strength))
    for j,cut in enumerate((base,base+5,base+10)):
        seed=(quiet&(novelty>cut)).astype(np.uint8)
        seed=cv.morphologyEx(seed,cv.MORPH_CLOSE,st)
        n,lab1,stat,_=cv.connectedComponentsWithStats(seed)
        for i in np.argsort(stat[1:,cv.CC_STAT_AREA])[::-1][:12]+1:
            if stat[i,cv.CC_STAT_AREA]<minimum: break
            mask=(lab1==i).astype(np.uint8)
            if np.percentile(novelty[mask>0],55)<base+6: continue
            propose(fill_pinholes(mask),"c"+str(j),float(np.percentile(novelty[mask>0],55)))
    # A smooth, similarly coloured bead on a grainy surface may have no hue
    # boundary at all. Search texture energy independently at two scales;
    # demand support-wide AND immediately neighbouring material contrast.
    energy=np.linalg.norm(metric-cv.GaussianBlur(metric,(0,0),2.4),axis=2)
    for j,sigma in enumerate((1.9,3.0)):
        en=cv.GaussianBlur(energy,(0,0),sigma)
        ref=float(np.median(en[rim]))
        if ref<2.4:continue
        for tag,seed in (("flat",(en<max(.65,.26*ref))),("rough",(en>max(ref*2.7,ref+6)))):
            seed=(quiet&seed).astype(np.uint8);seed=cv.morphologyEx(seed,cv.MORPH_CLOSE,st)
            n,ll,ss,_=cv.connectedComponentsWithStats(seed)
            for i in np.argsort(ss[1:,cv.CC_STAT_AREA])[::-1][:8]+1:
                if ss[i,cv.CC_STAT_AREA]<minimum:break
                z=(ll==i).astype(np.uint8)
                flank=(cv.dilate(z,np.ones((13,13),np.uint8))>0)&(z==0)&quiet
                if flank.sum()<36:continue
                local=float(np.median(en[flank]));val=float(np.median(en[z>0]))
                if (tag=="flat" and val<.38*local) or (tag=="rough" and val>2.1*max(1.,local)):
                    propose(fill_pinholes(z),"t"+tag+str(j),max(13.,abs(val-local)*4))
    # Find non-chromatic objects as well: only closed, persistent edges with
    # measurable contrast along their perimeter, not arbitrary SIFT clusters.
    for j,sig in enumerate((max(1.25,scale_s*.009),max(2.,scale_s*.015))):
        sm=cv.GaussianBlur(lab,(0,0),sig)
        eg=np.zeros((h,w),np.uint8)
        for k in range(3):
            u=np.uint8(sm[:,:,k]);dx=cv.Sobel(u,cv.CV_32F,1,0);dy=cv.Sobel(u,cv.CV_32F,0,1)
            mag=cv.magnitude(dx,dy)
            high=max(13,float(np.percentile(mag[rim],97.5))*1.12)
            eg|=cv.Canny(u,high*.48,high,L2gradient=True)
        eg[~quiet]=0
        eg=cv.morphologyEx(eg,cv.MORPH_CLOSE,st)
        contours,_=cv.findContours(eg,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE)
        delta=np.linalg.norm(lab-cv.GaussianBlur(lab,(0,0),max(3.,sig*2.2)),axis=2)
        inkref=max(13.,float(np.percentile(delta[rim],94))+3)
        accepted=0
        for c in sorted(contours,key=cv.contourArea,reverse=True):
            area=cv.contourArea(c)
            if area<minimum: break
            if area>.67*amount:continue
            peri=cv.arcLength(c,True)
            if peri==0 or 4*np.pi*area/peri**2<.18:continue
            mask=np.zeros_like(support);cv.drawContours(mask,[c],0,1,cv.FILLED)
            # Distinct local material/texture separated from its surroundings,
            # not a normal smooth blob inside an otherwise random texture.
            kk=np.ones((9,9),np.uint8)
            outside=(cv.dilate(mask,kk)>0)&(mask==0)&quiet
            interior=cv.erode(mask,st)>0
            if outside.sum()<32 or interior.sum()<32:continue
            v=metric[interior];ext=metric[outside]
            med=np.median(v,axis=0);out=np.median(ext,axis=0)
            contrast=float(np.linalg.norm(med-out))
            # For an outlined subject with equally coloured interior and tray,
            # check that most contour points have an actual strong dark/light
            # line relative to their local surroundings, not a textured loop.
            outline=cv.morphologyEx(mask,cv.MORPH_GRADIENT,st)>0
            ink=float(np.percentile(delta[outline],45))
            if contrast<12 and ink<inkref:continue
            if contrast<12 and np.linalg.norm(np.std(v,axis=0)-np.std(ext,axis=0))<5 and ink<18:continue
            propose(mask,"e"+str(j),max(contrast,ink))
            accepted+=1
            if accepted>=16:break
    if len(votes)<2: return "none",None,{}
    # Multi-threshold/scale agreement. Deduplicate adjacent closed edges.
    clusters=[]
    for m,kind,strength in votes:
        best=None;score=0.
        for c in clusters:
            a=c[0];inter=np.count_nonzero(a&m);over=inter/max(1,np.count_nonzero(a|m))
            if over>.60 and over>score:best,score=c,over
        if best is None:clusters.append([m,{kind},strength])
        else:
            best[1].add(kind);best[2]=max(best[2],strength)
            # Preserve holes from chromatic segmentation instead of filling the
            # inner circle with carrier texture.
    confirmed=[c for c in clusters if (len(c[1])>=2 and c[2]>=12.)]
    if not confirmed:return "none",None,{}
    confirmed.sort(key=lambda c:(len(c[1]),c[2],c[0].sum()),reverse=True)
    chosen=confirmed[0][0]
    outer=np.zeros_like(support);cont,_=cv.findContours(chosen.astype(np.uint8),cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);cv.drawContours(outer,cont,-1,1,cv.FILLED)
    for oth,_,_ in confirmed[1:]:
        common=int((chosen&oth).sum());frac=common/max(1,min(chosen.sum(),oth.sum()))
        if frac>.72 or np.count_nonzero((outer>0)&oth)>.90*oth.sum(): continue
        if oth.sum()>=max(minimum,.14*chosen.sum()):return "ambiguous",None,{"reason":"separate_persistent_regions"}
    # Recover holes in an edge-proposed object: contiguous areas that return
    # to the local carrier colour AND have a closed strong surrounding material.
    if not any(k.startswith("c") for k in confirmed[0][1]):
        material=(chosen&(novelty>base+2)).astype(np.uint8)
        if material.sum()>.13*chosen.sum():
            n,ll,ss,_=cv.connectedComponentsWithStats((chosen&~(material>0)).astype(np.uint8))
            boundary=cv.morphologyEx(chosen.astype(np.uint8),cv.MORPH_GRADIENT,st)>0
            for i in range(1,n):
                pit=ll==i
                if pit.sum()>.05*chosen.sum() and not np.any(pit&boundary):chosen=chosen&~pit
    # A closed inner contour can be the hole of an achromatic ring: retaining
    # the textured tray visible through it would recreate the original error.
    # Treat enclosed, carrier-like islands as unsupported, not identity pixels.
    for oth,_,_ in confirmed[1:]:
        area=int(oth.sum()); left=int(chosen.sum())
        if not (.055*left<area<.76*left) or (oth&chosen).sum()<.88*area:continue
        if np.percentile(novelty[oth],65)<base and np.percentile(en[oth],50) <= 2.2*max(1.,float(np.median(en[rim]))):
            chosen=chosen&~oth
    out=cv.resize(chosen.astype(np.uint8),(w0,h0),interpolation=cv.INTER_NEAREST)&carrier.astype(np.uint8)
    return "found",out,{"areaFraction":round(float(chosen.sum()/amount),4),"votes":sorted(confirmed[0][1])}
