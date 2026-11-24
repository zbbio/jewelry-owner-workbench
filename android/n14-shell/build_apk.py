"""Build and verify the one N14 owner APK using the already-provisioned SDK/JDK.

Run: python -B build_apk.py [--verify-only]
No ADB, external downloads, service credentials or model requests.
"""
import argparse
import ctypes as ct
from ctypes import wintypes as wt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
import zipfile

HERE = Path(__file__).resolve().parent
BASE = Path(os.environ["LOCALAPPDATA"]) / "CodexToolchains" / "AndroidN14"
KEY_HOME = BASE / "private-signing"
KEY = KEY_HOME / "n14-owner-local.p12"
WRAP = KEY_HOME / "n14-owner-pass.dpapi"
KEY_ALIAS = "n14-owner-local"
PWENV = "N14_LOCAL_SIGNING_PASSWORD"
PACKAGE = "com.zbbio.jewelryassistant.n14"
ACTIVITY = PACKAGE + ".MainActivity"
LABEL = "珠宝店主助手"
ORIGIN = "http://127.0.0.1:17864/"
FINAL = HERE / "成品" / "jewelry-owner-n14.apk"
JAVA_PACKAGE_PATH = Path("src/java/com/zbbio/jewelryassistant/n14")
STAMP = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
STEP_ROOT = Path("build") / STAMP
STEPS = []
ANDROID = "{http://schemas.android.com/apk/res/android}"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


class Blob(ct.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ct.POINTER(ct.c_ubyte))]


def dpapi(data, protect):
    """DPAPI CurrentUser, no human prompt and no plaintext persistence."""
    raw = (ct.c_ubyte * len(data)).from_buffer_copy(data)
    src = Blob(len(data), ct.cast(raw, ct.POINTER(ct.c_ubyte)))
    out = Blob()
    crypto = ct.WinDLL("crypt32", use_last_error=True)
    kernel = ct.WinDLL("kernel32", use_last_error=True)
    free = kernel.LocalFree
    free.argtypes = [ct.c_void_p]
    free.restype = ct.c_void_p
    api = crypto.CryptProtectData if protect else crypto.CryptUnprotectData
    api.argtypes = [
        ct.POINTER(Blob), wt.LPCWSTR if protect else ct.c_void_p,
        ct.c_void_p, ct.c_void_p, ct.c_void_p, wt.DWORD, ct.POINTER(Blob),
    ]
    api.restype = wt.BOOL
    try:
        if not api(ct.byref(src), "N14 local pilot key" if protect else None,
                   None, None, None, 1, ct.byref(out)):
            raise ct.WinError(ct.get_last_error())
        return ct.string_at(out.pbData, out.cbData)
    finally:
        ct.memset(raw, 0, len(raw))
        if out.pbData:
            ct.memset(out.pbData, 0, out.cbData)
            free(ct.cast(out.pbData, ct.c_void_p))


def require(value, text):
    if not value:
        raise RuntimeError(text)


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def decode(b):
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("gb18030", errors="replace")


def exec_step(name, args, env):
    argv = list(map(str, args))
    p = subprocess.run(argv, cwd=HERE, env=env, capture_output=True, timeout=120)
    out, err = decode(p.stdout), decode(p.stderr)
    # Signing commands only receive a variable NAME. Never save the child's environment.
    if PWENV in env:
        pw = env[PWENV]
        out, err = out.replace(pw, "[redacted]"), err.replace(pw, "[redacted]")
    STEPS.append({"name":name,"argv":argv,"exitCode":p.returncode,"stdout":out,"stderr":err})
    print(f"{name}: exit={p.returncode}", flush=True)
    if p.returncode:
        print((err or out).strip()[:2500], flush=True)
        raise RuntimeError(f"{name} failed with exit {p.returncode}")
    return out


