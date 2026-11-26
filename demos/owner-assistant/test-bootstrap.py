"""Offline guards for the installer. No downloads or model calls."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location('demo_bootstrap', Path(__file__).with_name('bootstrap.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='demo-setup-guards-') as name:
    root = Path(name)
    module.CACHE = root / 'cache'
    module.CACHE.mkdir()
    try:
        module.verified_download({'url': 'http://example.invalid/unsafe.whl', 'file': 'unsafe.whl', 'sha256': '0' * 64})
        raise AssertionError('non-official origin accepted')
    except ValueError:
        pass
    module.time.sleep = lambda _: None
    module.urllib.request.urlopen = lambda *args, **kwargs: io.BytesIO(b'tampered-wheel')
    try:
        module.verified_download({'url': 'https://files.pythonhosted.org/packages/test.whl', 'name': 'offline-test', 'file': 'test.whl', 'sha256': '0' * 64})
        raise AssertionError('invalid digest accepted')
    except ValueError:
        pass
    assert not (module.CACHE / 'test.whl').exists()
    cached = module.CACHE / 'valid.whl'
    cached.write_bytes(b'cached-test-only')
    module.urllib.request.urlopen = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('cached download went online'))
    assert module.verified_download({'url': 'https://files.pythonhosted.org/packages/valid.whl', 'file': cached.name, 'sha256': hashlib.sha256(cached.read_bytes()).hexdigest()}) == cached
    unsafe = root / 'unsafe.zip'
    with zipfile.ZipFile(unsafe, 'w') as archive:
        archive.writestr('../outside.py', 'bad')
    try:
        module.extract_wheel(unsafe, root / 'site')
        raise AssertionError('traversal accepted')
    except ValueError:
        pass
    assert not (root / 'outside.py').exists()
    good = root / 'good.zip'
    with zipfile.ZipFile(good, 'w') as archive:
        archive.writestr('synthetic_pkg/__init__.py', 'VALUE = 1')
    module.extract_wheel(good, root / 'site')
    assert (root / 'site/synthetic_pkg/__init__.py').read_text() == 'VALUE = 1'
print('PASS bootstrap: official HTTPS origin, tampered digest rejected, verified cache offline, traversal blocked, normal wheel extraction. No network/model calls.')
