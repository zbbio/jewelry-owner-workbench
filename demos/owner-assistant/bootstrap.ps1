param(
    [switch]$PrepareOnly,
    [switch]$NoBrowser,
    [switch]$Preview,
    [int]$BasePort = 4296
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = $PSScriptRoot
$cache = Join-Path $root '.setup'
$runtime = Join-Path $root 'runtime'

function Get-SHA256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Expand-VerifiedZip([string]$Archive, [string]$Destination) {
    [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
    $base = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $path = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $entry.FullName))
            if (-not $path.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe runtime archive path.' }
            if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($path) | Out-Null }
            else {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $true)
            }
        }
    } finally { $zip.Dispose() }
}

function Get-VerifiedFile([string]$Url, [string]$Sha, [string]$Destination) {
    if ((Test-Path -LiteralPath $Destination) -and ((Get-SHA256 $Destination) -eq $Sha)) { return }
    if ([Uri]$Url -notmatch '^https://') { throw 'Only HTTPS runtime downloads are accepted.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    $part = $Destination + '.partial'
    if ((Test-Path -LiteralPath $part) -and ((Get-SHA256 $part) -eq $Sha)) {
        Copy-Item -LiteralPath $part -Destination $Destination -Force
        Remove-Item -LiteralPath $part -Force
        return
    }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Write-Host ('Downloading verified runtime: ' + ([Uri]$Url).Host)
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $part -TimeoutSec 180
            if ((Get-SHA256 $part) -ne $Sha) { throw 'SHA256 mismatch. The downloaded file will not be executed.' }
            Copy-Item -LiteralPath $part -Destination $Destination -Force
            Remove-Item -LiteralPath $part -Force
            return
        } catch {
            if ($attempt -eq 3) { throw }
            Start-Sleep -Seconds 2
        }
    }
}

try {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -ne 'AMD64') { throw 'This one-click package supports Windows x64 only.' }
    $lock = Get-Content -LiteralPath (Join-Path $root 'runtime-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $node = Join-Path $runtime 'node\node.exe'
    $python = Join-Path $runtime 'python\python.exe'
    Get-VerifiedFile $lock.node.url $lock.node.sha256 $node
    Get-VerifiedFile $lock.node.licenseUrl $lock.node.licenseSHA256 (Join-Path $runtime 'node\LICENSE')
    if ((-not (Test-Path -LiteralPath $python)) -or ((Get-SHA256 $python) -ne $lock.python.exeSHA256)) {
        $archive = Join-Path $cache 'python-3.13.1-embed-amd64.zip'
        Get-VerifiedFile $lock.python.url $lock.python.sha256 $archive
        New-Item -ItemType Directory -Path (Join-Path $runtime 'python') -Force | Out-Null
        Expand-VerifiedZip $archive (Join-Path $runtime 'python')
        if ((Get-SHA256 $python) -ne $lock.python.exeSHA256) { throw 'Python executable hash mismatch.' }
    }
    $pth = "python313.zip`r`n.`r`nLib/site-packages`r`nimport site`r`n"
    [IO.File]::WriteAllText((Join-Path $runtime 'python\python313._pth'), $pth, (New-Object Text.UTF8Encoding($false)))
    & $python -I -B -X utf8 (Join-Path $root 'bootstrap.py')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency or demo-data preparation failed. See the message above; retry the same launcher after checking the network.' }
    if ($PrepareOnly) { exit 0 }
    $arguments = @('-I', '-B', '-X', 'utf8', (Join-Path $root 'launcher.py'), '--base-port', [string]$BasePort)
    if ($NoBrowser) { $arguments += '--no-browser' }
    if ($Preview) { $arguments += '--preview' }
    & $python @arguments
    exit $LASTEXITCODE
} catch {
    Write-Host ('SETUP ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'No global Python/Node installation or administrator change was made. Retry the same launcher to resume.'
    exit 1
}