def ensure_key(keytool, env):
    KEY_HOME.mkdir(exist_ok=True)
    home = KEY_HOME.resolve(strict=True)
    # The Codex MSIX container may redirect LOCALAPPDATA. Verify the physical parent.
    require(home.parent == BASE.resolve(strict=True), "signer directory escaped the provisioned private toolchain root")
    require(KEY.exists() == WRAP.exists(), "N14 signer storage incomplete; keep files and check with coordinator")
    if WRAP.is_file():
        require(KEY.resolve(strict=True).parent == home and WRAP.resolve(strict=True).parent == home,
                "existing signer material escaped the private directory")
        return dpapi(WRAP.read_bytes(), False).decode("ascii")
    pw = secrets.token_urlsafe(36)
    protected = dpapi(pw.encode("ascii"), True)
    require(dpapi(protected, False).decode("ascii") == pw, "DPAPI same-user verification failed")
    child = {**env, PWENV:pw}
    exec_step("create_local_pilot_signer", [
        keytool, "-genkeypair", "-storetype", "PKCS12", "-keystore", KEY,
        "-alias", KEY_ALIAS, "-keyalg", "RSA", "-keysize", "3072",
        "-sigalg", "SHA256withRSA", "-validity", "3650",
        "-dname", "CN=N14 Jewelry Owner Local Pilot,O=Local Test,C=CN",
        "-storepass:env", PWENV, "-keypass:env", PWENV, "-noprompt",
    ], child)
    with WRAP.open("xb") as f:
        f.write(protected)
    return pw


def assert_source_shape():
    m = ET.parse(HERE/"src/AndroidManifest.xml").getroot()
    require(m.attrib["package"] == PACKAGE, "wrong source application ID")
    require([x.attrib[ANDROID+"name"] for x in m.findall("uses-permission")]
            == ["android.permission.INTERNET"], "unexpected source permissions")
    a = m.find("application")
    require(a.get(ANDROID+"allowBackup") == a.get(ANDROID+"debuggable") == "false"
            and a.get(ANDROID+"usesCleartextTraffic") == "false"
            and a.get(ANDROID+"networkSecurityConfig") == "@xml/network_security_config",
            "source sandbox/config changed")
    require(len(a.findall("activity")) == 1 and not a.findall("service") and not a.findall("receiver")
            and not a.findall("provider"), "unexpected app components")
    t = a.find("activity")
    require(t.get(ANDROID+"name") == ".MainActivity" and t.get(ANDROID+"exported") == "true",
            "source launcher changed")
    i = t.find("intent-filter")
    require([x.get(ANDROID+"name") for x in i.findall("action")] == ["android.intent.action.MAIN"]
            and [x.get(ANDROID+"name") for x in i.findall("category")] == ["android.intent.category.LAUNCHER"]
            and not i.findall("data"), "an external declarative route was added")
    net = ET.parse(HERE/"src/res/xml/network_security_config.xml").getroot()
    domain = net.find("domain-config/domain")
    require(net.find("base-config").get("cleartextTrafficPermitted") == "false"
            and domain.text == "127.0.0.1" and domain.get("includeSubdomains") == "false"
            and len(net.findall("domain-config")) == 1 and len(net.findall(".//domain")) == 1,
            "source cleartext allowlist changed")


