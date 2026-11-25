"""N15 Android HTTPS release and honest offline build. Does not access a device or run a service."""
import argparse
import ctypes as ct
from ctypes import wintypes as wt
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

from release_policy import ReleaseGateError, release_inputs, N14_SIGNER_SHA256, N14_CODE

HERE=Path(__file__).resolve().parent
N14=HERE.parent.parent/"N14_安卓可安装珠宝助手"/"相册仓"
N14_APK=N14/"成品"/"jewelry-owner-n14.apk"
N14_APK_SHA="b837d240b8a589effeede63f5dba19b17a489e6c34d9f25a5532a1d05e63573f"
TOOL_DEFAULT=Path(os.environ["LOCALAPPDATA"])/"CodexToolchains"/"AndroidN14"
PKG="com.zbbio.jewelryassistant.n14"
ACTIVITY=PKG+".MainActivity"
LABEL="珠宝店主助手"
VERSION_NAME="1.1.0-n15"
JAVA_REL=Path("src/java/com/zbbio/jewelryassistant/n14")
RES_PRESERVED=("values/strings.xml","xml/data_extraction_rules.xml","mipmap-anydpi/ic_launcher.xml",
               "mipmap-anydpi-v26/ic_launcher.xml","drawable/launcher_gem.xml")
NS="{http://schemas.android.com/apk/res/android}"
OUT=HERE/"成品"/"jewelry-owner-n15-https.apk"
REPORT=HERE/"网络见证机读结果.json"
PW_ENV="N15_N14_SIGNER_PASSWORD"
N14_PERMS=("android.permission.INTERNET",)
N15_PERMS=("android.permission.INTERNET","android.permission.ACCESS_NETWORK_STATE")
STEPS=[]
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def require(ok, msg):
    if not ok: raise RuntimeError(msg)


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def txt(data):
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("gb18030",errors="replace")


def run(step, args, env, expected=0, binary=False):
    argv=list(map(str,args))
    p=subprocess.run(argv,cwd=HERE,env=env,capture_output=True,timeout=120)
    out="" if binary else txt(p.stdout)
    err=txt(p.stderr)
    if PW_ENV in env:
        out=out.replace(env[PW_ENV],"[redacted]")
        err=err.replace(env[PW_ENV],"[redacted]")
    info={"name":step,"argv":argv,"exitCode":p.returncode,"expectedExitCode":expected,"stdout":out,"stderr":err}
    if binary:
        info["stdoutSha256"]=hashlib.sha256(p.stdout).hexdigest()
        info["stdoutByteLength"]=len(p.stdout)
    STEPS.append(info)
    print(f"{step}: exit={p.returncode} (expected {expected})",flush=True)
    if p.returncode!=expected:
        print((err or out).strip()[:1800],file=sys.stderr,flush=True)
        raise RuntimeError(f"{step}: expected exit {expected}, got {p.returncode}")
    return p.stdout if binary else out


class Blob(ct.Structure):
    _fields_=[("size",wt.DWORD),("ptr",ct.POINTER(ct.c_ubyte))]


def unprotect_signer(encrypted):
    """Authorized release only. The existing N14 CurrentUser key is never rotated here."""
    c=ct.WinDLL("crypt32",use_last_error=True)
    k=ct.WinDLL("kernel32",use_last_error=True)
    fn=c.CryptUnprotectData
    fn.argtypes=[ct.POINTER(Blob),ct.c_void_p,ct.c_void_p,ct.c_void_p,ct.c_void_p,wt.DWORD,ct.POINTER(Blob)]
    fn.restype=wt.BOOL
    k.LocalFree.argtypes=[ct.c_void_p]
    k.LocalFree.restype=ct.c_void_p
    src_bytes=(ct.c_ubyte*len(encrypted)).from_buffer_copy(encrypted)
    src=Blob(len(encrypted),ct.cast(src_bytes,ct.POINTER(ct.c_ubyte)))
    dest=Blob()
    try:
        if not fn(ct.byref(src),None,None,None,None,1,ct.byref(dest)):
            raise RuntimeError("N14 signer is not accessible to this Windows user; no substitute will be generated")
        return ct.string_at(dest.ptr,dest.size).decode("ascii")
    finally:
        ct.memset(src_bytes,0,len(src_bytes))
        if dest.ptr:
            ct.memset(dest.ptr,0,dest.size)
            k.LocalFree(ct.cast(dest.ptr,ct.c_void_p))


