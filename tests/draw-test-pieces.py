"""Standalone synthetic development drawings, not physical inventory/holdout data.
Writes only six length-prefixed JPEG buffers; no item, category or pose metadata enters recognition.
"""
import io,struct,sys
import cv2 as cv
import numpy as np
from PIL import Image
cv.setNumThreads(1)
family=sys.argv[1]
if family not in ('tiny_seal','recess_twins'): raise SystemExit('unknown scene')
h,w=344,448; bh,bw=214,294
y,x=np.mgrid[:bh,:bw]
rng=np.random.default_rng(6701)
coarse=cv.resize(rng.normal(0,1,(28,44)).astype('float32'),(bw,bh),interpolation=cv.INTER_CUBIC)
fine=cv.resize(rng.normal(0,1,(60,100)).astype('float32'),(bw,bh),interpolation=cv.INTER_CUBIC)
grain=12*coarse+9*fine+4*np.sin(x/8+y/17)
board=(np.array([132,107,86])+grain[:,:,None]*np.array([.85,1.0,.72])).clip(0,255).astype('uint8')
# Isolated paper field and a real tray with rounded corners; no test masks exported to the app.
bm=np.zeros((bh,bw),'uint8')
cv.rectangle(bm,(12,0),(bw-13,bh-1),255,-1);cv.rectangle(bm,(0,12),(bw-1,bh-13),255,-1)
for px in (12,bw-13):
 for py in (12,bh-13):cv.circle(bm,(px,py),12,255,-1)
pd=104;mid=pd//2;yy,xx=np.mgrid[:pd,:pd]
def jewel(item):
  # The physical identity is the enamel pattern, never board marks or pose.
  r=np.random.default_rng(3821+item*91)
  m=np.zeros((pd,pd),'uint8')
  if family=='recess_twins':
    cv.ellipse(m,(52,52),(35,28),4,0,360,255,-1,cv.LINE_AA)
    return np.full((pd,pd,3),[88,131,142],'uint8'),m
  cv.fillConvexPoly(m,np.array([(38,29),(59,26),(73,39),(75,59),(59,77),(39,73),(27,54)],'int32'),255,cv.LINE_AA)
  base=np.array([156,95,122])
  noise=cv.resize(r.normal(0,1,(21,21)).astype('float32'),(pd,pd),interpolation=cv.INTER_CUBIC)
  chrom=cv.resize(r.normal(0,1,(9,9)).astype('float32'),(pd,pd),interpolation=cv.INTER_CUBIC)
  surface=(base+noise[:,:,None]*np.array([21,18,22])+chrom[:,:,None]*np.array([9,-2,8])).clip(0,255).astype('uint8')
  # Cut irregular silvery veins rather than synthetic ID letters or markers.
  for _ in range(8):
    start=r.integers(16,88,2)
    pts=np.array([start,start+r.integers(-12,10,2),start+r.integers(-18,22,2)])
    cv.polylines(surface,[pts],False,tuple(map(int,r.choice([[182,203,193],[69,94,92],[164,154,106]]))),1,cv.LINE_AA)
  return surface,m
def aff_rgb(im,alpha,where,angle,scale,shape):
   H,W=shape;hh,ww=alpha.shape
   T=cv.getRotationMatrix2D((ww/2,hh/2),angle,scale);T[:,2]+=np.asarray(where)-[ww/2,hh/2]
   warp=lambda v:cv.warpAffine(v,T,(W,H),flags=cv.INTER_LINEAR)
   mat=warp(alpha.astype('float32')/255);pre=warp(im.astype('float32')*(alpha[:,:,None]/255))
   return pre,mat
def img(item,view):
   # Two independent motions: locations/rotations of treasure on tray, and of tray in camera.
   loc=[(83,73),(117,142),(196,83),(211,142),(86,127),(182,65)][2*view+item]
   ang=[-4,7,23,-28,-16,33][2*view+item]
   # Different unmarked manufactured duplicates seated in the same off-centre
   # display recess. They need not move dramatically to become a false merge.
   scale=[.97,1.02,.92,1.04,.99,.95][2*view+item]
   if family=='recess_twins':
     loc=[(166,79),(165,80),(167,78),(166,80),(165,79),(167,80)][2*view+item]
     ang=[2,-1,-2,1,-3,3][2*view+item];scale=1
   s,m=jewel(item)
   front,a=aff_rgb(s,m,loc,ang,scale,(bh,bw))
   shadow=cv.GaussianBlur(np.roll(np.roll(a,2,axis=0),2,axis=1),(7,7),1.8)
   display=board.astype('float32')*(1-.12*shadow[:,:,None])*(1-a[:,:,None])+front
   ba,ma=aff_rgb(display,bm,(w/2+(view-1)*6,h/2+item*4),[1,-3,7,-5,-6,4][2*view+item],.93 if view==2 else 1,(h,w))
   image=(np.array([229,227,223])*(1-ma[:,:,None])+ba)*[1,.95,1.04][view]
   out=io.BytesIO(); Image.fromarray(image.clip(0,255).astype('uint8')).save(out,"JPEG",quality=[91,87,94][view]);return out.getvalue()
for view in range(3):
 for item in range(2):
  b=img(item,view);sys.stdout.buffer.write(struct.pack('>I',len(b))+b)