def verify_apk(path, env, java, signer, aapt, zipalign):
    exec_step("zipalignment_verify", [zipalign, "-c", "-v", "4", path], env)
    sig = exec_step("verify_apk_signature", [java, "-jar", signer, "verify", "--verbose", "--print-certs", path], env)
    m = re.search(r"Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})", sig)
    require(m is not None and "Number of signers: 1" in sig, "expected one APK certificate")
    require("Verified using v2 scheme (APK Signature Scheme v2): true" in sig
            and "Verified using v3 scheme (APK Signature Scheme v3): true" in sig,
            "expected v2/v3 APK signing")
    badging = exec_step("inspect_binary_package", [aapt, "dump", "badging", path], env)
    app = next((line for line in badging.splitlines() if line.startswith("application:")), "")
    activities = [line for line in badging.splitlines() if line.startswith("launchable-activity:")]
    permissions = re.findall(r"^uses-permission: name='([^']+)'", badging, re.M)
    require(f"package: name='{PACKAGE}'" in badging and len(activities)==1
            and f"name='{ACTIVITY}'" in activities[0], "incorrect binary package or launcher")
    require(f"application-label:'{LABEL}'" in badging and "icon='res/mipmap" in app,
            "binary label/icon do not match")
    require(permissions == ["android.permission.INTERNET"], "binary permissions differ")
    require("sdkVersion:'26'" in badging and "targetSdkVersion:'34'" in badging, "wrong SDK range")
    manifest = exec_step("inspect_binary_manifest", [aapt, "dump", "xmltree", "--file", "AndroidManifest.xml", path], env)
    require("android.intent.action.MAIN" in manifest and "android.intent.category.LAUNCHER" in manifest
            and "android.intent.action.VIEW" not in manifest and "android.intent.category.BROWSABLE" not in manifest,
            "binary MAIN/LAUNCHER is not exclusive")
    disk = HERE / path
    with zipfile.ZipFile(disk) as z:
        names = z.namelist()
        require(len(names) == len(set(names)) and z.testzip() is None, "bad APK ZIP")
        require("classes.dex" in names and "AndroidManifest.xml" in names and "resources.arsc" in names,
                "missing Android package entries")
        require(all(n in {"classes.dex","AndroidManifest.xml","resources.arsc"} or n.startswith("res/")
                    for n in names), "unexpected APK payload files")
        dex = z.read("classes.dex")
        require(ORIGIN.encode() in dex and b"addJavascriptInterface" not in dex and b"android.intent.action.VIEW" not in dex
                and b"removeAllCookies" not in dex and b"removeSessionCookies" not in dex,
                "binary origin or bridge/cookie/external launch guard differs")
        require(not re.search(rb"sk-[A-Za-z0-9_-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----", dex),
                "credential-shaped binary data detected")
        net_files = [n for n in names if n.endswith("/network_security_config.xml")]
        require(len(net_files) == 1, "binary network configuration not packaged")
    config = exec_step("inspect_binary_network_policy", [aapt, "dump", "xmltree", "--file", net_files[0], path], env)
    require("127.0.0.1" in config and "base-config" in config and "domain-config" in config,
            "binary network config differs")
    return {"apkSha256":sha(disk),"apkBytes":disk.stat().st_size,
            "signerCertificateSha256":m.group(1).lower(),"manifestPackage":PACKAGE,
            "launcherLabel":LABEL,"launcherActivity":ACTIVITY,
            "minSdk":26,"targetSdk":34,"testedPhoneApi":"31 (per controller; not installed by album)",
            "permissions":permissions,"v2SignatureVerified":True,"v3SignatureVerified":True,
            "binaryZipVerified":True}


def inputs():
    paths = sorted((HERE/"src").rglob("*")) + sorted((HERE/"tests").rglob("*")) + [Path(__file__)]
    return [{"path":p.relative_to(HERE).as_posix(),"sha256":sha(p)} for p in paths if p.is_file()]