def tools_and_env(root):
    j=root/"jdk"
    b=root/"sdk/build-tools/34.0.0"
    t={n:j/"bin"/(n+".exe") for n in ("java","javac","jar","keytool")}
    t.update({"aapt":b/"aapt2.exe","zipalign":b/"zipalign.exe","d8":b/"lib/d8.jar","apksigner":b/"lib/apksigner.jar",
              "androidJar":root/"sdk/platforms/android-34/android.jar"})
    require(all(x.is_file() for x in t.values()),"reuse provisioned N14 JDK17 and SDK34; tools not found")
    drop=("TOKEN","SECRET","PASSWORD","API_KEY","PASSCODE","PAIR_CODE","CREDENTIAL")
    env={key:val for key,val in os.environ.items()
         if not any(piece in key.upper() for piece in drop)
         and key.upper() not in ("JAVA_TOOL_OPTIONS","JDK_JAVA_OPTIONS","_JAVA_OPTIONS")}
    env["JAVA_HOME"]=str(j)
    env["PATH"]=str(j/"bin")+os.pathsep+env.get("PATH","")
    return t,env


def public_signature(path,t,env,step):
    info=run(step,[t["java"],"-jar",t["apksigner"],"verify","--verbose","--print-certs",path],env)
    m=re.search(r"Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})",info)
    require(m and m.group(1).lower()==N14_SIGNER_SHA256 and "Number of signers: 1" in info,
            "APK certificate is not the unique N14 signer")
    require("Verified using v2 scheme (APK Signature Scheme v2): true" in info
            and "Verified using v3 scheme (APK Signature Scheme v3): true" in info,"expected APK v2 and v3")
    return m.group(1).lower()


def package_shape(path,code,t,env,stage,expected_permissions=N15_PERMS):
    dump=run(stage+"_badging",[t["aapt"],"dump","badging",path],env)
    pkg=next((line for line in dump.splitlines() if line.startswith("package:")), "")
    activities=[line for line in dump.splitlines() if line.startswith("launchable-activity:")]
    perms=re.findall(r"^uses-permission: name='([^']+)'",dump,re.M)
    require(f"name='{PKG}'" in pkg and f"versionCode='{code}'" in pkg and len(activities)==1
            and f"name='{ACTIVITY}'" in activities[0] and f"application-label:'{LABEL}'" in dump
            and sorted(perms)==sorted(expected_permissions) and "sdkVersion:'26'" in dump
            and "targetSdkVersion:'34'" in dump,
            "binary package/Launcher/SDK/version/permissions inconsistent")
    return pkg


def source_shape():
    m=ET.parse(HERE/"src/AndroidManifest.xml").getroot()
    a=m.find("application")
    t=a.find("activity")
    f=t.find("intent-filter")
    require(m.get("package")==PKG and a.get(NS+"usesCleartextTraffic")=="false"
            and a.get(NS+"debuggable")=="false" and a.get(NS+"allowBackup")=="false"
            and a.get(NS+"networkSecurityConfig")=="@xml/network_security_config"
            and a.get(NS+"icon")=="@mipmap/ic_launcher"
            and len(a.findall("activity"))==1 and
            sorted(x.get(NS+"name") for x in m.findall("uses-permission"))==sorted(N15_PERMS)
            and [x.get(NS+"name") for x in f.findall("action")]==["android.intent.action.MAIN"]
            and [x.get(NS+"name") for x in f.findall("category")]==["android.intent.category.LAUNCHER"]
            and not f.findall("data"), "source identity/sandbox/Launcher changed")
    net=ET.parse(HERE/"src/res/xml/network_security_config.xml").getroot()
    anchor=net.findall("base-config/trust-anchors/certificates")
    require(net.find("base-config").get("cleartextTrafficPermitted")=="false" and len(net)==1
            and len(anchor)==1 and anchor[0].get("src")=="system" and "overridePins" not in anchor[0].attrib,
            "only system TLS trust and no cleartext is allowed")
    main=(HERE/JAVA_REL/"MainActivity.java").read_text(encoding="utf-8")
    require("BuildOrigin.APPROVED_ORIGIN" in main and "web.loadUrl(origin.home())" in main
            and "WebView.setWebContentsDebuggingEnabled(false)" in main and "handler.cancel()" in main
            and all(x not in main for x in ("handler.proceed", "getIntent()", "addJavascriptInterface",
                "startActivity(", "setWebContentsDebuggingEnabled(true)", "17864", "http://")),
            "source TLS/UI/origin guard changed")
    net_java="\n".join((HERE/JAVA_REL/f).read_text(encoding="utf-8") for f in
                         ("DefaultNetworkProbe.java","NetworkWitness.java","NetworkWitnessView.java"))
    require("getActiveNetwork()" in net_java and "getNetworkCapabilities(active)" in net_java
            and not any(s in net_java for s in ("getSSID","getBSSID","getIpAddress","getLinkProperties",
              "getTransportInfo","getNetworkHandle","WifiManager","getDeviceId","ANDROID_ID","LocationManager",
              "getAdvertisingId","CookieManager","SharedPreferences","android.util.Log","WebView;",
              "addJavascriptInterface","postWebMessage","http://","https://","HttpURLConnection")),
            "network diagnostics must stay coarse, native, ephemeral and local")
    icons=[{"path":"src/res/"+p,"sha256":sha(HERE/"src/res"/p),
            "matchesN14":sha(HERE/"src/res"/p)==sha(N14/"src/res"/p)} for p in RES_PRESERVED]
    require(all(x["matchesN14"] for x in icons),"N14 icon/labels or backup rules differ")
    return icons


