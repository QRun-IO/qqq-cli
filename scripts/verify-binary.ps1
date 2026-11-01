# Copyright 2026 QRun.IO, Inc.
# Licensed under the Apache License, Version 2.0 (see LICENSE).
#
# Smoke test of one qqq binary on Windows (PowerShell 5.1 or 7): the same steps as verify-binary.sh.
#
#   pwsh scripts/verify-binary.ps1 -Binary dist\qqq-windows-x64.exe
#   pwsh scripts/verify-binary.ps1 -Binary dist\qqq-windows-x64.exe -Server http://localhost:8077
#
# -Server     also sign in (MOCK and anonymous servers) and run whoami, a query and a process run
# -ProfileName use this existing profile instead of a temporary one
# -Keyring    'file' (default: a temporary config directory) or 'os' (DPAPI, removed again at the end)
# -CliOnly    the binary is a CLI-only build: do not expect "with ui" or run ui --check
# Environment: QQQ_VERIFY_TABLE (person), QQQ_VERIFY_PROCESS (sleepInteractive),
# QQQ_VERIFY_VALUES (sleepMillis=500). Exit 0 when every step passed.

param(
  [Parameter(Mandatory = $true)][string]$Binary,
  [string]$Server = '',
  [string]$ProfileName = '',
  [ValidateSet('file', 'os')][string]$Keyring = 'file',
  [switch]$CliOnly
)

$ErrorActionPreference = 'Continue'
$table = if ($env:QQQ_VERIFY_TABLE) { $env:QQQ_VERIFY_TABLE } else { 'person' }
$processName = if ($env:QQQ_VERIFY_PROCESS) { $env:QQQ_VERIFY_PROCESS } else { 'sleepInteractive' }
$values = if ($env:QQQ_VERIFY_VALUES) { $env:QQQ_VERIFY_VALUES } else { 'sleepMillis=500' }

$temporary = $false
if (-not $ProfileName) {
  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("qqq-verify-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  $env:QQQ_CONFIG_DIR = Join-Path $work 'config'
  $env:QQQ_CACHE_DIR = Join-Path $work 'cache'
  if ($Keyring -eq 'file') { $env:QQQ_KEYRING = 'file' }
  $ProfileName = "verify-$PID"
  $temporary = $true
}
$env:QQQ_OUTPUT = 'json'

$failed = New-Object System.Collections.Generic.List[string]

function Step([string]$Name, [string]$Want, [string[]]$Arguments) {
  $out = (& $Binary @Arguments 2>&1 | Out-String)
  $code = $LASTEXITCODE
  if ($code -eq 0 -and $out -match $Want) {
    Write-Output "ok    $Name"
  } else {
    $short = if ($out.Length -gt 400) { $out.Substring(0, 400) } else { $out }
    Write-Output "FAIL  ${Name}: exit $code; $short"
    $failed.Add($Name)
  }
}

Step 'version' '(?m)^qqq \d+\.\d+\.\d+' @('--version')
if (-not $CliOnly) { Step 'version says with ui' 'binary with ui' @('--version') }
Step 'completion candidates' '(?m)^table\s*$' @('__complete', '--', 'ta')
foreach ($shell in 'bash', 'zsh', 'fish', 'pwsh') { Step "completion $shell" 'qqq' @('completion', $shell) }
if (-not $CliOnly) {
  Step 'ui --check names the build' 'binary with ui.*runtime \(embedded\)' @('ui', '--check')
} else {
  $out = (& $Binary ui 2>&1 | Out-String)
  if ($out -match 'not part of this installation') { Write-Output 'ok    ui says how to get the UI' } else { Write-Output "FAIL  ui says how to get the UI: $out"; $failed.Add('ui message') }
}

if ($Server) {
  if ($temporary) { Step 'login (session)' 'Signed in' @('login', '--server', $Server, '--profile', $ProfileName) }
  Step 'doctor build line' '"build": "qqq ' @('--profile', $ProfileName, 'doctor')
  Step 'whoami' '"apiVersion"' @('--profile', $ProfileName, 'whoami')
  Step "table query $table" '"values"' @('--profile', $ProfileName, 'table', 'query', $table, '-l', '2')
  $runArgs = @('--profile', $ProfileName, 'process', 'run', $processName)
  foreach ($pair in $values.Split(',')) { $runArgs += @('-v', $pair) }
  Step "process run $processName" '"type": "COMPLETE"' $runArgs
  if ($temporary) {
    Step 'logout' 'Signed out' @('--profile', $ProfileName, 'logout')
    & $Binary config profile remove $ProfileName *> $null
  }
}
if ($temporary) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }

if ($failed.Count -gt 0) {
  Write-Output "verify-binary: $($failed.Count) failed: $($failed -join ', ')"
  exit 1
}
Write-Output 'verify-binary: ok'
