import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The same test logic can be run against a byte-preserved, trusted baseline/candidate file.
const launcherName = '启动隔离手机试用.ps1';
const source = process.env.N16_LAUNCHER_SOURCE || fileURLToPath(new URL('../启动隔离手机试用.ps1', import.meta.url));
const port = '16487', shop = 'ps-launcher-ci';
const headers = ['-NoLogo', '-NoProfile', '-NonInteractive'];
const engines = [
  { label: 'Windows PowerShell 5.1', command: process.env.N16_POWERSHELL51_EXE || 'powershell.exe', major: 5, minor: 1, edition: 'Desktop' },
  { label: 'PowerShell 7', command: process.env.N16_PWSH7_EXE || 'pwsh.exe', major: 7, edition: 'Core' },
];

const probeVersion = [
  '$p=$PSVersionTable.PSVersion',
  '$o=[pscustomobject]@{major=$p.Major;minor=$p.Minor;edition=$PSVersionTable.PSEdition;exe=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName}',
  'Write-Output ("N16_INFO:"+($o|ConvertTo-Json -Compress))',
].join(';');

function lineWith(result, marker) {
  return result.stdout?.split(/\r?\n/u).find(line => line.startsWith(marker))?.slice(marker.length);
}

const scratchPrefix = 'N16 中文 路径 ';
function chooseParent() {
  const explicit = process.env.N16_SCRATCH_ROOT;
  const options = explicit ? [explicit] : [tmpdir(), process.env.LOCALAPPDATA, homedir()];
  for (const x of options) {
    if (!x || !isAbsolute(x)) continue;
    try { const root = realpathSync(x); if (statSync(root).isDirectory()) return root; } catch { /* next candidate */ }
  }
  throw new Error('N16_SCRATCH_ROOT must be an existing writable directory');
}

function tempEnv(dir) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:TEMP|TMP|TMPDIR|NODE_TMP|PYTHONPYCACHEPREFIX)$/iu.test(k)));
  return { ...e, TEMP: dir, TMP: dir, TMPDIR: dir, NODE_TMP: dir, PYTHONPYCACHEPREFIX: join(dir, 'pycache') };
}

function removeOwnedTree(root, dir) {
  const location = relative(root, realpathSync(dir));
  assert.ok(location !== '..' && !location.startsWith('..' + sep) && !isAbsolute(location), 'cleanup path escaped its owned directory');
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), child = lstatSync(path);
    if (child.isDirectory() && !child.isSymbolicLink()) removeOwnedTree(root, path);
    else unlinkSync(path); // Never follow a symlink/reparse-point target.
  }
  rmdirSync(dir);
}

function probe(spec) {
  if (process.platform !== 'win32') return { skip: 'requires Windows (tests real PowerShell -File with Windows command stubs)' };
  let env;
  try { env = tempEnv(chooseParent()); } catch { return { problem: 'invalid scratch parent' }; }
  const r = spawnSync(spec.command, [...headers, '-Command', probeVersion], { env, encoding: 'utf8', windowsHide: true, timeout: 12000 });
  if (r.error?.code === 'ENOENT') return { skip: `${spec.label} executable not installed` };
  if (r.error || r.status !== 0) return { problem: `${spec.label} version probe failed (${r.error?.code || r.status || r.signal})` };
  const json = lineWith(r, 'N16_INFO:');
  if (!json) return { problem: `${spec.label} did not produce its version marker` };
  let c;
  try { c = JSON.parse(json); } catch { return { problem: 'invalid version probe marker' }; }
  if (c.major !== spec.major || (spec.minor !== undefined && c.minor !== spec.minor) || (c.edition && c.edition !== spec.edition)) {
    return { skip: `${spec.label} unavailable (located ${c.major}.${c.minor} ${c.edition || ''})` };
  }
  // Use the exact executable that answered, not PATH in the isolated child.
  if (typeof c.exe !== 'string' || !isAbsolute(c.exe)) return { problem: 'missing absolute PowerShell executable' };
  return { exe: c.exe, version: `${c.major}.${c.minor}` };
}

const parser = String.raw`param([string]$Target)
$ErrorActionPreference='Stop'
$tokens=$null;$errs=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Target,[ref]$tokens,[ref]$errs)
$rows=@($errs | ForEach-Object { [pscustomobject]@{id=$_.ErrorId;line=$_.Extent.StartLineNumber;column=$_.Extent.StartColumnNumber} })
$s=$ast.Extent.Text.Replace(([string][char]13+[char]10),[string][char]10).Trim()
$sha=[Security.Cryptography.SHA256]::Create()
try{$hex=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))).Replace('-','').ToLowerInvariant()} finally{$sha.Dispose()}
$o=[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();errors=$rows;decodedSha256=$hex}
Write-Output ('N16_PARSE:' + ($o|ConvertTo-Json -Depth 4 -Compress))
if($rows.Count){exit 22}
`;