def binary_false(xml_dump, attribute):
    factory = r"(?m)(?:^|[:\s])" + re.escape(attribute) + r"(?:\(0x[0-9a-fA-F]+\))?=(?:false|\(type\s+0x12\)0x0)[ \t\r]*$"
    return re.search(factory, xml_dump) is not None


def binary_tls_and_manifest(path,t,env,stage):
    m=run(stage+"_manifest",[t["aapt"],"dump","xmltree","--file","AndroidManifest.xml",path],env)
    require("android.intent.action.MAIN" in m and "android.intent.category.LAUNCHER" in m
            and "android.intent.action.VIEW" not in m and "android.intent.category.BROWSABLE" not in m
            and binary_false(m,"usesCleartextTraffic")
            and binary_false(m,"debuggable"),"binary manifest guard absent")
    with zipfile.ZipFile(HERE/path) as z:
        xn=[x for x in z.namelist() if x.endswith("/network_security_config.xml")]
        require(len(xn)==1 and z.testzip() is None,"compiled network policy not found")
    s=run(stage+"_tls",[t["aapt"],"dump","xmltree","--file",xn[0],path],env)
    require("system" in s and "domain-config" not in s and "debug-overrides" not in s
            and binary_false(s,"cleartextTrafficPermitted"),
            "packaged network policy did not disable cleartext with system trust")


def source_hashes():
    paths=[HERE/"build_apk.py",HERE/"release_policy.py"]
    for d in ("src","tests"):
        paths+=sorted(p for p in (HERE/d).rglob("*") if p.is_file() and p.suffix!=".pyc")
    return [{"path":p.relative_to(HERE).as_posix(),"sha256":sha(p)} for p in paths]


def cli_negatives(env):
    # The only lexically valid hostname string below is an unresolvable test input as far as this process is concerned:
    # no socket or DNS call exists and no output code is generated for it.
    g="https://"+"n15-opaque-cli-validation-5251"+".com"
    neg=[
        ("missing_origin",[], "ORIGIN_REQUIRED_EXACTLY_ONE"),
        ("two_flags",["--origin",g,"--origin",g],"ORIGIN_REQUIRED_EXACTLY_ONE"),
        ("insecure_http",["--origin","http://"+g[8:]],"ORIGIN_NOT_CANONICAL_HTTPS"),
        ("ipv4_loopback",["--origin","https://127.0.0.1"],"ORIGIN_NOT_ALLOWED_DNS"),
        ("ipv6_loopback",["--origin","https://[::1]"],"ORIGIN_NOT_CANONICAL_HTTPS"),
        ("reserved_example",["--origin","https://example.com"],"ORIGIN_NOT_ALLOWED_DNS"),
        ("placeholder",["--origin","https://your-domain.net"],"ORIGIN_NOT_ALLOWED_DNS"),
        ("multiple_in_one_value",["--origin",g+","+g],"ORIGIN_NOT_CANONICAL_HTTPS"),
        ("arbitrary_path",["--origin",g+"/other"],"ORIGIN_NOT_CANONICAL_HTTPS"),
        ("lower_version",["--origin",g,"--version-code","1"],"VERSION_MUST_INCREASE"),
        ("no_approval",["--origin",g],"CONTROLLER_APPROVAL_REQUIRED"),
        ("wrong_approval_file",["--origin",g,"--approval-file",HERE/"src/AndroidManifest.xml","--approval-sha256","0"*64],
         "APPROVAL_NOT_CONTROLLER_PATH"),
    ]
    for name,args,reason in neg:
        run("negative_release_"+name,[sys.executable,"-B","build_apk.py","release","--version-code","2",*args],env,2)
        require(STEPS[-1]["stderr"].strip()=="N15_RELEASE_GATED "+reason,"wrong release gate: "+name)
    return len(neg)


