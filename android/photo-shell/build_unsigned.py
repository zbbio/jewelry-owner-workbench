#!/usr/bin/env python3
"""Build an unsigned local APK with the same N14 toolchain, without keys or ADB."""
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from hashlib import sha256
import argparse, json, os, re, subprocess

D=Path(__file__).resolve().parent
S=D/'src'
B=D/'build'
T=Path.home()/'AppData/Local/CodexToolchains/AndroidN14'
def hashfile(p):return sha256(p.read_bytes()).hexdigest()
def run(tt):
    j=tt/'jdk';sdk=tt/'sdk';bt=sdk/'build-tools/34.0.0'
    a=sdk/'platforms/android-34/android.jar'
    E=dict(os.environ,JAVA_HOME=str(j))
    for k in ('JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS'): E.pop(k,None)
    B.mkdir(exist_ok=True)
    classes=B/'classes';classes.mkdir(exist_ok=True)
    dex=B/'dex';dex.mkdir(exist_ok=True)
    steps=[]
    def step(name,args,ok=0):
        args=[str(x) for x in args]
        p=subprocess.run(args,env=E,cwd=D,capture_output=True,encoding='utf-8',errors='replace',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        steps.append(dict(name=name,argv=args,exitCode=p.returncode,stdout=p.stdout,stderr=p.stderr))
        if ok is not None and p.returncode!=ok:raise SystemExit(name+' exit='+str(p.returncode)+' '+p.stderr[-500:])
        return p
    try:
        src=sorted(S.rglob('*.java'))
        step('javac',[j/'bin/javac.exe','-encoding','UTF-8','--release','8','-classpath',a,'-d',classes,*src])
        packed=B/'java.jar'
        with ZipFile(packed,'w',ZIP_DEFLATED) as z:
            for f in sorted(classes.rglob('*.class')):z.write(f,f.relative_to(classes).as_posix())
        # Same local D8/aapt resource tools as N14; aapt sees ASCII relative paths.
        step('d8',[j/'bin/java.exe','-cp',bt/'lib/d8.jar','com.android.tools.r8.D8','--release','--min-api','26','--lib',a,'--output',dex,packed])
        resources=B/'resources.zip';resapk=B/'resources.apk';raw=B/'unaligned.apk';apk=B/'jewelry-owner-n22-unsigned.apk'
        step('aapt2_compile',[bt/'aapt2.exe','compile','--dir','src/res','-o',resources.relative_to(D)])
        step('aapt2_link',[bt/'aapt2.exe','link','-o',resapk.relative_to(D),'-I',a,'--manifest','src/AndroidManifest.xml',resources.relative_to(D)])
        with ZipFile(resapk) as z,ZipFile(raw,'w',ZIP_DEFLATED) as out:
            for name in z.namelist():out.writestr(name,z.read(name))
            out.write(dex/'classes.dex','classes.dex')
        step('zipalign',[bt/'zipalign.exe','-f','4',raw.relative_to(D),apk.relative_to(D)])
        step('zipalign_check',[bt/'zipalign.exe','-c','4',apk.relative_to(D)])
        p=step('badging',[bt/'aapt2.exe','dump','badging',apk.relative_to(D)])
        assert "package: name='com.zbbio.jewelryassistant.n14' versionCode='2' versionName='1.1.0-n22-dev'" in p.stdout
        assert "launchable-activity: name='com.zbbio.jewelryassistant.n14.MainActivity'" in p.stdout
        assert re.findall(r"^uses-permission: name='([^']+)'",p.stdout,re.M)==['android.permission.INTERNET']
        assert "sdkVersion:'26'" in p.stdout and "targetSdkVersion:'34'" in p.stdout
        with ZipFile(apk) as z:
            assert z.testzip() is None
            classes=z.read('classes.dex')
            assert b'android.intent.action.OPEN_DOCUMENT' in classes and b'http://127.0.0.1:17864/' in classes
            assert b'addJavascriptInterface' not in classes and b'takePersistableUriPermission' not in classes
        p=step('expected_unsigned',[ j/'bin/java.exe','-jar',bt/'lib/apksigner.jar','verify',apk],ok=None)
        assert p.returncode!=0
        meta=dict(apk=str(apk),sha256=hashfile(apk),versionCode=2,versionName='1.1.0-n22-dev',
                  package='com.zbbio.jewelryassistant.n14',signed=False,installed=False,compiled=True)
        print(json.dumps(meta,ensure_ascii=True))
        return meta
    finally:
        (B/'android-steps.json').write_text(json.dumps(steps,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--toolchain-root',type=Path,default=T)
    m=run(p.parse_args().toolchain_root)
    (B/'android-build.json').write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
