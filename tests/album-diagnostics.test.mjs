import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {foregroundProbe} from '../album/foreground-probe.mjs';

// Purely procedural images. The input renderer transforms the foreground
// independently of its background. It does not open image files or accept paths.
const fixture=String.raw`
H,W=320,420
def background(kind,seed):
    yy,xx=np.indices((H,W))
    phase=seed%23
    if kind=="plain": grey=np.full((H,W),238)
    elif kind=="blocks": grey=np.where(((xx+phase)//23+(yy-phase)//19)%2,65,205)
    elif kind=="bands": grey=112+65*np.sin((xx+yy+phase)/9)
    elif kind=="grain":
        rng=np.random.default_rng(seed)
        grey=cv.resize(rng.integers(35,220,(30,37),dtype=np.uint8),(W,H),interpolation=cv.INTER_CUBIC)
    else: raise ValueError(kind)
    return Image.fromarray(np.repeat(grey.astype(np.uint8)[:,:,None],3,axis=2))
def panel(seed,hue):
    rng=np.random.default_rng(seed)
    tile=rng.integers(0,125,(44,60),dtype=np.uint8)
    t=cv.resize(tile,(250,178),interpolation=cv.INTER_CUBIC).astype(np.int32)
    channels=[95+t,20+t//2,110+t]
    return Image.fromarray(np.stack(channels[hue:]+channels[:hue],axis=2).clip(0,255).astype(np.uint8))
def shot(p,bg,angle,offset=0):
    canvas=bg.copy()
    obj=p.convert("RGBA").rotate(angle,Image.Resampling.BICUBIC,expand=True)
    canvas.paste(obj,((W-obj.width)//2+offset,(H-obj.height)//2),obj)
    return np.asarray(canvas.convert("RGBA"))
def encode(a):
    b=io.BytesIO();Image.fromarray(a).save(b,"PNG");return b.getvalue()
def observed(a):
    tr={};r=inspect(encode(a),tr)
    assert r==inspect(encode(a)) # observing a return must not modify f or mime
    f,st=shadow_features(a)
    return r["f"],f,tr,st
def pair(name,same,a,b):
    fa,sa,ta,ma=observed(a);fb,sb,tb,mb=observed(b)
    level,forward,reverse=shadow_compare(sa,sb)
    return {"name":name,"same":same,"baseline":compare(fa,fb),"probe":[level,*forward[1:]],"reverse":reverse,
            "baseGates":[ta["firstReject"],tb["firstReject"]],
            "usableRows":[len(f[1]) if f is not None else 0 for f in (sa,sb)],
            "maskAgreement":[m.get("consensus",{}).get("maskIoUs") for m in (ma,mb)]}
cases=[]
for i,(b1,b2) in enumerate([("blocks","bands"),("bands","grain"),("grain","blocks")]):
    a,b=panel(4100+i,i),panel(8700+i,i)
    bg=background(b1,200+i); other=background(b2,800+i)
    ref=shot(a,bg,0,-8)
    cases.append(pair("different_scene_same_panel_"+str(i),True,ref,shot(a,other,13,11)))
    cases.append(pair("same_scene_other_panel_"+str(i),False,ref,shot(b,bg,0,-8)))

# Hard negative: the removable insert is the subject; its patterned carrier is
# intentionally identical. Mask agreement alone does not separate the two.
tray=panel(12001,0)
def mounted(insert):
    p=tray.copy(); patch=insert.resize((106,82),Image.Resampling.BICUBIC)
    p.paste(patch,((p.width-patch.width)//2,(p.height-patch.height)//2));return p
cases.append(pair("shared_carrier_distinct_inserts",False,
    shot(mounted(panel(3401,1)),background("bands",91),0),
    shot(mounted(panel(3402,2)),background("blocks",292),9)))
flat=Image.new("RGB",(248,178),(149,76,162))
cases.append(pair("indistinguishable_uniform_surfaces",False,
    shot(flat,background("blocks",51),0),shot(flat,background("bands",62),12)))

small=panel(310,1).resize((110,100))
dual=background("blocks",64);dual.paste(small,(42,95));dual.paste(small,(259,106))
dualF,dualTrace=shadow_features(np.asarray(dual.convert("RGBA")))
clean=shot(panel(912,2),background("plain",0),0)
busy=shot(panel(912,2),background("blocks",3),0)
raw,experiment,posTrace,_=observed(clean)
_,_,negTrace,_=observed(busy)
flatTrace={};features(shot(flat,background("plain",0),0),flatTrace)
print(json.dumps({"cases":cases,"diagnostics":{"plain":posTrace,"complex":negTrace,
    "plainOutputIdentical":raw==experiment,"flat":flatTrace,
    "multiObjectRows":len(dualF[1]) if dualF else 0,
    "multiObjectGate":dualTrace.get("consensus",{}).get("reject")}}))
`;

