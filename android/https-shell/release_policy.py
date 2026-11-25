"""N15 release gate; no DNS, network, credential or filesystem writes."""
import hashlib
import json
import re
from pathlib import Path

SCHEMA = "n15-https-release-v1"
TICKET = "N15-HTTPS"
N14_CODE = 1
N14_SIGNER_SHA256 = "a41b405c00aa7a02cdf493b69ceedfbbe30189948b0075c16286dde87b3d1807"
APPROVAL_NAME = "正式发布准入.json"
FQDN = re.compile(r"https://([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?/?\Z")
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
TLD = re.compile(r"[a-z]{2,63}\Z")
PLACEHOLDERS = frozenset((
    "example", "examples", "sample", "samples", "demo", "placeholder", "your-domain",
    "yourdomain", "your-site", "yoursite", "replace-me", "replaceme", "changeme", "tbd", "todo", "dummy",
))
RESERVED_TLDS = frozenset((
    "local", "localhost", "test", "invalid", "example", "internal", "lan", "home",
    "corp", "onion", "arpa", "alt", "private",
))
APPROVAL_FIELDS = frozenset((
    "schema", "ticket", "approvedOrigin", "releaseApproved", "deploymentVerified", "tlsVerified",
    "controllerApprovalRef", "deploymentEvidenceRef", "maxInstalledVersionCode", "signerCertificateSha256",
))


class ReleaseGateError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def check(ok, code):
    if not ok:
        raise ReleaseGateError(code)


def canonical_origin(raw):
    match = FQDN.fullmatch(raw) if isinstance(raw,str) else None
    check(match is not None, "ORIGIN_NOT_CANONICAL_HTTPS")
    host, explicit_port = match.groups()
    labels = host.split(".")
    check(len(labels)>=2 and len(host)<=253 and all(
        LABEL.fullmatch(x) and x not in PLACEHOLDERS and x != "localhost" for x in labels)
        and TLD.fullmatch(labels[-1]) and labels[-1] not in RESERVED_TLDS,
        "ORIGIN_NOT_ALLOWED_DNS")
    port = int(explicit_port or "443")
    check(port<=65535, "ORIGIN_INVALID_PORT")
    return "https://" + host + ("" if port==443 else ":"+str(port))


def check_version(version, installed):
    check(type(installed) is int and N14_CODE<=installed<2_100_000_000, "APPROVAL_INSTALLED_VERSION_INVALID")
    check(type(version) is int and installed<version<=2_100_000_000, "VERSION_MUST_INCREASE")


def validate_approval(doc, origin, version):
    check(isinstance(doc,dict) and set(doc)==APPROVAL_FIELDS, "APPROVAL_FIELDS_MISMATCH")
    check(doc["schema"]==SCHEMA and doc["ticket"]==TICKET, "APPROVAL_TICKET_MISMATCH")
    check(doc["releaseApproved"] is True and doc["deploymentVerified"] is True and
          doc["tlsVerified"] is True, "APPROVAL_OR_DEPLOYMENT_NOT_READY")
    check(canonical_origin(doc["approvedOrigin"])==origin, "APPROVAL_ORIGIN_MISMATCH")
    for k in ("controllerApprovalRef","deploymentEvidenceRef"):
        ref=doc[k]
        check(isinstance(ref,str) and 1<=len(ref)<=240 and ref.strip()==ref and
              not any(ord(x)<32 for x in ref) and "://" not in ref and "?" not in ref,
              "APPROVAL_EVIDENCE_REF_INVALID")
    check(doc["signerCertificateSha256"]==N14_SIGNER_SHA256, "APPROVAL_N14_SIGNER_MISMATCH")
    check_version(version, doc["maxInstalledVersionCode"])
    return origin


def unique_object(items):
    obj = {}
    for k,v in items:
        check(k not in obj, "APPROVAL_DUPLICATE_KEY")
        obj[k]=v
    return obj


def release_inputs(origins, version, approval_file, approved_sha256, controller_dir):
    check(isinstance(origins,list) and len(origins)==1, "ORIGIN_REQUIRED_EXACTLY_ONE")
    origin=canonical_origin(origins[0])
    check_version(version,N14_CODE)
    check(approval_file is not None and approved_sha256 is not None, "CONTROLLER_APPROVAL_REQUIRED")
    check(re.fullmatch(r"[0-9a-f]{64}",approved_sha256) is not None, "APPROVAL_SHA256_REQUIRED")
    expected=controller_dir/APPROVAL_NAME
    # Copying a document into the build folder is not the controller's source.
    check(Path(approval_file).absolute()==expected, "APPROVAL_NOT_CONTROLLER_PATH")
    check(expected.is_file() and expected.resolve(strict=True)==expected, "CONTROLLER_APPROVAL_NOT_PROVIDED")
    raw=expected.read_bytes()
    check(0<len(raw)<=16_384, "APPROVAL_SIZE_INVALID")
    check(hashlib.sha256(raw).hexdigest()==approved_sha256, "APPROVAL_DIGEST_MISMATCH")
    try:
        doc=json.loads(raw.decode("utf-8-sig"),object_pairs_hook=unique_object)
    except (json.JSONDecodeError,UnicodeDecodeError):
        raise ReleaseGateError("APPROVAL_NOT_UTF8_JSON") from None
    return validate_approval(doc,origin,version), approved_sha256