const nodeStub = String.raw`@echo off
if /I not "%~1"=="%N16_EXPECT_SERVER%" goto bad
if not "%~2"=="" goto bad
if not exist "%~1" goto bad
if not "%WORKBENCH_REQUIRE_LOGIN%"=="1" goto bad
if not "%WORKBENCH_SHOP%"=="%N16_EXPECT_SHOP%" goto bad
if not "%PORT%"=="%N16_EXPECT_PORT%" goto bad
if /I not "%WORKBENCH_DATA%"=="%N16_EXPECT_DATA%" goto bad
if not defined WORKBENCH_PILOT_CODE goto bad
>>"%N16_JOURNAL%" echo node-start
exit /b 0
:bad
>>"%N16_JOURNAL%" echo node-bad-args-or-env
exit /b 81
`;

const adbStub = String.raw`@echo off
if "%~1"=="devices" goto devices
if not "%~1"=="-s" goto bad
if not "%~2"=="n16-stub-device" goto bad
if not "%~3"=="reverse" goto bad
if "%~4"=="--list" goto list
if "%~4"=="--remove" goto remove
if not "%~4"=="tcp:%N16_EXPECT_PORT%" goto bad
if not "%~5"=="tcp:%N16_EXPECT_PORT%" goto bad
if not "%~6"=="" goto bad
>>"%N16_JOURNAL%" echo adb-map
exit /b 0
:devices
if not "%~2"=="" goto bad
>>"%N16_JOURNAL%" echo adb-devices
echo List of devices attached
echo n16-stub-device device
exit /b 0
:list
if not "%~5"=="" goto bad
>>"%N16_JOURNAL%" echo adb-reverse-list
if "%N16_ADB_CASE%"=="mapped" echo n16-stub-device tcp:%N16_EXPECT_PORT% tcp:%N16_EXPECT_PORT%
exit /b 0
:remove
if not "%~5"=="tcp:%N16_EXPECT_PORT%" goto bad
if not "%~6"=="" goto bad
>>"%N16_JOURNAL%" echo adb-remove
exit /b 0
:bad
>>"%N16_JOURNAL%" echo adb-unexpected
exit /b 82
`;

function isolated(t) {
  const parent = chooseParent(), created = mkdtempSync(join(parent, scratchPrefix));
  const dir = realpathSync(created), childName = relative(parent, dir), first = lstatSync(created);
  assert.ok(first.isDirectory() && !first.isSymbolicLink() && childName === basename(dir) && childName.startsWith(scratchPrefix),
    'created scratch path is not a direct owned child of the selected parent');
  t.after(() => {
    const actual = realpathSync(created), sub = relative(parent, actual), current = lstatSync(created);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === first.dev && current.ino === first.ino &&
      actual === dir && sub === childName && sub === basename(actual) && sub.startsWith(scratchPrefix),
    'refusing cleanup: scratch identity or containment changed');
    removeOwnedTree(dir, actual);
  });
  assert.match(dir, /中文/u);
  assert.match(dir, / /u);
  const target = join(dir, launcherName), harness = join(dir, 'parser.ps1'), bin = join(dir, 'stubs'),
    app = join(dir, 'app data'), server = join(dir, 'server.mjs'), journal = join(dir, 'events.txt');
  mkdirSync(bin); mkdirSync(app);
  const bytes = readFileSync(source);
  writeFileSync(target, bytes); // Keep BOM (or absence) exactly as it was in the selected source.
  writeFileSync(harness, parser, 'ascii');
  writeFileSync(join(bin, 'node.cmd'), nodeStub.replace(/\n/gu, '\r\n'), 'ascii');
  writeFileSync(join(bin, 'adb.cmd'), adbStub.replace(/\n/gu, '\r\n'), 'ascii');
  writeFileSync(server, 'throw new Error("test server file must not be executed");\n', 'ascii');
  const env = {};
  for (const [k, v] of Object.entries(tempEnv(dir))) {
    if (!/^(?:PATH|PATHEXT|COMSPEC|LOCALAPPDATA|APPDATA|USERPROFILE|HOME|PORT|WORKBENCH_.*|ADB_.*|ANDROID_.*)$/iu.test(k)) env[k] = v;
  }
  const windows = process.env.SystemRoot || process.env.windir;
  assert.ok(windows && isAbsolute(windows), 'cannot resolve system command interpreter');
  Object.assign(env, { Path: bin, PATHEXT: '.CMD', ComSpec: join(windows, 'System32', 'cmd.exe'),
    LOCALAPPDATA: app, APPDATA: app, USERPROFILE: app, HOME: app,
    N16_EXPECT_SERVER: server, N16_EXPECT_SHOP: shop, N16_EXPECT_PORT: port, N16_JOURNAL: journal,
    N16_EXPECT_DATA: join(app, 'JewelryOwnerWorkbenchPublic-Trials', shop) });
  return { dir, target, harness, env, events() { return existsSync(journal) ? readFileSync(journal, 'ascii').trim().split(/\r?\n/u) : []; } };
}

