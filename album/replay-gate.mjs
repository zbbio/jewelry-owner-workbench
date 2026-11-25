// Offline only. Both inputs must be explicitly supplied by the operator. Never
// follow paths embedded in a report, consult owner groups, or start the App.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdtempSync,readFileSync,rmdirSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {visionCore} from './vision.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const requireEvidence=(ok,msg)=>{if(!ok)throw new Error('gate evidence mismatch: '+msg)};
const archiveProbe=String.raw`
import hashlib, zipfile
wanted=json.load(sys.stdin)
seen={}
with zipfile.ZipFile(sys.argv[1]) as z:
    for entry in z.infolist():
        if entry.is_dir(): continue
        if entry.file_size>8*1024*1024: raise ValueError("unexpected gate input size")
        raw=z.read(entry)
        h=hashlib.sha256(raw).hexdigest()
        if h not in wanted: raise ValueError("unexpected archive member")
        if h in seen: continue
        t={}
        result=inspect(raw,t)
        seen[h]={"trace":t,"f":result["f"],"bytes":len(raw)}
print(json.dumps(seen))
`;

// Take a temporary copy of the closed gate's main file and its WAL. A plain
// copy of only the 4 KiB main file would miss committed rows. SQLite may build
// a transient SHM for the copy, never for the original.
function withSnapshot(file,read){
  const paths=[file,file+'-wal',file+'-shm'];
  const sums=()=>paths.map(p=>existsSync(p)?sha(readFileSync(p)):null);
  const before=sums(), dir=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'.gate-read-')), dest=join(dir,'db.sqlite');
  let db;
  try{
    copyFileSync(file,dest);
    if(before[1])copyFileSync(file+'-wal',dest+'-wal');
    db=new DatabaseSync(dest,{readOnly:true});
    db.exec('PRAGMA query_only=ON');
    return read(db);
  }finally{
    db?.close();
    for(const p of [dest+'-shm',dest+'-wal',dest])if(existsSync(p))unlinkSync(p);
    rmdirSync(dir);
    requireEvidence(JSON.stringify(before)===JSON.stringify(sums()),'archived database changed');
  }
}

export function replayGate(resultFile,archiveFile){
  const raw=readFileSync(resultFile), result=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
  const zipHash=sha(readFileSync(archiveFile));
  requireEvidence(zipHash===result.zip_sha256_before,'archive is not the recorded input');
  const original=result.original_files;
  const wanted=[...new Set(Object.values(original).map(x=>x.sha256))];
  const probes=JSON.parse(execFileSync(process.env.ALBUM_PYTHON||'python',
    ['-B','-c',visionCore+archiveProbe,resolve(archiveFile)],{input:JSON.stringify(wanted),
      encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:12*1024*1024}));
  const shop=result.probe_processes[0].shop;
  requireEvidence(typeof shop==='string'&&shop.length,'missing gate shop');
  const evidence=withSnapshot(join(dirname(resultFile),'database','workbench.sqlite'),db=>{
    const query=db.prepare('SELECT h,f FROM alb_asset WHERE s=? AND id=?');
    const rows=new Map(), asset=id=>{
      if(!rows.has(id)){const r=query.get(shop,id);requireEvidence(r,'missing retained asset');
        rows.set(id,{hash:r.h,features:JSON.parse(r.f)})}
      return rows.get(id);
    };
    const images=[],stages={};
    for(const [name,st] of Object.entries(result.stages)){
      const r=st.initial_response, nums=st.input_file_numbers, fresh=[];
      requireEvidence(nums.length===r.items.length&&st.taskId===r.taskId,'initial response');
      for(const [i,item] of r.items.entries()){
        const input=nums[i],meta=original[input],p=probes[meta.sha256];
        requireEvidence(p&&p.bytes===meta.bytes,'input bytes');
        if(item.status==='duplicate'){
          requireEvidence(!item.assetId&&asset(item.duplicateOf).hash===meta.sha256,'duplicate');
          images.push({input,status:'duplicate',extraction:'not_invoked'});continue;
        }
        requireEvidence(item.status==='kept','unexpected historical disposition');
        const a=asset(item.assetId);
        requireEvidence(a.hash===meta.sha256&&JSON.stringify(a.features)===JSON.stringify(p.f),'recomputed vs stored descriptor');
        fresh.push(item.assetId);
        images.push({input,status:'kept',...p.trace,storedFeatureIsNull:a.features===null,storedFeatureRows:a.features?.[1]?.length??0});
      }
      // On this archive, recognition stages had no automatic commits; the
      // before-owner snapshot therefore still describes the prior search pool.
      const target=st.targetProductId!=null;
      const base={targetSupplied:target,inputs:nums.length,fresh:fresh.length,
        method:r.analysis.method,initialReceipts:r.receipts.length,pending:r.pendingAssetIds.length,
        hasReviewTask:!!r.pendingTask?.taskId,decisionSources:r.handoffs.map(h=>h.input.decisionSource)};
      if(target){stages[name]={...base,matching:'not_invoked_target_route'};continue}
      requireEvidence(r.receipts.length===0,'prior reference pool not established for a committed stage');
      const cards=Object.values(st.cards_before_owner_action);
      const refs=[...new Set(cards.flatMap(c=>c.assetIds))];
      const hasF=id=>asset(id).features!==null;
      const n=fresh.length,k=fresh.filter(hasF).length,m=refs.filter(hasF).length;
      const eligible=k*(k-1)/2+k*m, logged=r.analysis.pairs;
      requireEvidence(Array.isArray(logged)&&eligible===logged.length,'pair count');
      stages[name]={...base,referenceCards:cards.length,referenceAssets:refs.length,
        possiblePairs:n*(n-1)/2+n*refs.length,featuresFresh:k,featuresReference:m,
        eligiblePairs:eligible,observedPairs:logged.length,strongEdges:logged.filter(x=>x.level===2).length};
    }
    return {images:images.sort((a,b)=>a.input-b.input),stages};
  });
  return {scope:'previous gate; no owner labels used; no new recognition run',gate:resultFile,
    resultSha256:sha(raw),archiveDigestVerified:true,sourceDbAndSidecarsUnchanged:true,...evidence};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [r,z]=process.argv.slice(2);
  if(!r||!z)throw new Error('usage: node album/replay-gate.mjs <old-result.json> <old-input.zip>');
  console.log(JSON.stringify(replayGate(resolve(r),resolve(z)),null,2));
}
