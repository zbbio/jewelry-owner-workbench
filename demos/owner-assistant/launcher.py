"""Portable local demo controller. No host Python, npm, service or admin install."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import html
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
LOCAL = Path(os.environ.get('LOCALAPPDATA', str(ROOT / 'userdata'))) / 'JewelryOwnerDemo' / hashlib.sha256(str(ROOT).encode()).hexdigest()[:16]
STATE = LOCAL / 'running.json'
KEYFILE = LOCAL / 'deepseek.dpapi'
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def read_json(p):
    return json.loads(p.read_text(encoding='utf-8-sig'))


def write_json(p, value):
    p.parent.mkdir(parents=True, exist_ok=True)
    temp = p.with_suffix(p.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    try:
        temp.replace(p)
    except OSError as error:
        # Some redirected/EFS user directories report EXDEV for a same-folder rename.
        if getattr(error, 'winerror', None) != 17 and error.errno != 18:
            raise
        shutil.copyfile(temp, p)
        temp.unlink()


def inside(base, *parts):
    p = base.joinpath(*parts).resolve()
    if not p.is_relative_to(base.resolve()):
        raise ValueError('Path must remain inside the package data directory')
    return p


def basename(value):
    return str(value).replace('\\', '/').split('/')[-1]


def prepare_data():
    demo = DATA / 'demo'
    seed = DATA / 'seed' / 'demo'
    demo.mkdir(parents=True, exist_ok=True)
    for filename in ['分类结果.json', '商品卡索引.json']:
        if not (demo / filename).exists():
            shutil.copy2(seed / filename, demo / filename)
    album = read_json(demo / '分类结果.json')
    album['sourceRoot'] = str(DATA / 'source')
    groups = {}
    for item in album['items']:
        name = basename(item['file'])
        if name != item['file']:
            raise ValueError('Invalid source filename')
        source = inside(DATA / 'source', name)
        target = inside(demo / '分类结果', item['group'], name)
        if not source.is_file():
            raise FileNotFoundError(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(source, target)
        item.update(source=str(source), classified_copy=str(target))
        groups[name] = item['group']
    write_json(demo / '分类结果.json', album)
    index = read_json(demo / '商品卡索引.json')
    index.update(classificationSource=str(demo / '分类结果.json'), cardsDirectory=str(demo / '商品卡'), priceSource=str(DATA / 'price.xlsx'), priceSourceOriginal=str(DATA / 'price.xlsx'))
    for card in index['cards']:
        name = basename(card['sourceImage'])
        group = card.get('albumGroup', groups.get(name, '待确认'))
        card.update(sourceImage=str(inside(DATA / 'source', name)), classifiedImage=str(inside(demo / '分类结果', group, name)), priceSource=str(DATA / 'price.xlsx'))
        write_json(inside(demo / '商品卡', card['cardId'] + '.json'), card)
    write_json(demo / '商品卡索引.json', index)
    return {'images': len(album['items']), 'cards': len(index['cards']), 'videos': len(list((DATA / 'videos').glob('*.mp4')))}


class Blob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]


def protect(value, decrypt=False):
    if os.name != 'nt':
        raise RuntimeError('This bundle is for Windows x64')
    buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
    source, dest = Blob(len(value), buffer), Blob()
    dll = ctypes.WinDLL('crypt32', use_last_error=True)
    fn = dll.CryptUnprotectData if decrypt else dll.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    ok = fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(dest))
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(dest.pbData, dest.cbData)
    finally:
        free = ctypes.WinDLL('kernel32', use_last_error=True).LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(dest.pbData)


def load_key():
    if not KEYFILE.exists():
        return ''
    return protect(KEYFILE.read_bytes(), True).decode('utf-8')


def child_job():
    # Windows closes this non-inherited handle on console exit and kills only our children.
    class Basic(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64), ('flags', wintypes.DWORD), ('min_working', ctypes.c_size_t), ('max_working', ctypes.c_size_t), ('active_limit', wintypes.DWORD), ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
    class Io(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ['read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes']]
    class Extended(ctypes.Structure):
        _fields_ = [('basic', Basic), ('io', Io), ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t), ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    info = Extended()
    info.basic.flags = 0x2000
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    return job


def assign_child(job, child):
    fn = ctypes.WinDLL('kernel32', use_last_error=True).AssignProcessToJobObject
    fn.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    fn.restype = wintypes.BOOL
    if not fn(job, int(child._handle)):
        child.terminate()
        raise ctypes.WinError(ctypes.get_last_error())


def fetch(url, **kwargs):
    return NO_PROXY.open(urllib.request.Request(url, **kwargs), timeout=4)


def existing():
    try:
        state = read_json(STATE)
        with fetch(state['controller'] + '/health') as response:
            active = json.load(response)
        return state if active.get('instance') == state['instance'] else None
    except Exception:
        return None


def self_check():
    from PIL import Image
    from openpyxl import load_workbook
    counts = prepare_data()
    assert counts['images'] == counts['cards'] == 130, counts
    with Image.open(next((DATA / 'source').glob('*.jpg'))) as image:
        image.load()
    book = load_workbook(DATA / 'price.xlsx', read_only=True, data_only=True)
    assert book.active.max_row >= 130
    book.close()
    node = ROOT / 'runtime/node/node.exe'
    result = subprocess.run([str(node), '-e', "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('CREATE TABLE t(x)');d.close();console.log(process.version)"], capture_output=True, text=True, check=True)
    sample = b'portable-test-only-not-a-secret'
    assert protect(protect(sample), True) == sample
    print(json.dumps({'status': 'PASS', 'python': sys.version.split()[0], 'node': result.stdout.strip(), **counts, 'dpapi': 'PASS', 'package': str(ROOT)}, ensure_ascii=False))


def reset():
    if existing():
        raise RuntimeError('请先双击「停止演示.cmd」，再恢复初始资料。')
    # Only generated demo metadata/images are reset; originals, key and chats are retained.
    demo = inside(DATA, 'demo')
    if demo.exists():
        backup = inside(DATA, 'backups', 'demo-' + time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(2))
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(demo), str(backup))
    print(json.dumps(prepare_data(), ensure_ascii=False))
    print('已恢复初始演示；旧生成结果已保存在 data\\backups。原图、密钥和接待记录保留。')


class App:
    def __init__(self, base):
        self.base = base
        self.url = f'http://127.0.0.1:{base + 1}/'
        self.controller = f'http://127.0.0.1:{base}'
        self.token = secrets.token_urlsafe(24)
        self.instance = secrets.token_hex(16)
        self.children = []
        self.files = []
        self.lock = threading.Lock()
        self.mode = 'stopped'
        self.server = None
        self.job = child_job()

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
        for child in self.children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        self.children.clear()
        for f in self.files:
            f.close()
        self.files.clear()
        self.mode = 'stopped'

    def start(self, preview=False):
        self.stop_children()
        counts = prepare_data()
        key = '' if preview else load_key()
        if not preview and not key:
            raise RuntimeError('请先配置 DeepSeek 密钥。')
        env = {k: v for k, v in os.environ.items() if k not in ['PYTHONHOME', 'PYTHONPATH', 'NODE_OPTIONS', 'PORT'] and not k.startswith(('MVP_', 'ANRAN_', 'DEEPSEEK_'))}
        env.update(PORT=str(self.base + 1), MVP_MAIN_PORT=str(self.base + 1), MVP_SALES_PORT=str(self.base + 3), ANRAN_PORT=str(self.base + 3), MVP_PYTHON=str(ROOT / 'runtime/python/python.exe'), MVP_DATA_DIR=str(DATA), MVP_PRICE_SOURCE=str(DATA / 'price.xlsx'), MVP_PREVIEW='1' if preview else '0', ANRAN_DB=str(DATA / 'runtime/messages.sqlite'), PYTHONUTF8='1')
        if key:
            env['DEEPSEEK_API_KEY'] = key
        (DATA / 'runtime').mkdir(parents=True, exist_ok=True)
        LOCAL.mkdir(parents=True, exist_ok=True)
        for script in ['server.mjs', 'anran-server.mjs']:
            log = (LOCAL / (script + '.log')).open('ab')
            self.files.append(log)
            child = subprocess.Popen([str(ROOT / 'runtime/node/node.exe'), script], cwd=ROOT / 'app', env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
            self.children.append(child)
            assign_child(self.job, child)
        try:
            for port, host, route in [(self.base + 1, '127.0.0.1', '/'), (self.base + 3, '127.0.0.1', '/demo/shop?sku=DEMO105'), (self.base + 3, 'localhost', '/demo/owner')]:
                deadline = time.monotonic() + 25
                while True:
                    try:
                        with fetch(f'http://{host}:{port}{route}') as response:
                            assert response.status == 200
                        break
                    except Exception:
                        if any(p.poll() is not None for p in self.children) or time.monotonic() > deadline:
                            raise RuntimeError('服务启动失败，请查看本地日志：' + str(LOCAL))
                        time.sleep(0.2)
            self.mode = 'preview' if preview else 'live'
            print(f'演示已启动（{"只读预览" if preview else "真实模型"}）：{self.url}  {counts}', flush=True)
        except Exception:
            self.stop_children()
            raise

    def page(self, error=''):
        key_status = '此电脑已保存密钥' if KEYFILE.exists() else '此电脑尚未配置密钥'
        status = {'live': '真实模型已连接', 'preview': '只读预览：不调用模型、不重新分类', 'stopped': '尚未启动'}[self.mode]
        return f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>启动珠宝助手演示</title><style>body{{font:20px/1.7 system-ui;background:#f5f7f2;color:#153e31;max-width:780px;margin:50px auto;padding:24px}}input,button,a{{font:inherit}}input{{width:100%;box-sizing:border-box;padding:12px}}button,.link{{display:inline-block;padding:10px 18px;background:#174b3c;color:white;border:0;border-radius:10px;margin:10px 5px 10px 0}}small{{color:#53675d}}.err{{color:#a22}}</style><h1>珠宝店主助手 · 便携演示</h1><p>{status} · {key_status}</p><p class="err">{html.escape(error)}</p><p>第一次在这台电脑使用：填入你自己的 DeepSeek API 密钥，然后启动。密钥仅在当前 Windows 用户下加密保存，不放在网页或压缩包里。</p><form method="post" action="/configure"><input type="hidden" name="token" value="{self.token}"><input name="key" type="password" placeholder="首次填入 API 密钥；已保存则可留空" autocomplete="off"><button>保存并启动真实演示</button></form><form method="post" action="/preview"><input type="hidden" name="token" value="{self.token}"><button>先看已有资料（不调用模型）</button></form><p><a class="link" href="{self.url}">打开珠宝助手</a> <a href="{self.url}gallery">查看分类照片</a> · <a href="{self.url}catalog">查看商品卡</a></p><p>四个能力可分别使用，不必按顺序。相册/商品卡重新生成会使用真实模型并计费；销售接待会自动回复演示店顾客；内容仅列三个镜头，不做视频。</p><small>演示期间保留启动窗口。使用结束双击「停止演示.cmd」。本包是 Windows 10/11 x64 本地演示，不是公网云服务。</small></html>'''


def run(args):
    LOCAL.mkdir(parents=True, exist_ok=True)
    prior = existing()
    if prior:
        if not args.no_browser:
            webbrowser.open(prior['controller'])
        print('已有演示运行：' + prior['controller'])
        return
    # Controller/main/sales must all be available; choose another block instead of killing an app.
    base = args.base_port
    while base < args.base_port + 100:
        probes = []
        try:
            for port in [base, base + 1, base + 3]:
                s = socket.socket()
                probes.append(s)
                s.bind(('127.0.0.1', port))
            break
        except OSError:
            base += 10
        finally:
            for s in probes:
                s.close()
    else:
        raise RuntimeError('没有空闲的本地演示端口，请先停止旧演示。')
    app = App(base)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, code, body, content='text/html; charset=utf-8'):
            self.send_response(code)
            self.send_header('Content-Type', content)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(body.encode('utf-8'))

        def do_GET(self):
            if self.headers.get('Host') != f'127.0.0.1:{base}':
                return self.send(403, 'Invalid host')
            if self.path == '/health':
                return self.send(200, json.dumps({'instance': app.instance, 'mode': app.mode, 'app': app.url}), 'application/json')
            return self.send(200, app.page())

        def do_POST(self):
            if self.headers.get('Host') != f'127.0.0.1:{base}' or self.headers.get('Origin', app.controller) != app.controller:
                return self.send(403, 'Invalid origin')
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 4096:
                return self.send(413, 'Invalid request length')
            values = urllib.parse.parse_qs(self.rfile.read(length).decode('utf-8'))
            if not secrets.compare_digest(values.get('token', [''])[0], app.token):
                return self.send(403, 'Invalid token')
            if self.path == '/stop':
                self.send(200, '演示正在停止。')
                threading.Thread(target=app.server.shutdown, daemon=True).start()
                return
            if self.path not in ['/configure', '/preview']:
                return self.send(404, 'Not found')
            with app.lock:
                try:
                    if self.path == '/configure':
                        key = values.get('key', [''])[0].strip()
                        if key:
                            if not key.startswith('sk-') or len(key) < 20 or len(key) > 256 or any(ch.isspace() for ch in key):
                                raise ValueError('密钥格式不正确，请重新复制。')
                            request = urllib.request.Request('https://api.deepseek.com/models', headers={'Authorization': 'Bearer ' + key})
                            with urllib.request.urlopen(request, timeout=25) as response:
                                assert response.status == 200
                            KEYFILE.write_bytes(protect(key.encode()))
                        app.start(preview=False)
                    else:
                        app.start(preview=True)
                    self.send_response(303)
                    self.send_header('Location', app.url)
                    self.end_headers()
                except urllib.error.HTTPError as error:
                    self.send(400, app.page('密钥在线验证失败，服务返回 HTTP ' + str(error.code)))
                except Exception as error:
                    self.send(400, app.page(str(error)))

    app.server = ThreadingHTTPServer(('127.0.0.1', base), Handler)
    app.server.daemon_threads = True
    write_json(STATE, {'controller': app.controller, 'instance': app.instance, 'token': app.token, 'pid': os.getpid()})
    try:
        if args.preview or KEYFILE.exists():
            app.start(preview=args.preview)
        print('启动管理页：' + app.controller, flush=True)
        print('请保留本窗口；结束演示请双击「停止演示.cmd」或按 Ctrl+C。', flush=True)
        if not args.no_browser:
            webbrowser.open(app.url if app.mode != 'stopped' else app.controller)
        app.server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        app.stop_children()
        app.server.server_close()
        close = ctypes.WinDLL('kernel32').CloseHandle
        close.argtypes = [wintypes.HANDLE]
        close(app.job)
        if STATE.exists() and read_json(STATE).get('instance') == app.instance:
            STATE.unlink()
        print('演示已停止。', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-port', type=int, default=4296)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--preview', action='store_true')
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--stop', action='store_true')
    parser.add_argument('--reset', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.base_port <= 65400:
        raise ValueError('Port out of range')
    if args.self_check:
        return self_check()
    if args.reset:
        return reset()
    if args.stop:
        state = existing()
        if not state:
            print('当前没有运行中的演示。')
            return
        body = urllib.parse.urlencode({'token': state['token']}).encode()
        with fetch(state['controller'] + '/stop', data=body, method='POST', headers={'Content-Type': 'application/x-www-form-urlencoded'}) as response:
            print(response.read().decode('utf-8'))
        return
    return run(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('启动检查失败：' + str(error), file=sys.stderr)
        raise SystemExit(1)
