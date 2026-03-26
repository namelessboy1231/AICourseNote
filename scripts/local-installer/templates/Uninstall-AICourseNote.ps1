param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework

$root = $PSScriptRoot
$appDir = Join-Path $root 'AICourseNote'
$appExe = Join-Path $appDir 'AICourseNote.exe'
$dataDir = Join-Path $root 'data'
$payloadDir = Join-Path $root 'payload'
$installCmd = Join-Path $root 'Install-AICourseNote.cmd'
$installPs1 = Join-Path $root 'Install-AICourseNote.ps1'
$uninstallCmd = Join-Path $root 'Uninstall-AICourseNote.cmd'
$uninstallPs1 = Join-Path $root 'Uninstall-AICourseNote.ps1'

if (-not $Force) {
  $confirmation = [System.Windows.MessageBox]::Show(
    'This will permanently remove AICourseNote, its runtime files, local data, and saved API keys. Continue?',
    'Uninstall AICourseNote',
    [System.Windows.MessageBoxButton]::YesNo,
    [System.Windows.MessageBoxImage]::Warning
  )

  if ($confirmation -ne [System.Windows.MessageBoxResult]::Yes) {
    Write-Host 'Uninstall cancelled.'
    exit 1
  }
}

$running = Get-Process AICourseNote -ErrorAction SilentlyContinue
if ($running) {
  $running | Stop-Process -Force
  Start-Sleep -Seconds 1
}

if (Test-Path -LiteralPath $appExe) {
  & $appExe --maintenance-task=clear-secure-store | Out-Null
}

$currentPid = $PID
$cleanupScript = Join-Path $env:TEMP ("aicoursenote-cleanup-" + [Guid]::NewGuid().ToString() + '.ps1')
$cleanupTargets = @(
  $appDir,
  $dataDir,
  $payloadDir,
  $installCmd,
  $installPs1,
  $uninstallCmd,
  $uninstallPs1
)

$serializedTargetsJson = ($cleanupTargets | ConvertTo-Json -Compress).Replace("'", "''")
$cleanupContent = @'
param([int]$ParentPid)

Start-Sleep -Seconds 2
try {
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
} catch {
}

$targets = ConvertFrom-Json -InputObject '__TARGETS_JSON__'

foreach ($target in $targets) {
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Remove-Item -LiteralPath '__SELF__' -Force -ErrorAction SilentlyContinue
'@

$cleanupContent = $cleanupContent.Replace('__TARGETS_JSON__', $serializedTargetsJson).Replace('__SELF__', $cleanupScript.Replace("'", "''"))

Set-Content -LiteralPath $cleanupScript -Value $cleanupContent -Encoding UTF8

Start-Process -FilePath 'powershell' -WindowStyle Hidden -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $cleanupScript,
  '-ParentPid',
  $currentPid
) | Out-Null

Write-Host 'Uninstall cleanup has been scheduled. Close this window to let cleanup finish.'
exit 0