def build(root,mode,origin,version,approval_hash):
    require(HERE.name=="相册仓" and HERE.parent.name=="N15_无线独立后端","unexpected N15 output path")
    t,env=tools_and_env(root)
    require(sha(N14_APK)==N14_APK_SHA,"known N14 APK no longer matches receipt")
    anchors=source_shape()
    hashes=source_hashes()
    before_apks=sorted(str(p) for p in HERE.rglob("*.apk"))
    stage=Path("build")/datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    (HERE/stage).mkdir(parents=True,exist_ok=False)
    for q in ("host","classes","dex"):
        (HERE/stage/q).mkdir()
    run("javac_version",[t["javac"],"-version"],env)
    run("aapt2_version",[t["aapt"],"version"],env)
    run("d8_version",[t["java"],"-cp",t["d8"],"com.android.tools.r8.D8","--version"],env)
    public_signature(N14_APK,t,env,"read_only_public_n14_signature")
    n14_binary=package_shape(N14_APK,N14_CODE,t,env,"read_only_n14",N14_PERMS)
    run("release_policy_unittest",[sys.executable,"-B","-m","unittest","discover","-s","tests",
         "-p","test_release_policy.py","-v"],env)
    unit_match=re.search(r"Ran (\d+) tests",STEPS[-1]["stderr"])
    require(unit_match is not None,"missing Python results")
    run("javac_compile_origin_tests",[t["javac"],"--release","8","-encoding","UTF-8","-d",stage/"host",
         JAVA_REL/"OriginPolicy.java","tests/HttpsOriginPolicyTest.java"],env)
    outcome=run("java_origin_policy_tests",[t["java"],"-cp",stage/"host",PKG+".HttpsOriginPolicyTest"],env)
    host=re.search(r"assertions: (\d+) passed",outcome)
    require(host is not None,"missing JVM results")
    run("javac_compile_native_network_tests",[t["javac"],"--release","8","-encoding","UTF-8","-d",stage/"host",
         JAVA_REL/"NetworkWitness.java","tests/NetworkWitnessTest.java"],env)
    net_out=run("java_native_network_tests",[t["java"],"-cp",stage/"host",PKG+".NetworkWitnessTest"],env)
    native_count=re.search(r"assertions: (\d+) passed",net_out)
    require(native_count is not None,"missing native network host test results")
    fixture=run("java_export_native_v2_fixture",[t["java"],"-cp",stage/"host",PKG+".NetworkWitnessTest","--fixture"],env)
    fixture_path=HERE.parent/"网络见证一致性"/"统一网络见证v2-七阶段合成样本.json"
    require(fixture.encode("utf-8")==fixture_path.read_bytes(),"shared fixture not byte-identical to native serializer")
    fixture_out=run("verify_frozen_shared_v2_fixture",[sys.executable,"-B","tests/verify_network_fixture.py"],env)
    rejected=cli_negatives(env) if mode=="offline-test" else 0
    gen=stage/"BuildOrigin.java"
    (HERE/gen).write_text("package "+PKG+";\nfinal class BuildOrigin { static final String APPROVED_ORIGIN = "
                         +json.dumps(origin or "")+"; }\n",encoding="utf-8")
    generated=ET.parse(HERE/"src/AndroidManifest.xml")
    generated.getroot().set(NS+"versionCode",str(version))
    ET.register_namespace("android",NS[1:-1])
    generated.write(HERE/stage/"AndroidManifest.xml",encoding="utf-8",xml_declaration=True)
    run("compile_android_resources",[t["aapt"],"compile","--dir","src/res","-o",stage/"compiled-res.zip"],env)
    resources=stage/"resources-only.zip"
    run("link_android_manifest_and_resources",[t["aapt"],"link","-o",resources,"--manifest",stage/"AndroidManifest.xml",
         "-I",t["androidJar"],stage/"compiled-res.zip"],env)
    package_shape(resources,version,t,env,"compiled_n15")
    binary_tls_and_manifest(resources,t,env,"compiled_n15")
    run("javac_compile_android_https_shell",[t["javac"],"--release","8","-encoding","UTF-8","-classpath",t["androidJar"],
         "-d",stage/"classes",JAVA_REL/"MainActivity.java",JAVA_REL/"OriginPolicy.java",
         JAVA_REL/"DefaultNetworkProbe.java",JAVA_REL/"NetworkWitness.java",JAVA_REL/"NetworkWitnessView.java",gen],env)
    run("jar_compiled_android_classes",[t["jar"],"cf",stage/"classes.jar","-C",stage/"classes","."],env)
    run("d8_compile_android_https_shell",[t["java"],"-cp",t["d8"],"com.android.tools.r8.D8","--release",
         "--min-api","26","--lib",t["androidJar"],"--output",stage/"dex",stage/"classes.jar"],env)
    dex=stage/"dex"/"classes.dex"
    content=(HERE/dex).read_bytes()
    require(content[:4]==b"dex\n" and b"127.0.0.1:17864" not in content and b"addJavascriptInterface" not in content
            and b"android.intent.action.VIEW" not in content and b"removeAllCookies" not in content,
            "resulting DEX contains a disallowed legacy route or bridge")
    require(all(k in content for k in (b"android_connectivity_manager",b"getActiveNetwork",b"getNetworkCapabilities"))
            and not any(k in content for k in (b"getSSID",b"getBSSID",b"getIpAddress",b"getNetworkHandle",
              b"getLinkProperties",b"getDeviceId",b"getTransportInfo",b"android_id",b"postWebMessage")),
            "compiled DEX network policy differs")
    require(origin is None or origin.encode() in content,"approved origin was not pinned into DEX")
    with zipfile.ZipFile(HERE/resources) as z:
        require("classes.dex" not in z.namelist(),"offline resources must be separated from DEX")
    require(source_hashes()==hashes,"source changed while building")
    result={"state":"offline_compile_verified" if mode=="offline-test" else "ready_for_authorized_signing",
        "mode":mode,"approvedOrigin":origin,"controllerApprovalSha256":approval_hash,"n15CompiledVersionCode":version,
        "oldApk":str(N14_APK),"oldApkSha256Before":N14_APK_SHA,"oldPublicSignerSha256":N14_SIGNER_SHA256,
        "oldBinaryPackage":n14_binary,"unchangedLauncherAndBackupResources":anchors,
        "tested":{"pythonGateCases":int(unit_match.group(1)),"javaOriginAssertions":int(host.group(1)),
                  "negativeReleaseCLIExits":rejected,"androidResourceManifestAndDexCompiled":True,
                  "nativeNetworkJVMAssertions":int(native_count.group(1)),"v2FixtureVerification":fixture_out.strip()},
        "androidPermissions":{"N14Reference":list(N14_PERMS),"N15Compiled":list(N15_PERMS)},
        "networkWitness":{"schema":"n15-net-witness-v2","source":"android_connectivity_manager",
                          "fixturePath":str(fixture_path),"fixtureSha256":sha(fixture_path),
                          "realAndroidSamples":False,"physicalUsbWitnessed":False},
        "buildJavaHome":env["JAVA_HOME"],"buildToolchain":str(root),"sourceDigests":hashes,
        "compileProducts":[{"absolutePath":str(HERE/p),"sha256":sha(HERE/p)}
                            for p in (resources,dex,gen,stage/"AndroidManifest.xml")],
        "releaseApkCreated":False,"privateSignerOpened":False,"phoneActions":0,"serviceCalls":0,"providerCalls":0,
        "internetOrEndpointProbe":False,"cloudDeployed":False,"androidWithoutUsbVerified":False}
    if mode=="offline-test":
        require(sorted(str(p) for p in HERE.rglob("*.apk"))==before_apks==[],"offline build must produce no APK")
        require((HERE/gen).read_text(encoding="utf-8").count('APPROVED_ORIGIN = "";')==1,
                "offline build has a hidden origin")
    else:
        result["apk"]=sign_release(stage,resources,dex,version,t,env)
        result.update(state="approved_apk_compiled_and_signature_verified",releaseApkCreated=True,privateSignerOpened=True)
    result["oldApkSha256After"]=sha(N14_APK)
    require(result["oldApkSha256After"]==N14_APK_SHA,"N14 APK changed")
    return result


