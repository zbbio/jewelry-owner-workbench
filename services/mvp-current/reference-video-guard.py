import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

FF = shutil.which("ffmpeg")
FP = shutil.which("ffprobe")

def sha(data):
    return hashlib.sha256(data).hexdigest()

def boxes(blob, start, stop):
    pos = start
    while pos < stop:
        if stop - pos < 8:
            raise ValueError("truncated ISO BMFF box")
        size = int.from_bytes(blob[pos:pos+4], "big")
        name = blob[pos+4:pos+8].decode("ascii")
        head = 8
        if size == 1:
            head = 16
            size = int.from_bytes(blob[pos+8:pos+16], "big")
        elif size == 0:
            size = stop - pos
        if size < head or pos + size > stop:
            raise ValueError("invalid ISO BMFF extent")
        yield name, pos, pos + head, pos + size
        pos += size

def child(blob, parent, name):
    found = [box for box in boxes(blob, parent[2], parent[3]) if box[0] == name]
    return found[0] if len(found) == 1 else None

def container(file):
    blob = file.read_bytes()
    top = list(boxes(blob, 0, len(blob)))
    moov = next(b for b in top if b[0] == "moov")
    entries = {}
    for trak in (x for x in boxes(blob, moov[2], moov[3]) if x[0] == "trak"):
        mdia = child(blob, trak, "mdia")
        hdlr = child(blob, mdia, "hdlr")
        kind = blob[hdlr[2]+8:hdlr[2]+12].decode("ascii")
        stsd = child(blob, child(blob, child(blob, mdia, "minf"), "stbl"), "stsd")
        entry_types = [x[0] for x in boxes(blob, stsd[2]+8, stsd[3])]
        count = int.from_bytes(blob[stsd[2]+4:stsd[2]+8], "big")
        if len(entry_types) != count:
            raise ValueError("sample description count mismatch")
        entries.setdefault(kind, []).append(entry_types)
    return {"boxes":[{"type":x[0],"offset":x[1],"size":x[3]-x[1]} for x in top],
            "sampleDescriptions":entries}

def nal_fingerprints(movie):
    # The Annex-B expansion may insert the container's parameter sets; report
    # unique byte fingerprints, not insertion count as independent configs.
    argv = [FF,"-nostdin","-hide_banner","-v","error","-i",str(movie),
            "-map","0:v:0","-c:v","copy","-bsf:v","h264_mp4toannexb","-f","h264","-"]
    cap = subprocess.run(argv, capture_output=True)
    if cap.returncode:
        raise ValueError(cap.stderr.decode("utf-8","replace"))
    chunks = re.split(rb"\x00\x00(?:\x00)?\x01", cap.stdout)
    counters = {7:Counter(),8:Counter()}
    for nal in chunks[1:]:
        if nal and (nal[0]&31) in counters:
            counters[nal[0]&31][sha(nal.rstrip(b"\0"))] += 1
    return {"argv":argv,"exit":cap.returncode,"stderr":cap.stderr.decode("utf-8","replace"),
            "sps":dict(counters[7]),"pps":dict(counters[8]),"annexBBytes":len(cap.stdout)}

def check(file):
    if not FF or not FP:
        raise RuntimeError("FFmpeg and ffprobe must be on PATH")
    args = [FP,"-v","error","-show_streams","-show_format","-of","json",str(file)]
    p = subprocess.run(args,capture_output=True,check=True)
    info = json.loads(p.stdout)
    v = [s for s in info["streams"] if s["codec_type"]=="video"]
    a = [s for s in info["streams"] if s["codec_type"]=="audio"]
    c = container(file)
    n = nal_fingerprints(file)
    v0,a0 = (v or [{}])[0],(a or [{}])[0]
    top = [x["type"] for x in c["boxes"]]
    checks = {
        "oneVideoOneAudio":len(v)==len(a)==1 and len(info["streams"])==2,
        "avc1SampleEntry":v0.get("codec_tag_string")=="avc1" and c["sampleDescriptions"].get("vide")==[["avc1"]],
        "uniformParameterSets":len(n["sps"])==len(n["pps"])==1,
        "h264Main31Yuv420p":(v0.get("codec_name"),v0.get("profile"),v0.get("level"),v0.get("pix_fmt"))==("h264","Main",31,"yuv420p"),
        "videoShapeAndRate":(v0.get("width"),v0.get("height"),v0.get("avg_frame_rate"),v0.get("r_frame_rate"))==(720,1280,"24/1","24/1"),
        "aacLc44100Stereo":(a0.get("codec_name"),a0.get("profile"),a0.get("sample_rate"),a0.get("channels"))==("aac","LC","44100",2),
        "moovBeforeMdat":"mdat" in top and top.index("moov")<top.index("mdat"),
    }
    return {"file":str(file),"sha256":sha(file.read_bytes()),"ffprobe":{"argv":args,"exit":p.returncode},
            "actualVideo":{k:v0.get(k) for k in ("codec_name","profile","level","codec_tag_string","pix_fmt","width","height","nb_frames")},
            "actualAudio":{k:a0.get(k) for k in ("codec_name","profile","sample_rate","channels","duration")},
            "container":c,"nalObserved":n,"checks":checks,"pass":all(checks.values())}

if __name__=="__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    parser=argparse.ArgumentParser()
    parser.add_argument("MP4",type=Path)
    m=check(parser.parse_args().MP4.resolve(strict=True))
    print(json.dumps(m,ensure_ascii=False,indent=2))
    raise SystemExit(0 if m["pass"] else 1)
