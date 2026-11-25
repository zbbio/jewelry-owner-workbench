[CmdletBinding()]
param([switch]$Live, [switch]$Foreground)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$entry=Join-Path $root '服务.mjs'
$broker=Join-Path $root '安全启动.py'
$operator=Join-Path $root '配对管理.mjs'
$node=(Get-Command node -CommandType Application | Select-Object -First 1).Source
if($Live){ $exe=(Get-Command python -CommandType Application | Select-Object -First 1).Source; $argsList=@('-B',('"'+$broker+'"')) }
else { $exe=$node; $argsList=@(('"'+$entry+'"')) }
if($Foreground){
 if($Live){ & $exe -B $broker }else{ & $exe $entry }
 exit $LASTEXITCODE
}
$before=& $node $operator status
if($LASTEXITCODE -eq 0){ $before; Write-Error 'N14 已在监听。切换模式请先执行本仓 stop；不接管已运行实例。'; exit 2 }
$p=Start-Process -FilePath $exe -ArgumentList $argsList -WorkingDirectory $root -WindowStyle Hidden -PassThru
$expect=if($Live){'enabled_for_paired_questions'}else{'paused'}
for($i=0;$i -lt 38;$i++){
 Start-Sleep -Milliseconds 200
 $p.Refresh(); if($p.HasExited){Write-Error 'N14 启动进程已退出。先查本机 17864 是否占用，再以前台方式查看固定诊断码。'; exit 2}
 $latest=& $node $operator status
 if($LASTEXITCODE -eq 0){ $x=$latest|ConvertFrom-Json; if($x.model -eq $expect){$latest; exit 0} }
}
Write-Error 'N14 启动未验证。不要改 APK 端口；先查本机 17864 及凭据注入条件。'; exit 2
