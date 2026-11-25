"""Build a K2 UI-only delta from the *verified* K1 baseline. Never promote a release.

prepare creates an empty disposable K1 working copy; apply/rollback verify the
entire 99-member input tree before writing. No service, business DB or credentials.
"""
from argparse import ArgumentParser
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory, NamedTemporaryFile, gettempdir
from zipfile import ZipFile
import difflib
import hashlib
import json
import os
import runpy
import stat
import sys

ROOT = Path(__file__).resolve().parents[1]
P1 = 'aa6cd0906cbc4a2660e4dd70be77589558c4e2d36247df9b0e18316b26199b14'
K1 = '5a61e10bcc81243c863c0838db920f90f46c108ce861923c350290e656f65974'
K1ID = 'n22-0c587b2d30ff040d4d8a1bc5'
REV = 'e8479330f7284dd0031649636e18e197d6633ece'
HTML,CSS,JS,NOTICE,MAN = KEYS = ('n22-ui/index.html','n22-ui/n22-app.css','n22-ui/n22-app.js','NOTICE.md','release.json')

def require(ok,why):
    if not ok: raise ValueError(why)

def sha(data): return hashlib.sha256(data).hexdigest()
def dump(data): return (json.dumps(data,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
def rid(files): return json.loads(files[MAN])['releaseId']

def default(rel):
    return next((p/rel for p in ROOT.parents if (p/rel).is_file()),Path(rel))

def single(source,before,after):
    require(source.count(before)==1,'unexpected K1 anchor')
    return source.replace(before,after)

def check_zip(path,digest):
    with path.open('rb') as f:
        require(hashlib.file_digest(f,'sha256').hexdigest()==digest,f'unexpected pinned input: {path.name}')

def members(z):
    names=[i.filename for i in z.infolist() if not i.is_dir()]
    require(len(names)==len(set(names)) and all(
        not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts and ':' not in n and '\\' not in n for n in names
    ),'bad archive member paths')
    return names

def baseline(base,k1):
    check_zip(base,P1)
    check_zip(k1,K1)
    # K1's already-reviewed packer is the authority for K1 bytes. Run its pure
    # images() helper from the exact pinned archive rather than a live worktree.
    with TemporaryDirectory(prefix='n99-k2-input-') as td, ZipFile(k1) as z:
        tmp=Path(td)
        for n in members(z):
            if n in ('tools/integrate.py','build/k1nav.mjs','web/panel.html','web/panel.css','web/bridge.js') or n.startswith('licenses/'):
                dest=tmp/n;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(z.read(n))
        k1_images=runpy.run_path(str(tmp/'tools/integrate.py'))['images']
        _,changed=k1_images(base)
    require(rid(changed)==K1ID,'replayed K1 release ID differs')
    with ZipFile(base) as z:
        files={n:changed[n] if n in changed else z.read(n) for n in members(z)}
    verify_images(files)
    return files

def verify_images(files):
    manifest=json.loads(files[MAN]);expected=manifest.pop('releaseId')
    require(expected=='n22-'+sha(dump(manifest))[:24],'release identity mismatch')
    require(manifest['files']=={n:sha(b) for n,b in files.items() if n!=MAN},'member hash mismatch')

def images(base,k1):
    old=baseline(base,k1);new=dict(old)
    web=ROOT/'web';panel=(web/'panel.html').read_bytes();css=(web/'panel.css').read_bytes();js=(web/'bridge.js').read_bytes()
    require(b'<script' not in panel.lower(),'no inline scripts in markup')
    button='<button type="button" id="k2-open" aria-expanded="false" aria-controls="k2-panel">近期任务与待确认</button>'.encode()
    trigger='<button type="button" id="k1-launch">本店话题</button>'.encode()
    new[HTML]=single(single(old[HTML],trigger,trigger+button),b'</body>',panel+b'\n</body>')
    new[CSS]=old[CSS]+b'\n'+css+b'\n'
    # A lexical hook gives K2 the existing K1 read/jump path without a global
    # javascript/native interface, same-page protocol endpoint or new service.
    group=(ROOT/'upstream/group-tasks.js').read_bytes()
    require(bool(group.strip()),'missing upstream groupTasks implementation')
    js=single(js,b'/*K2_GROUP_TASKS*/',group)
    readers=b'/*K2_BIND_READERS*/Object.freeze({})'
    require(js.count(readers)==1,'reader port marker must be unique')
    bindings=web/'ports.js'
    if bindings.is_file():
        src=bindings.read_bytes().strip()
        require(bool(src),'ports.js must contain a JavaScript expression')
        js=single(js,readers,b'(\n'+src+b'\n)')
    tail=b"clearAll('');\n\n})();\n"
    denied=b'if(res.status===401 || res.status===403) {\n    clearAll('
    with_revocation=single(old[JS],denied,b'if(res.status===401 || res.status===403) {\n    k2DropSensitive();\n    clearAll(')
    require(js.count(b'let k2DropSensitive=')==1,'missing one lexical K2 revocation hook')
    new[JS]=single(with_revocation,tail,b"clearAll('');\n"+js+b"\n\n})();\n")
    new[NOTICE]=old[NOTICE]+(f'\n\n# K2 / Mika\nUpstream: wangzan101/Mika @ {REV} (Apache-2.0). '
        'K2 reuses the original K1 message-navigation component at runtime. '
        'Original browser task grouping function companions/mika/scripts/mika_desk/desk.js::groupTasks '
        'is included in this bundle; Copyright 2026 wangzan101, Apache License 2.0. '
        'K1 upstream notices and Kotlin notices above are retained in full. '
        'K2 owner-side task/pending presentation is adapted for this host.\n').encode()
    m=json.loads(old[MAN]);m.pop('releaseId')
    for n in KEYS[:-1]: m['files'][n]=sha(new[n])
    m['releaseId']='n22-'+sha(dump(m))[:24];new[MAN]=dump(m)
    verify_images(new)
    require({n for n,b in new.items() if b!=old[n]}==set(KEYS),'unexpected delta')
    return old,new

def permitted(path):
    h=path.absolute();target=h.resolve()
    require(h==target,'symlink/junction or non-canonical host refused')
    tmp=Path(gettempdir()).resolve();scratch=(ROOT/'scratch').resolve()
    require((h.is_relative_to(tmp) and h!=tmp and any('k2' in s.lower() for s in h.relative_to(tmp).parts))
            or (h.is_relative_to(scratch) and h!=scratch),'use a fresh n99-k2-* temp copy or module/scratch/<new>')
    return h

def checked_tree(host,expected):
    require(host.is_dir(),'expected extracted host directory')
    seen=set()
    for p in host.rglob('*'):
        s=p.lstat()
        require(not p.is_symlink() and not getattr(s,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0),'refusing linked path')
        if p.is_dir(): continue
        require(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'refusing nonregular/hardlinked member')
        rel=p.relative_to(host).as_posix();seen.add(rel)
        require(rel in expected and p.read_bytes()==expected[rel],f'host drift: {rel}; no patch applied')
    require(seen==set(expected),'missing/extra member; refuse patch')

def swap(dest,data):
    with NamedTemporaryFile(dir=dest.parent,delete=False) as f:
        tmp=Path(f.name);f.write(data)
    try: os.replace(tmp,dest)
    finally: tmp.unlink(missing_ok=True)

def prepare(host,files):
    dest=permitted(host);require(not dest.exists(),'prepare requires a new path')
    dest.mkdir(parents=True)
    for n,b in files.items():
        p=dest/n;p.parent.mkdir(parents=True,exist_ok=True)
        with p.open('xb') as f: f.write(b)
    checked_tree(dest,files)

def change(host,before,after):
    h=permitted(host);checked_tree(h,before);done=[]
    try:
        for n in KEYS:
            # Re-check each target before replacing it. The worktree is private.
            require((h/n).read_bytes()==before[n],f'concurrent drift: {n}')
            swap(h/n,after[n]);done.append(n)
        checked_tree(h,after)
    except BaseException:
        for n in reversed(done):
            if (h/n).read_bytes()==after[n]:swap(h/n,before[n])
        raise

def patch(old,new):
    lines=[]
    for n in KEYS:
        for line in difflib.diff_bytes(difflib.unified_diff,old[n].splitlines(True),new[n].splitlines(True),
                                        ('a/'+n).encode(),('b/'+n).encode()):
            lines.append(line if line.endswith(b'\n') else line+b'\n\\ No newline at end of file\n')
    return b''.join(lines)

def main():
    p=ArgumentParser(description=__doc__)
    p.add_argument('action',choices=('prepare','apply','rollback','diff','check'))
    p.add_argument('--base',type=Path,default=default('商品仓/P1/N99-P1-集成候选.zip'))
    p.add_argument('--k1',type=Path,default=default('Mika复用/K1/K1-商品仓接件.zip'))
    p.add_argument('--host',type=Path);p.add_argument('--output',type=Path)
    a=p.parse_args();out={'action':a.action}
    if a.action=='prepare':
        require(a.host,'--host required');old=baseline(a.base,a.k1);prepare(a.host,old)
        out.update(after=rid(old),verifiedMembers=len(old))
    else:
        old,new=images(a.base,a.k1)
        if a.action=='rollback':old,new=new,old
        if a.action in ('apply','rollback'):
            require(a.host,'--host required');change(a.host,old,new)
        elif a.action=='diff':
            require(a.output,'--output required')
            data=patch(old,new)
            if a.output.exists():
                require(a.output.read_bytes()==data,'existing diff differs; choose a fresh output')
            else:
                with a.output.open('xb') as f:f.write(data)
            out['patchSha256']=sha(data)
        elif a.host: checked_tree(permitted(a.host),new)
        out.update(before=rid(old),after=rid(new),verifiedMembers=len(new),changed={n:sha(new[n]) for n in KEYS})
    print(json.dumps(out,ensure_ascii=False))

if __name__=='__main__':
    try: main()
    except (ValueError,OSError) as ex:
        print('K2 precondition failed:',ex,file=sys.stderr);sys.exit(2)
