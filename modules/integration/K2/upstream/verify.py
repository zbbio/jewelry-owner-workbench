"""Verify fixed Mika presentation slices from local Git objects. Does not fetch or checkout.

python -B verify.py --repo <local-Mika-git-dir>
--emit is a one-time materializer; an existing nonidentical artifact is never overwritten.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
REV = 'e8479330f7284dd0031649636e18e197d6633ece'
SRC = 'companions/mika/scripts/mika_desk/desk.js'
PARTS = ((218, 229, 'tones, terminal'), (231, 233, 'isActive, urgency, threadOf'), (244, 257, 'groupTasks'))
COPY = {'companions/mika/LICENSE': 'licenses/LICENSE',
        'NOTICE': 'licenses/NOTICE',
        'licenses/THIRD_PARTY_NOTICES.md': 'licenses/THIRD_PARTY_NOTICES.md'}
LICENSE_NOTE = 'companions/mika/LICENSE and root LICENSE are identical; root NOTICE and the full upstream third-party inventory retained.'
sha = lambda b: hashlib.sha256(b).hexdigest()

def build(repo):
    env = dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0')
    def git(*args):
        return subprocess.check_output(['git', '-c', 'protocol.allow=never', '-C', str(repo), *args], env=env)
    if git('rev-parse', '--verify', REV+'^{commit}').decode().strip() != REV:
        raise ValueError('missing fixed Mika commit')
    def read(src):
        obj = git('rev-parse', '--verify', REV+':'+src).decode().strip()
        return obj, git('cat-file','blob',obj)
    obj, src = read(SRC)
    if obj != 'ee01ced7b77d2d5e4a855e7e65020d8f00f4abcf':
        raise ValueError('unexpected desk.js git blob')
    lines = src.splitlines(keepends=True)
    banner = ('// Source: wangzan101/Mika @ '+REV+' (Apache-2.0; Copyright 2026 wangzan101).\n'
              '// K2 extraction only: see slice-map.json for upstream path, inclusive ranges and digests.\n'
              '// This file is embedded in a local closure; it has no I/O or execution authority.\n').encode()
    pieces = [b''.join(lines[a-1:b]) for a,b,_ in PARTS]
    out = {'group-tasks.js': banner + b'\n'.join(pieces)}
    mapping = {'commit': REV, 'upstream': 'https://github.com/wangzan101/Mika', 'file': SRC,
               'gitBlob': obj, 'sourceSha256': sha(src),
               'slices': [{'lines':[a,b], 'symbols': sym, 'sha256': sha(piece)} for (a,b,sym),piece in zip(PARTS,pieces)],
               'groupTasksFileSha256': sha(out['group-tasks.js']), 'license':LICENSE_NOTE, 'notices':[]}
    for remote, target in COPY.items():
        oid, data = read(remote)
        if remote == 'companions/mika/LICENSE' and read('LICENSE')[0] != oid:
            raise ValueError('root and component licenses diverged')
        out[target] = data
        mapping['notices'].append({'upstreamPath':remote,'local':target,'gitBlob':oid,'sha256':sha(data)})
    out['slice-map.json'] = (json.dumps(mapping,ensure_ascii=False,indent=2)+'\n').encode()
    return out

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo',type=Path,required=True)
    p.add_argument('--emit',action='store_true')
    args=p.parse_args()
    out=build(args.repo)
    for name,data in out.items():
        f=HERE/name
        if args.emit and not f.exists():
            f.parent.mkdir(parents=True, exist_ok=True)
            with f.open('xb') as dest: dest.write(data)
        if not f.is_file() or f.read_bytes()!=data:
            raise SystemExit('MISMATCH '+name)
    print('PINNED OK | '+REV+' | desk.js blob ee01ced7b77d2d5e4a855e7e65020d8f00f4abcf | 3 intact slices, 3 notices')
