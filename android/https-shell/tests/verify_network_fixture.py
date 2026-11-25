"""Check the one frozen v2 JVM fixture; this never produces trusted or physical evidence."""
from copy import deepcopy
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

V2_SHA="ed804dbaabf42d9cc5701e88c7115e5d11ce40bf74e0a272691ed82f5718c3a9"
SAMPLE_SHA="c5e05546c6cdd153f0857d8087beaf404bee2c1eaa953b0876d455a1c4d98b3d"
SCHEMA="n15-net-witness-v2"
DIR=Path(__file__).resolve().parents[2]/"网络见证一致性"
FIELDS=("stage","utc","source","testNo","networkType","validated","vpnActive","requestTail")


def require(ok, why):
    if not ok: raise ValueError(why)


def utc(value):
    require(isinstance(value,str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",value) is not None,"timestamp")
    return datetime.fromisoformat(value.replace("Z","+00:00"))


def deltas(a,b):
    return (b-a).total_seconds()


def tail(request_id):
    require(re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", request_id) is not None,"synthetic audit uuid")
    return request_id.replace("-","")[-8:]


def fixture_check(document, spec):
    require(document.get("schema")==spec["schema"]==SCHEMA and document.get("fixtureOnly") is True
            and document.get("provenance")=="host_jvm_synthetic_only","fixture scope")
    rules=spec["networkSamples"]
    require(tuple(rules["sampleFields"])==FIELDS,"schema field drift")
    rows=document["networkSamples"]
    stages=rules["stageOrder"]
    require([r["stage"] for r in rows]==stages and len(rows)==7,"stage order")
    anchor=rows[0]["testNo"]
    for r in rows:
        require(tuple(r)==FIELDS and r["source"]==rules["source"],"field/source mismatch")
        require(r["testNo"]==anchor and re.fullmatch(r"N15-[A-Z0-9]{4,12}",r["testNo"]),"testNo")
        require(r["networkType"]==rows[0]["networkType"] and r["networkType"] in ("WIFI","CELLULAR")
                and r["validated"] is True and r["vpnActive"] is False,"fixture lane")
        if r["stage"] in ("bVisible","afterLateA"):
            require(isinstance(r["requestTail"],str) and re.fullmatch(r"[0-9a-f]{8}",r["requestTail"]),"B tail")
        else:
            require(r["requestTail"] is None,"no future or pre-request tail")
    t={x["stage"]:utc(x["utc"]) for x in rows}
    require(all(t[a]<t[b] for a,b in zip(stages,stages[1:])),"sample sequence")
    p=document["syntheticTiming"]
    u={k:utc(v) for k,v in p.items() if k.endswith("Utc") or k.endswith("RequestAt")}
    require(0<=deltas(u["launcherTapUtc"],t["launch"])<=10
            and 0<=deltas(u["ownerReopenTapUtc"],t["ownerReopen"])<=10,"desktop timing")
    for phase in ("askA","askB","noCard"):
        require(0<=deltas(t[phase],u[phase+"TapUtc"])<=10
                and 0<=deltas(u[phase+"TapUtc"],u[phase+"RequestAt"])<=15,"pre-request or audit ingress timing")
    b=tail(p["bRequestId"])
    release=u["aReleasedUtc"]
    require(rows[3]["requestTail"]==rows[4]["requestTail"]==b and
            u["askBRequestAt"]<=u["bResponseUtc"]<=min(t["bVisible"],u["bVisibleUiUtc"]) and
            max(t["bVisible"],u["bVisibleUiUtc"])<release<min(t["afterLateA"],u["lateAUiUtc"])
            and abs(deltas(t["bVisible"],u["bVisibleUiUtc"]))<=10
            and abs(deltas(t["afterLateA"],u["lateAUiUtc"]))<=10,"B received, visible and late A timeline")
    require(u["noCardRequestAt"]<=u["noCardUiUtc"] and p["noCardUiRequestTail"]==tail(p["noCardRequestId"])
            and p["noCardUiRequestTail"]!=b,"separate no-card receipt")
    return 7


def with_row(x,i,k,v): x["networkSamples"][i][k]=v
def with_timing(x,k,v): x["syntheticTiming"][k]=v


def main():
    contract_file=DIR/"统一网络见证v2.json"
    sales=DIR.parent/"销售仓"/"跨仓统一网络见证契约.json"
    sample_file=DIR/"统一网络见证v2-七阶段合成样本.json"
    spec=contract_file.read_bytes()
    sample=sample_file.read_bytes()
    require(hashlib.sha256(spec).hexdigest()==V2_SHA and spec==sales.read_bytes(),"frozen sales v2 bytes changed")
    require(hashlib.sha256(sample).hexdigest()==SAMPLE_SHA,"shared sample bytes changed")
    c=json.loads(spec.decode("utf-8-sig"))
    f=json.loads(sample.decode("utf-8-sig"))
    n=fixture_check(f,c)
    negatives=[
        lambda x: with_row(x,0,"defaultNetworkRef","not-a-network-id"),
        lambda x: with_row(x,1,"source","web_page"),
        lambda x: with_row(x,2,"testNo","N15-XYZ"),
        lambda x: with_row(x,3,"networkType","OTHER"),
        lambda x: with_row(x,3,"vpnActive",True),
        lambda x: with_row(x,4,"validated",False),
        lambda x: with_row(x,1,"requestTail","11223344"),
        lambda x: with_row(x,2,"requestTail","11223344"),
        lambda x: with_row(x,5,"requestTail","55aa33cc"),
        lambda x: with_row(x,3,"requestTail","55aa33cc"),
        lambda x: with_timing(x,"bResponseUtc","2026-01-01T00:00:29.000Z"),
        lambda x: with_timing(x,"askARequestAt","2026-01-01T00:00:09.000Z"),
        lambda x: with_timing(x,"askBRequestAt","2026-01-01T00:00:36.000Z"),
        lambda x: with_timing(x,"aReleasedUtc","2026-01-01T00:00:26.000Z"),
        lambda x: with_timing(x,"aReleasedUtc","2026-01-01T00:00:41.000Z"),
        lambda x: with_timing(x,"noCardUiRequestTail","11223344"),
        lambda x: with_row(x,6,"utc","2026-01-01T00:00:56.000Z"),
        lambda x: x.update(fixtureOnly=False),
    ]
    for i, update in enumerate(negatives,1):
        candidate=deepcopy(f)
        update(candidate)
        try:
            fixture_check(candidate,c)
        except ValueError:
            continue
        raise AssertionError(f"negative fixture condition {i} accepted")
    print(f"frozen v2 fixture: {n} phases match; {len(negatives)} negatives rejected; synthetic only")


if __name__=="__main__":
    main()