def build(args):
    require(HERE.name=="相册仓" and HERE.parent.name=="N14_安卓可安装珠宝助手", "unexpected build directory")
    jdk = args.toolchain_root/"jdk"
    bt = args.toolchain_root/"sdk/build-tools/34.0.0"
    android = args.toolchain_root/"sdk/platforms/android-34/android.jar"
    java, javac, jar, keytool = (jdk/"bin"/(n+".exe") for n in ("java","javac","jar","keytool"))
    aapt, zipalign = bt/"aapt2.exe", bt/"zipalign.exe"
    d8, signer = bt/"lib/d8.jar", bt/"lib/apksigner.jar"
    for p in (java,javac,jar,keytool,aapt,zipalign,d8,signer,android):
        require(p.is_file(), f"provisioned build tool missing: {p}")
    env = os.environ.copy()
    env["JAVA_HOME"] = str(jdk)
    env["PATH"] = str(jdk/"bin") + os.pathsep + env.get("PATH","")
    env.pop(PWENV,None)
    env.pop("JAVA_TOOL_OPTIONS",None)
    env.pop("JDK_JAVA_OPTIONS",None)
    env.pop("_JAVA_OPTIONS",None)
    assert_source_shape()
    source_hashes = inputs()
    if args.verify_only:
        result=verify_apk(FINAL.relative_to(HERE),env,java,signer,aapt,zipalign)
        print(f"verified {FINAL} SHA-256 {result['apkSha256']}", flush=True)
        return result, source_hashes
    (HERE/STEP_ROOT).mkdir(parents=True, exist_ok=False)
    res, linked, u, a, out = (STEP_ROOT/n for n in ("resources.zip","linked.zip","unaligned.zip","aligned.zip","signed.payload"))
    classes, dex, hv = (STEP_ROOT/n for n in ("classes","dex","host-tests"))
    for d in (classes,dex,hv):
        (HERE/d).mkdir()
    exec_step("javac_version",[javac,"-version"],env)
    exec_step("aapt2_version",[aapt,"version"],env)
    exec_step("d8_version",[java,"-cp",d8,"com.android.tools.r8.D8","--version"],env)
    exec_step("apksigner_version",[java,"-jar",signer,"version"],env)
    exec_step("compile_origin_host_test",[javac,"--release","8","-encoding","UTF-8","-d",hv,
             JAVA_PACKAGE_PATH/"OriginPolicy.java","tests/OriginPolicyTest.java"],env)
    host = exec_step("run_origin_host_test",[java,"-cp",hv,PACKAGE+".OriginPolicyTest"],env)
    host_n = re.search(r"OriginPolicy unit checks: (\d+) passed",host)
    require(host_n is not None, "host policy tests did not report success")
    exec_step("compile_android_resources",[aapt,"compile","--dir","src/res","-o",res],env)
    exec_step("link_android_manifest",[aapt,"link","-o",linked,"--manifest","src/AndroidManifest.xml","-I",android,res],env)
    exec_step("compile_android_java",[javac,"--release","8","-encoding","UTF-8","-classpath",android,
             "-d",classes,JAVA_PACKAGE_PATH/"MainActivity.java",JAVA_PACKAGE_PATH/"OriginPolicy.java"],env)
    j = STEP_ROOT/"classes.jar"
    exec_step("jar_compiled_classes",[jar,"cf",j,"-C",classes,"."],env)
    exec_step("dex_classes",[java,"-cp",d8,"com.android.tools.r8.D8","--release","--min-api","26",
             "--lib",android,"--output",dex,j],env)
    shutil.copyfile(HERE/linked,HERE/u)
    with zipfile.ZipFile(HERE/u,"a") as z:
        e=zipfile.ZipInfo("classes.dex")
        e.compress_type=zipfile.ZIP_DEFLATED
        z.writestr(e,(HERE/dex/"classes.dex").read_bytes())
    STEPS.append({"name":"append_root_dex","exitCode":0,"detail":"only classes.dex added; deterministic ZIP entry metadata"})
    exec_step("zipalign_before_sign",[zipalign,"-f","4",u,a],env)
    pw = ensure_key(keytool,env)
    try:
        exec_step("sign_local_pilot_apk",[java,"-jar",signer,"sign","--ks",KEY,"--ks-type","PKCS12",
            "--ks-key-alias",KEY_ALIAS,"--ks-pass","env:"+PWENV,"--key-pass","env:"+PWENV,
            "--min-sdk-version","26","--v1-signing-enabled","false","--v2-signing-enabled","true",
            "--v3-signing-enabled","true","--v4-signing-enabled","false","--out",out,a],{**env,PWENV:pw})
    finally:
        del pw
    result=verify_apk(out,env,java,signer,aapt,zipalign)
    require(inputs()==source_hashes,"source files changed while compiling")
    FINAL.parent.mkdir(exist_ok=True)
    if FINAL.exists():
        require(sha(FINAL)==result["apkSha256"],"published APK differs; leave existing frozen file unchanged")
    else:
        with FINAL.open("xb") as dst, (HERE/out).open("rb") as src:
            shutil.copyfileobj(src,dst)
    require(sha(FINAL)==result["apkSha256"],"published APK digest mismatch")
    result["originPolicyJvmChecks"]=int(host_n.group(1))
    result["apkAbsolutePath"]=str(FINAL)
    print(f"signed {FINAL} SHA-256 {result['apkSha256']}", flush=True)
    return result,source_hashes


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--toolchain-root",type=Path,default=BASE)
    p.add_argument("--verify-only",action="store_true")
    args=p.parse_args()
    try:
        apk, hashes=build(args)
        code=0
        result={"state":"signed_apk_verified_locally","apk":apk,"sourceDigests":hashes,
                "toolchainRoot":str(args.toolchain_root),"javaHomeForBuild":str(args.toolchain_root/"jdk"),
                "gradleUsed":False,"origin":ORIGIN,"artifactPolicy":"one formal owner APK only",
                "deviceTests":{"installedByAlbum":False,"usbTouchedByAlbum":False,"modelCallsByAlbum":0,
                  "devicePairingAndReopen":"not_run","qaOverlayAndActualABNoCard":"not_run"}}
    except Exception as ex:
        code=1
        result={"state":"build_blocked","reason":str(ex)}
        print(str(ex),file=sys.stderr)
    result.update({"task":"N14-APK/相册仓","utc":datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                   "steps":STEPS,"exitCode":code})
    if not args.verify_only:
        (HERE/"机读结果.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    return code


if __name__=="__main__":
    raise SystemExit(main())
