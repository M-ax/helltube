param([switch]$BuildOnly, [switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework 4 compiler is required.' }
if (!(Test-Path -LiteralPath (Join-Path $project 'node_modules\playwright\package.json'))) { throw 'Run npm install in the Helltube checkout first.' }
$build = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$executable = Join-Path $build 'HelltubeCookieHelper.exe'
$source = Join-Path $PSScriptRoot 'TrayApp.cs'
if (!(Test-Path -LiteralPath $executable) -or (Get-Item -LiteralPath $source).LastWriteTimeUtc -gt (Get-Item -LiteralPath $executable).LastWriteTimeUtc) {
    & $compiler /nologo /target:winexe /optimize+ "/out:$executable" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $source
    if ($LASTEXITCODE -ne 0) { throw 'Cookie Helper build failed.' }
}
$worker = Join-Path $PSScriptRoot 'worker.mjs'
$launch = @{ node = $node; worker = $worker } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $build 'launcher.json'), $launch)
if ($BuildOnly) { Write-Output $executable; exit 0 }
$arguments = @('--node', ('"' + $node + '"'), '--worker', ('"' + $worker + '"'))
if ($SmokeTest) {
    $smokeDirectory = Join-Path $project ('test-artifacts\cookie-helper-smoke-' + [guid]::NewGuid().ToString('N'))
    # Exercise the same launcher.json lookup used by Windows startup.
    $arguments = @('--smoke-test', '--data', ('"' + $smokeDirectory + '"'))
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    Write-Output $smokeDirectory
    exit $process.ExitCode
}
Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden
