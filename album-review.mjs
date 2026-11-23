// View-only annotation from the saved analysis. Never reclassifies an image, queries a live card, or mutates a receipt.
export function reviewView(task){
 if(!task||!Array.isArray(task.pendingAssetIds)||!task.pendingAssetIds.length||!task.analysis||task.analysis.method==='target_card')return task;
 const a=task.analysis,waiting=new Set(task.pendingAssetIds);
 if(typeof a.note!=='string'&&!Array.isArray(a.pairs))return task;
 const n=(a.pairs||[]).filter(p=>waiting.has(p.left)||waiting.has(p.right)).length;
 const reason=a.note?'analysis_incomplete':n===0?'no_comparable_pairs':'identity_unresolved';
 const message=a.note?'本次自动比较未完成。这些原图已保留，仍待核对。':n===0?'本次没有形成可用于核对这些照片的图对，并不是已经比较后确认了不同件。原图已保留，可先待认，也可补拍能看清相邻珠纹的角度。':'比过照片后，仍没有足够证据把待认照片交给某一张卡。可对照原卡核实，或暂时保留待认。';
 return {...task,analysis:{...a,reviewHint:{reason,comparedPairs:n,message}}};
}
