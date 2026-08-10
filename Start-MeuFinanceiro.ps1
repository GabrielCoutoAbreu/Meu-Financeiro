$ErrorActionPreference = 'Stop'
$Port = 8765
$Url = "http://localhost:$Port/"
$Root = Join-Path (Split-Path -Parent $PSScriptRoot) 'app'
$ServerScript = Join-Path $PSScriptRoot 'server.ps1'

$running = $false
try {
  $client = [System.Net.Sockets.TcpClient]::new()
  $task = $client.ConnectAsync('127.0.0.1', $Port)
  $running = $task.Wait(250) -and $client.Connected
  $client.Dispose()
} catch {}

if (-not $running) {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$ServerScript`"",
    '-Port', $Port,
    '-Root', "`"$Root`""
  ) | Out-Null
  Start-Sleep -Milliseconds 700
}

$edgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
  Start-Process $edge -ArgumentList @("--app=$Url", '--start-maximized')
} else {
  Start-Process $Url
}
