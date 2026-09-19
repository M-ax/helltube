param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$metal = Get-Content -LiteralPath (Join-Path $project '.secrets/metal-credentials.json') -Raw | ConvertFrom-Json
$stateFile = Join-Path $project '.secrets/spotify-vm-tunnel.pid'
$existing = if (Test-Path -LiteralPath $stateFile) { Get-Process -Id ([int](Get-Content -LiteralPath $stateFile)) -ErrorAction SilentlyContinue }
$ownedPorts = if ($existing -and $existing.ProcessName -eq 'ssh') {
    @(Get-NetTCPConnection -LocalPort 6081,22022 -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $existing.Id })
}
if (!$existing -or $existing.ProcessName -ne 'ssh' -or $ownedPorts.Count -ne 2) {
    $arguments = @('-N', '-T', '-i', ('"' + $metal.identityFile + '"'), '-p', $metal.port,
        '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3', '-L', '127.0.0.1:6081:127.0.0.1:6081',
        '-L', '127.0.0.1:22022:127.0.0.1:22022', "$($metal.username)@$($metal.host)")
    $tunnel = Start-Process -FilePath (Get-Command ssh).Source -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardError (Join-Path $project '.secrets/spotify-vm-tunnel.log')
    $tunnel.Id | Set-Content -LiteralPath $stateFile
    Start-Sleep -Seconds 2
    if ($tunnel.HasExited) { throw 'SSH tunnel failed. Check .secrets/spotify-vm-tunnel.log; ports 6081 and 22022 must be available.' }
}
$consoleUrl = 'http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale'
Write-Output "Spotify desktop: $consoleUrl"
if (!$NoBrowser) { Start-Process $consoleUrl }