function safeResult(raw, parserOutput = false) {
  // Do not let arbitrary process output (including trial-code lines) leave this boundary.
  return { status: raw.status, ...(parserOutput ? { parser: lineWith(raw, 'N16_PARSE:') } : {}) };
}

function runFile(engine, f, script, args = [], options = {}) {
  const r = spawnSync(engine.exe, [...headers, '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { cwd: f.dir, env: { ...f.env, ...options }, encoding: 'utf8', windowsHide: true, timeout: 18000, maxBuffer: 262144 });
  // Never put the child's raw stdout/stderr in a diagnostic: the launcher prints a throwaway pilot code.
  assert.ifError(r.error ? new Error(`PowerShell start failed (${r.error.code || 'spawn'})`) : null);
  assert.equal(r.signal, null);
  return safeResult(r, script === f.harness);
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
function requirePortableScriptBytes(bytes) {
  if (bytes.every(b => b < 0x80)) return 'ascii';
  assert.ok(bytes.subarray(0, 3).equals(utf8Bom), 'non-ASCII Windows PowerShell launcher requires UTF-8 BOM');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)); }
  catch { assert.fail('Windows PowerShell launcher has invalid UTF-8 after BOM'); }
  return 'utf8-bom';
}

test('启动脚本原始字节：ASCII 或 BOM 后严格 UTF-8（所有平台）', () => {
  assert.equal(requirePortableScriptBytes(Buffer.from('# ASCII script\r\n')), 'ascii');
  const chinese = Buffer.from('# 中文路径\n', 'utf8');
  assert.equal(requirePortableScriptBytes(Buffer.concat([utf8Bom, chinese])), 'utf8-bom');
  assert.throws(() => requirePortableScriptBytes(chinese), /requires UTF-8 BOM/u);
  assert.throws(() => requirePortableScriptBytes(Buffer.concat([utf8Bom, Buffer.from([0xc3, 0x28])])), /invalid UTF-8 after BOM/u);
  requirePortableScriptBytes(readFileSync(source));
});

for (const spec of engines) {
  const engine = probe(spec);
  const guarded = (label, fn) => test(`${spec.label}: ${label}`, { skip: engine.skip }, t => {
    assert.ok(!engine.problem, engine.problem);
    return fn(t);
  });
  guarded('真实 ParseFile 识别原文件字节', t => {
    const f = isolated(t), r = runFile(engine, f, f.harness, ['-Target', f.target]);
    const fake = 'N16-SYNTHETIC-SECRET-DISCARD';
    assert.equal(JSON.stringify(safeResult({ status: 0, stdout: `pilot:${fake}`, stderr: fake })).includes(fake), false);
    const text = r.parser;
    assert.ok(text, 'ParseFile helper did not produce a marker');
    const row = JSON.parse(text);
    assert.ok(row.version.startsWith(`${engine.version}.`) || row.version === engine.version);
    assert.deepEqual(row.errors, []); assert.equal(r.status, 0);
    const expected = readFileSync(f.target, 'utf8').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').trim();
    assert.equal(row.decodedSha256, createHash('sha256').update(expected).digest('hex'), 'parser must decode the source text, not just accept mojibake');
  });
  guarded('-File 从中文空格目录启动，无 USB 调用', t => {
    const f = isolated(t), r = runFile(engine, f, f.target, ['-Port', port, '-Shop', shop]);
    assert.deepEqual(f.events(), ['node-start']); assert.equal(r.status, 0);
  });
  guarded('-File USB 桩进入设备门，定向建立与回收', t => {
    const f = isolated(t), r = runFile(engine, f, f.target, ['-UsbAndroid', '-Port', port, '-Shop', shop]);
    assert.deepEqual(f.events(), ['adb-devices', 'adb-reverse-list', 'adb-map', 'node-start', 'adb-remove']); assert.equal(r.status, 0);
  });
  guarded('-File USB 门检测已有映射并拒绝，不启动', t => {
    const f = isolated(t), r = runFile(engine, f, f.target, ['-UsbAndroid', '-Serial', 'n16-stub-device', '-Port', port, '-Shop', shop], { N16_ADB_CASE: 'mapped' });
    assert.deepEqual(f.events(), ['adb-devices', 'adb-reverse-list']); assert.notEqual(r.status, 0);
  });
}
