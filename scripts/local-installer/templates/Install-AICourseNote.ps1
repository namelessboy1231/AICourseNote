$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$payloadAppDir = Join-Path $root 'payload\AICourseNote'
$appDir = Join-Path $root 'AICourseNote'
$dataDir = Join-Path $root 'data'
$configPath = Join-Path $appDir 'aicoursenote.local.json'

function Test-DirectoryHasContent([string]$dirPath) {
  if (-not (Test-Path -LiteralPath $dirPath)) {
    return $false
  }

  return $null -ne (Get-ChildItem -LiteralPath $dirPath -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
}

if (-not (Test-Path -LiteralPath $payloadAppDir)) {
  throw "Installer payload directory was not found: $payloadAppDir"
}

$running = Get-Process AICourseNote -ErrorAction SilentlyContinue
if ($running) {
  Write-Host 'Detected a running AICourseNote process. Stopping it before install.'
  $running | Stop-Process -Force
  Start-Sleep -Seconds 1
}

if (Test-Path -LiteralPath $appDir) {
  Remove-Item -LiteralPath $appDir -Recurse -Force
}

if (Test-DirectoryHasContent $dataDir) {
  Write-Host 'An existing AICourseNote data directory was found in this install location.'
  Write-Host 'K = keep existing data and reuse it'
  Write-Host 'R = remove existing data and perform a fresh install'
  Write-Host 'C = cancel install'

  $selection = (Read-Host 'Choose K, R, or C').Trim().ToUpperInvariant()

  switch ($selection) {
    'K' {
    }
    'R' {
      Remove-Item -LiteralPath $dataDir -Recurse -Force
    }
    default {
      throw 'Install cancelled by user.'
    }
  }
}

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

Get-ChildItem -LiteralPath $payloadAppDir -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $appDir -Recurse -Force
}

$config = @{
  mode = 'directory-local'
  dataDir = '../data'
} | ConvertTo-Json

[System.IO.File]::WriteAllText($configPath, $config, [System.Text.UTF8Encoding]::new($false))

$payloadRootDir = Join-Path $root 'payload'
if (Test-Path -LiteralPath $payloadRootDir) {
  Remove-Item -LiteralPath $payloadRootDir -Recurse -Force
}

Write-Host "Installed to: $appDir"
Write-Host "Data directory: $dataDir"
