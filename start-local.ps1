param([ValidateRange(1,65535)][int]$Port=8080,[string]$ListenAddress='127.0.0.1')
$ErrorActionPreference='Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 18+ first.' }
$oldPort=$env:PORT
$oldAddress=$env:HOST
try {
  $env:PORT=[string]$Port
  $env:HOST=$ListenAddress
  & node (Join-Path $PSScriptRoot 'server.js')
  if ($LASTEXITCODE -ne 0) { throw 'Server failed to start.' }
} finally { $env:PORT=$oldPort; $env:HOST=$oldAddress }