def sign_release(stage,resources,dex,version,t,env):
    # No key generation. Authorized release only; CurrentUser access to the existing N14 key is essential.
    home=(TOOL_DEFAULT/"private-signing").resolve()
    key=home/"n14-owner-local.p12"
    wrapped=home/"n14-owner-pass.dpapi"
    require(home.parent==TOOL_DEFAULT.resolve(strict=True) and key.is_file() and wrapped.is_file()
            and key.resolve(strict=True)==key and wrapped.resolve(strict=True)==wrapped,
            "N14 original signing material missing or inaccessible; no substitute")
    passval=unprotect_signer(wrapped.read_bytes())
    env={**env,PW_ENV:passval}
    cert=run("verify_authorized_n14_private_key_public_certificate",[t["keytool"],"-exportcert",
        "-storetype","PKCS12","-keystore",key,"-alias","n14-owner-local","-storepass:env",PW_ENV],env,binary=True)
    require(hashlib.sha256(cert).hexdigest()==N14_SIGNER_SHA256,"N14 private key's certificate differs")
    u, a, candidate=(stage/x for x in ("unsigned.zip","aligned.zip","signed.payload"))
    shutil.copyfile(HERE/resources,HERE/u)
    with zipfile.ZipFile(HERE/u,"a") as z:
        x=zipfile.ZipInfo("classes.dex")
        x.compress_type=zipfile.ZIP_DEFLATED
        z.writestr(x,(HERE/dex).read_bytes())
    run("align_approved_release",[t["zipalign"],"-f","4",u,a],env)
    try:
        run("sign_approved_release",[t["java"],"-jar",t["apksigner"],"sign","--ks",key,
             "--ks-type","PKCS12","--ks-key-alias","n14-owner-local","--ks-pass","env:"+PW_ENV,
             "--key-pass","env:"+PW_ENV,"--min-sdk-version","26","--v1-signing-enabled","false",
             "--v2-signing-enabled","true","--v3-signing-enabled","true","--v4-signing-enabled","false",
             "--out",candidate,a],env)
    finally:
        del passval,env[PW_ENV]
    run("verify_aligned_approved_release",[t["zipalign"],"-c","-v","4",candidate],env)
    cert_sha=public_signature(candidate,t,env,"verify_approved_release_n14_signature")
    package_shape(candidate,version,t,env,"final_n15")
    binary_tls_and_manifest(candidate,t,env,"final_n15")
    apk_sha=sha(HERE/candidate)
    OUT.parent.mkdir(exist_ok=True)
    require(OUT.parent.resolve(strict=True)==OUT.parent,"release output cannot escape the N15 folder")
    if OUT.exists():
        require(OUT.is_file() and sha(OUT)==apk_sha,"frozen N15 APK already differs; leave it unchanged")
    else:
        with OUT.open("xb") as dst,(HERE/candidate).open("rb") as src:
            shutil.copyfileobj(src,dst)
    return {"absolutePath":str(OUT),"sha256":apk_sha,"signerCertificateSha256":cert_sha,"versionCode":version}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("mode",choices=("offline-test","release"))
    p.add_argument("--origin",action="append")
    p.add_argument("--approval-file",type=Path)
    p.add_argument("--approval-sha256")
    p.add_argument("--version-code",type=int)
    p.add_argument("--toolchain-root",type=Path,default=TOOL_DEFAULT)
    a=p.parse_args()
    try:
        # CLI fails before reading signer, starting tools, or creating any outputs.
        if a.mode=="release":
            origin,proof_hash=release_inputs(a.origin,a.version_code,a.approval_file,a.approval_sha256,HERE.parent/"总控")
            ver=a.version_code
        else:
            if any(x is not None for x in (a.origin,a.approval_file,a.approval_sha256,a.version_code)):
                raise ReleaseGateError("OFFLINE_MODE_TAKES_NO_RELEASE_INPUT")
            origin,proof_hash,ver=None,None,2
    except ReleaseGateError as e:
        print("N15_RELEASE_GATED "+e.code,file=sys.stderr)
        return 2
    try:
        r=build(a.toolchain_root,a.mode,origin,ver,proof_hash)
        rc=0
    except Exception as e:
        r={"state":"build_blocked","reason":str(e),"releaseApkCreated":False}
        print(str(e),file=sys.stderr)
        rc=1
    r.update({"task":"N15-WIRE/相册仓","checkedUtc":datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
              "exitCode":rc,"commands":STEPS})
    destiny=REPORT if a.mode=="offline-test" else HERE/"发行机读结果.json"
    destiny.write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"N15 {r['state']}; release_apk={r['releaseApkCreated']}; exit={rc}",flush=True)
    return rc


if __name__=="__main__":
    raise SystemExit(main())