let cached;
function measure(){
  return cached??=JSON.parse(execFileSync(process.env.ALBUM_PYTHON||'python',
    ['-B','-c',foregroundProbe+fixture],{encoding:'utf8',timeout:120000,windowsHide:true}));
}
test('decode, foreground exit, SIFT rejection and usable descriptors are distinguishable',()=>{
  const {plain,complex,flat,plainOutputIdentical}=measure().diagnostics;
  assert.equal(plain.decoded,true);assert.equal(plain.firstReject,null);
  assert.ok(plain.siftDetected>=plain.validKeypoints&&plain.validKeypoints===plain.descriptorRows&&plain.descriptorRows>=12);
  assert.equal(plainOutputIdentical,true);
  assert.equal(complex.decoded,true);assert.equal(complex.firstReject,'border_p95_gt_22');
  assert.ok(complex.foreground.borderP95>complex.foreground.maxP95);
  assert.equal(complex.siftDetected,null);assert.equal(complex.validKeypoints,null);assert.equal(complex.descriptorRows,0);
  assert.ok(flat.siftDetected!==null);assert.equal(flat.descriptorRows,0);
  assert.ok(['no_sift_descriptors','fewer_than_12_safe_keypoints'].includes(flat.firstReject));
});
test('fallback uses corroborating masks and the existing pair gate; no result from shape alone',()=>{
  const {cases,diagnostics}=measure();
  assert.ok(cases.filter(x=>x.same).some(x=>x.probe[0]===2));
  for(const x of cases.filter(x=>x.probe[0]===2)){
    assert.ok(x.maskAgreement.every(v=>v&&v.every(iou=>iou>=.80)));
    assert.ok(x.usableRows.every(n=>n>=12));assert.ok(x.probe[2]>=12&&x.probe[2]>=.75*x.probe[1]);
    assert.ok(x.reverse[0]===2&&x.reverse[2]>=12&&x.reverse[2]>=.75*x.reverse[1]);
  }
  assert.ok(cases.filter(x=>x.name.startsWith('same_scene_other_')).every(x=>x.probe[0]!==2));
  assert.notEqual(cases.find(x=>x.name==='indistinguishable_uniform_surfaces').probe[0],2);
  assert.equal(diagnostics.multiObjectRows,0);
});
test('independent comparison and strict promotion check',t=>{
  const {cases}=measure();
  const summary=Object.fromEntries(['baseline','probe'].map(k=>[k,{
    positiveStrong:cases.filter(x=>x.same&&x[k][0]===2).length,totalPositive:cases.filter(x=>x.same).length,
    negativeStrong:cases.filter(x=>!x.same&&x[k][0]===2).length,totalNegative:cases.filter(x=>!x.same).length
  }]));
  const unsafe=cases.filter(x=>!x.same&&x.probe[0]===2);
  const report={summary,falsePositives:unsafe.map(x=>({case:x.name,forward:x.probe.slice(1),reverse:x.reverse.slice(1)})),
    eligible:summary.probe.positiveStrong>summary.baseline.positiveStrong&&!unsafe.length};
  t.diagnostic(JSON.stringify(report));
  assert.equal(summary.baseline.negativeStrong,0);
  if(process.env.ALBUM_REQUIRE_PROMOTION==='1')assert.ok(report.eligible,'shadow candidate failed qualification; do not enable');
});
