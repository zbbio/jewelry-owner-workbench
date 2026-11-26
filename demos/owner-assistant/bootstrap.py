"""Install pinned wheels into the private embeddable runtime, then prepare examples."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.setup'
SITE = ROOT / 'runtime/python/Lib/site-packages'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verified_download(item):
    if urllib.parse.urlparse(item['url']).scheme != 'https' or urllib.parse.urlparse(item['url']).hostname != 'files.pythonhosted.org':
        raise ValueError('Wheel origin must be the pinned official PyPI distribution host')
    target = CACHE / item['file']
    if target.is_file() and digest(target) == item['sha256']:
        return target
    part = target.with_suffix(target.suffix + '.partial')
    for attempt in range(3):
        try:
            print('Downloading verified dependency: ' + item['name'], flush=True)
            with urllib.request.urlopen(item['url'], timeout=120) as response, part.open('wb') as out:
                shutil.copyfileobj(response, out)
            if digest(part) != item['sha256']:
                raise ValueError('Wheel SHA256 mismatch; refusing to import it')
            shutil.copyfile(part, target)
            part.unlink()
            return target
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)


def extract_wheel(archive, target):
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as wheel:
        for item in wheel.infolist():
            destination = (target / item.filename).resolve()
            if not destination.is_relative_to(target.resolve()):
                raise ValueError('Unsafe archive path')
        wheel.extractall(target)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    lock_path = ROOT / 'runtime-lock.json'
    lock = json.loads(lock_path.read_text(encoding='utf-8-sig'))
    marker = CACHE / 'ready.json'
    prepared = False
    if marker.is_file() and json.loads(marker.read_text(encoding='utf-8')).get('lockSHA256') == digest(lock_path):
        try:
            prepared = all(importlib.metadata.version(p['name']) == p['version'] for p in lock['wheels'])
        except importlib.metadata.PackageNotFoundError:
            pass
    if not prepared:
        for item in lock['wheels']:
            extract_wheel(verified_download(item), SITE)
        # New interpreter discovers freshly extracted distributions without cached import state.
        command = [sys.executable, '-I', '-B', '-c', 'from PIL import Image; from openpyxl import Workbook; import ssl,ctypes,sqlite3; print("Pinned dependencies ready")']
        subprocess.run(command, check=True)
        marker.write_text(json.dumps({'lockSHA256': digest(lock_path), 'packages': lock['wheels']}, indent=2), encoding='utf-8')
    data = ROOT / 'data'
    if not data.exists():
        subprocess.run([sys.executable, '-I', '-B', '-X', 'utf8', str(ROOT / 'app/create-demo-data.py')], check=True)
    elif not all((data / 'seed/demo' / name).is_file() for name in ['分类结果.json', '商品卡索引.json']):
        raise RuntimeError('Existing data is incomplete. Keep it as a backup and extract a fresh source copy; no existing data was deleted.')
    subprocess.run([sys.executable, '-I', '-B', '-X', 'utf8', str(ROOT / 'launcher.py'), '--self-check'], check=True)
    print('READY: runtime and 130 synthetic demo images/cards prepared. No model calls were made.', flush=True)


if __name__ == '__main__':
    main()
