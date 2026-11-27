"""Build a complete immutable album version; only the active manifest switches."""
from datetime import datetime, timezone
import hashlib, json, os, shutil, subprocess, sys, tempfile, uuid
from pathlib import Path

def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def read_rows(parsed,batch):
    expected={path.name for path in batch}
    rows=parsed.get('items') if isinstance(parsed,dict) else None
    if not isinstance(rows,list) or len(rows)!=len(expected):
        raise ValueError('ALBUM_INCOMPLETE_PROVIDER_BATCH')
    found={}
    for x in rows:
        if not isinstance(x,dict):
            raise ValueError('ALBUM_INVALID_PROVIDER_ROW')
        n,c,t=x.get('file'),x.get('category'),x.get('type','')
        if not isinstance(n,str) or n not in expected or n in found:
            raise ValueError('ALBUM_PROVIDER_ROW_SCOPE')
        if not isinstance(c,str) or not c.strip() or len(c)>128 or not isinstance(t,str) or len(t)>128:
            raise ValueError('ALBUM_INVALID_PROVIDER_ROW')
        found[n]={'category':c.strip(),'type':t.strip()}
    return found

def publish(source,output,key,call_vision,categories):
    source=source.resolve(strict=True)
    output=output.resolve()
    if source==output or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('ALBUM_SOURCE_OUTPUT_OVERLAP')
    files=sorted((p for p in source.iterdir() if p.suffix.lower() in {'.jpg','.jpeg','.png','.webp'} and p.is_file()), key=lambda p:p.name)
    if not files or any(p.is_symlink() for p in files):
        raise ValueError('ALBUM_SOURCE_EMPTY_OR_LINK')
    output.mkdir(parents=True,exist_ok=True)
    result_root=output/'分类结果'
    versions=result_root/'版本'
    versions.mkdir(parents=True,exist_ok=True)
    if versions.resolve()!=versions:
        raise ValueError('ALBUM_OUTPUT_LINK')
    lock=output/'.album-publish.lock'
    lock.mkdir()   # Busy or stale lock fails closed; never clear a lock created by another writer.
    stage=None
    final=None
    temporary=None
    published=False
    try:
        batch_id=uuid.uuid4().hex
        stage=Path(tempfile.mkdtemp(prefix='.stage-',dir=versions))
        inputs=stage/'.inputs'
        inputs.mkdir()
        thumb=stage/'.thumb'
        hashes={}
        for original in files:
            p=inputs/original.name
            shutil.copyfile(original,p)
            hashes[p.name]=digest(p)
        expected={p.name for p in files}
        copies=sorted(inputs.iterdir(),key=lambda p:p.name)
        observations={}
        calls=0
        provider_receipts=[]
        for start in range(0,len(copies),10):
            batch=copies[start:start+10]
            parsed,receipt=call_vision(key,batch,thumb,start//10+1)
            provider_receipts.append(receipt)
            for name,row in read_rows(parsed,batch).items():
                observations[name]={'file':name,'sha256':hashes[name],**row}
            calls+=1
        if set(observations)!=expected:
            raise ValueError('ALBUM_INCOMPLETE_PROVIDER_BATCH')
        node=os.getenv('MVP_NODE','node')
        mapper=Path(__file__).with_name('album-map.mjs')
        reply=subprocess.run([node,str(mapper)],input=json.dumps({'batchId':batch_id,'rows':list(observations.values())},
            ensure_ascii=False).encode('utf8'),capture_output=True,timeout=60)
        if reply.returncode:
            raise RuntimeError('ALBUM_TAXONOMY_MAP_FAILED')
        result=json.loads(reply.stdout)
        own={r['file']:r for r in result['items']}
        if len(result['items'])!=len(own) or set(own)!=expected:
            raise ValueError('ALBUM_MAPPING_SCOPE')
        final=versions/batch_id
        counts={c:0 for c in categories}
        for c in categories:
            (stage/c).mkdir()
        items=[]
        for image in files:
            name=image.name
            b=inputs/name
            if digest(image)!=hashes[name] or digest(b)!=hashes[name]:
                raise RuntimeError('ALBUM_INPUT_CHANGED')
            selected=own[name]
            group=selected['group']
            if group not in counts:
                raise ValueError('ALBUM_UNSUPPORTED_LEGACY_GROUP')
            size=b.stat().st_size
            b.replace(stage/group/name)
            counts[group]+=1
            items.append({'file':name,'source':str(image),'group':group,
              'classified_copy':str(final/group/name),'sha256':hashes[name],'bytes':size,
              'classification':selected['classification']})
        inputs.rmdir()
        if thumb.exists():shutil.rmtree(thumb)
        active=output/'分类结果.json'
        data={'title':'MVP 蜜蜡 103-238 视觉分类','createdAt':datetime.now(timezone.utc).isoformat(),
          'sourceRoot':str(source),'fileCount':len(items),'groups':counts,'classificationMode':'deepseek_vision',
          'model':'deepseek-flash','batchSize':10,'providerCalls':calls,'providerReceipts':provider_receipts,'errors':[],'originalsModified':False,
          'batchId':batch_id,'taxonomyVersion':result['taxonomyVersion'],'evidence':result['evidence'],'items':items}
        temporary=output/('.album-manifest-'+batch_id+'.tmp')
        with temporary.open('x',encoding='utf8') as f:
            json.dump(data,f,ensure_ascii=False,indent=2)
            f.flush()
            os.fsync(f.fileno())
        stage.rename(final)
        os.replace(temporary,active)
        published=True
        return {'total':len(items),'groups':counts,'resultRoot':str(result_root),'manifestPath':str(active),
          'batchId':batch_id,'taxonomyVersion':result['taxonomyVersion'],
          'needsReview':sum(r['classification']['status']=='needs_review' for r in items),
          'model':'deepseek-flash','providerCalls':calls,'failedBatches':0,'publishStatus':'published'}
    finally:
        if temporary and temporary.exists():temporary.unlink()
        if stage and stage.exists():shutil.rmtree(stage)
        if not published and final and final.exists():shutil.rmtree(final)
        lock.rmdir()