param([string]$ToolchainRoot = (Join-Path $env:LOCALAPPDATA 'CodexToolchains\AndroidN14'))
$ErrorActionPreference='Stop'
$classes=Join-Path $PSScriptRoot 'build\policy-tests'
New-Item -ItemType Directory -Path $classes -Force|Out-Null
$policy=Join-Path $PSScriptRoot 'src\java\com\zbbio\jewelryassistant\n14\AlbumPickerPolicy.java'
$test=Join-Path $PSScriptRoot 'tests\AlbumPickerPolicyTest.java'
& (Join-Path $ToolchainRoot 'jdk\bin\javac.exe') -encoding UTF-8 --release 8 -d $classes $policy $test
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& (Join-Path $ToolchainRoot 'jdk\bin\java.exe') -cp $classes com.zbbio.jewelryassistant.n14.AlbumPickerPolicyTest
exit $LASTEXITCODE
