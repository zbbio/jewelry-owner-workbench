"""K2 packaging/evidence only; run the UI's owner-behavior test separately.

Produce a local audit of Python apply/rollback, git apply/reverse, rejection of
uncommitted drift, exact 99-member comparisons, and syntax of delivered JS.
Never starts the App or a backend. Writes a new --evidence JSON (won't clobber).
"""
from argparse import ArgumentParser
from pathlib import Path
from tempfile import TemporaryDirectory
import json, os, subprocess, sys, runpy
from integrate import baseline, checked_tree, default, images, rid, sha

def main():
    p=ArgumentParser(description=__doc__)
    p.add_argument('--base',type=Path,default=default('商品仓/P1/N99-P1-集成候选.zip'))
    p.add_argument('--k1',type=Path,default=default('Mika复用/K1/K1-商品仓接件.zip'))
    p.add_argument('--evidence',required=True,type=Path)
    a=p.parse_args()
    if a.evidence.exists(): raise ValueError('choose a fresh evidence path')
    old,new=images(a.base,a.k1)
    rec={'scope':'packaging; no App, device or model runtime','inputs':{
        str(f):sha(f.read_bytes()) for f in (a.base,a.k1)},'base':rid(old),'candidate':rid(new),'commands':[]}
    command=[sys.executable,'-B',Path(__file__).with_name('integrate.py')]
    with TemporaryDirectory(prefix='n99-k2-delta-') as work:
        root=Path(work);host=root/'copy';patch=root/'k2.patch'
        def run(argv,cwd=None,code=0):
            argv=list(map(str,argv))
            r=subprocess.run(argv,cwd=cwd,env={**os.environ,'PYTHONIOENCODING':'utf8','GIT_NO_LAZY_FETCH':'1'},
                capture_output=True,timeout=120)
            stdout=r.stdout.decode('utf8','replace');stderr=r.stderr.decode('utf8','replace')
            rec['commands'].append(dict(argv=argv,cwd=str(cwd or Path.cwd()),stdout=stdout,stderr=stderr,exit=r.returncode,expected=code))
            if r.returncode!=code:raise RuntimeError(f'{argv[0]} unexpected exit {r.returncode}: {stderr}')
        def pack(action,*args,code=0):run([*command,action,'--base',a.base,'--k1',a.k1,*args],code=code)
        def cert(key,expected):
            checked_tree(host,expected)
            # Use the same verified release.py and entry criteria as the real
            # manager, but only its pure checker (no install/start/provision).
            gate=runpy.run_path(str(host/'release.py'))['release_check']
            candidate=json.loads((host/'release.json').read_bytes())
            observed={n:sha((host/n).read_bytes()) for n in expected if n!='release.json'}
            accepted=gate(candidate,observed)
            if accepted!=rid(expected):raise AssertionError('release manager did not accept expected identity')
            rec[key]={'members':len(expected),'exactBytes':True,'managerReleaseCheck':accepted}
        def appl(*args):run(['git','-c','core.autocrlf=false','apply',*args,patch],host)
        pack('prepare','--host',host);cert('original',old)
        pack('diff','--output',patch);rec['patchSha256']=sha(patch.read_bytes())
        # A non-UI member with uncommitted text must stop all writes, with
        # original and local bytes still present after failure.
        uncommitted=host/'local-draft.txt';uncommitted.write_text('K2 local drift guard','ascii')
        pack('apply','--host',host,code=2)
        if uncommitted.read_text('ascii')!='K2 local drift guard':raise AssertionError('lost local drift')
        uncommitted.unlink();cert('guardPreservedOriginal',old)
        pack('apply','--host',host);cert('applied',new)
        run(['node','--check',host/'n22-ui/n22-app.js']);pack('check','--host',host)
        # Do not blindly undo a post-patch user change.
        h=host/'n22-ui/index.html';saved=h.read_bytes();h.write_bytes(saved+b'\n<!-- K2 changed after integration -->')
        pack('rollback','--host',host,code=2)
        if not h.read_bytes().endswith(b'after integration -->'):raise AssertionError('lost edited UI')
        h.write_bytes(saved);cert('guardPreservedCandidate',new)
        pack('rollback','--host',host);cert('rolledBack',old)
        appl('--check');appl('--whitespace=nowarn');cert('gitApplied',new)
        appl('-R','--check');appl('-R','--whitespace=nowarn');cert('gitReversed',old)
    rec['result']='PASS';a.evidence.parent.mkdir(parents=True,exist_ok=True)
    with a.evidence.open('x',encoding='utf8') as f:json.dump(rec,f,indent=2,ensure_ascii=False);f.write('\n')
    print(json.dumps({'result':'PASS','evidence':str(a.evidence),'candidate':rid(new),'patch':rec['patchSha256'],'commands':len(rec['commands'])}))

if __name__=='__main__': main()
