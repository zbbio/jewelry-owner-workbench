// A shadow experiment. Not imported by the intake service. No card lookup,
// grouping, persistence or receipt; a mask is only a hypothesis.
import {visionCore} from './vision.mjs';

export const foregroundProbe = visionCore + String.raw`
def _overlap(a,b):
    u=np.count_nonzero(a|b)
    return float(np.count_nonzero(a&b)/u) if u else 0.

def _consensus(rgb):
    # Two alternative initializations, checked against border colour novelty.
    # Do not use position, border colours or silhouette as an identity score.
    H,W=rgb.shape[:2]; scale=min(1.,320/max(H,W)); w,h=round(W*scale),round(H*scale)
    img=cv.resize(rgb,(w,h),interpolation=cv.INTER_AREA)
    band=max(3,min(w,h)//20)
    rim=np.ones((h,w),bool);rim[band:-band,band:-band]=False
    lab=cv.cvtColor(img,cv.COLOR_RGB2LAB).astype(np.float32)
    edge=lab[rim]; bins=(edge.astype(np.int32)//16)
    key=(bins[:,0]*16+bins[:,1])*16+bins[:,2]
    keys,counts=np.unique(key,return_counts=True)
    nearest=np.full((h,w),np.inf,np.float32)
    for j in np.argsort(-counts,kind="stable")[:48]:
        center=edge[key==keys[j]].mean(axis=0)
        nearest=np.minimum(nearest,np.linalg.norm(lab-center,axis=2))
    novel=(nearest>np.percentile(nearest[rim],99)+16).astype(np.uint8)
    novel=cv.morphologyEx(novel,cv.MORPH_OPEN,np.ones((3,3),np.uint8))
    n,labels,stats,_=cv.connectedComponentsWithStats(novel)
    if n<2: return None,{"reject":"no_novel_region"}
    i=1+np.argmax(stats[1:,cv.CC_STAT_AREA]);x,y,bw,bh,area=stats[i]
    if area<.02*h*w or area>.86*h*w or area<.80*novel.sum() or min(x,y,w-x-bw,h-y-bh)<band:
        return None,{"reject":"ambiguous_colour_support"}
    seed=(labels==i).astype(np.uint8)
    kernel=np.ones((7,7),np.uint8);inside=cv.erode(seed,kernel)>0
    if not np.any(inside): return None,{"reject":"no_interior_seed"}
    trimap=np.full(seed.shape,cv.GC_PR_BGD,np.uint8)
    trimap[cv.dilate(seed,kernel)>0]=cv.GC_PR_FGD
    trimap[inside]=cv.GC_FGD;trimap[rim]=cv.GC_BGD
    def cut(mask,rect,mode):
        cv.setRNGSeed(0)
        cv.grabCut(img,mask,rect,np.zeros((1,65),np.float64),np.zeros((1,65),np.float64),5,mode)
        return (mask&1)!=0
    try:
        rect=cut(np.zeros_like(seed),(band,band,w-2*band,h-2*band),cv.GC_INIT_WITH_RECT)
        seeded=cut(trimap,None,cv.GC_INIT_WITH_MASK)
    except cv.error:
        return None,{"reject":"segmentation_unavailable"}
    chroma=seed>0
    agreement=[_overlap(rect,seeded),_overlap(rect,chroma),_overlap(seeded,chroma)]
    meta={"maskIoUs":agreement}
    if min(agreement)<.80:
        return None,{**meta,"reject":"mask_disagreement"}
    safe=(rect&seeded&chroma).astype(np.uint8)
    return cv.resize(safe,(W,H),interpolation=cv.INTER_NEAREST)>0,meta

def shadow_features(a):
    prior={};f=features(a,prior)
    meta={"baseline":prior}
    if f is not None or prior["firstReject"]!="border_p95_gt_22": return f,meta
    mask,consensus=_consensus(np.ascontiguousarray(a[:,:,:3]))
    meta["consensus"]=consensus
    if mask is None: return None,meta
    candidate=a.copy();candidate[:,:,3]=mask.astype(np.uint8)*255
    inner={};f=features(candidate,inner);meta["interior"]=inner
    # features() still enforces the same clearance, safe keypoints and
    # descriptor minimum. Comparisons must still use the original compare().
    return f,meta

def shadow_compare(a,b):
    # Independently fit both directions. Mutual descriptor matches alone
    # are not two geometric checks. A weak side may never upgrade the other.
    forward=compare(a,b);reverse=compare(b,a)
    return min(forward[0],reverse[0]),forward,reverse
`;
