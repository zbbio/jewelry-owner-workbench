param([switch]$UsbAndroid,[string]$Serial,[ValidateRange(1024,65535)][int]$Port=4187,[string]$Shop='n3-device-trial')
$ErrorActionPreference='Stop'
if($Shop -notmatch '^[a-zA-Z0-9_-]{1,48}$'){throw '测试店编号仅限字母、数字、下划线、短横线。'}
$homeDir=Split-Path -Parent $MyInvocation.MyCommand.Path
$node=(Get-Command node -ErrorAction Stop).Source
$env:WORKBENCH_SHOP=$Shop
$env:WORKBENCH_DATA=Join-Path (Join-Path $env:LOCALAPPDATA 'JewelryOwnerWorkbenchPublic-Trials') $Shop
$env:WORKBENCH_REQUIRE_LOGIN='1'
$buf=New-Object byte[] 24
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
try {$rng.GetBytes($buf)} finally {$rng.Dispose()}
$env:WORKBENCH_PILOT_CODE=[Convert]::ToBase64String($buf)
$env:PORT=[string]$Port
$adb=$null;$attached=$false
try {
  if($UsbAndroid){
    $found=Get-Command adb -ErrorAction SilentlyContinue
    if($found){$adb=$found.Source}else{throw '缺少 Android Platform Tools / adb，请先准备官方 USB 调试工具。'}
    $devs=@(& $adb devices | Select-Object -Skip 1 | ForEach-Object {if($_ -match '^([^\s]+)\s+device\s*$'){$Matches[1]}})
    if(!$Serial){if($devs.Count -ne 1){throw '请连接且只授权一台测试 Android，或以 -Serial 选择。'};$Serial=$devs[0]}
    if($devs -notcontains $Serial){throw '选定的设备未连接或未授权。'}
    $lines=@(& $adb -s $Serial reverse --list)
    if(($lines -join "`n") -match ("tcp:"+$Port+"(?:\s|$)")){throw '该设备已有同端口映射，请选其他端口。'}
    & $adb -s $Serial reverse "tcp:$Port" "tcp:$Port" | Out-Null
    if($LASTEXITCODE -ne 0){throw 'USB 测试映射未建立。'}
    $attached=$true
  }
  Write-Host "试用地址 http://localhost:$Port/pilot  | 仅监听本机，不开放局域网。"
  Write-Host "临时店主口令（只在本窗口显示，不复制到聊天或工单）：$env:WORKBENCH_PILOT_CODE"
  if($attached){Write-Host '请在已连接测试手机浏览器输入上述地址。'}
  & $node (Join-Path $homeDir 'server.mjs')
} finally {
  if($attached){ & $adb -s $Serial reverse --remove "tcp:$Port" | Out-Null }
  Remove-Item Env:WORKBENCH_PILOT_CODE -ErrorAction SilentlyContinue
}
