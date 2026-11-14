# StreamSnag helper setup for Windows. Nothing else to install first, and no admin rights needed.
# Double-click "Set up StreamSnag helper.cmd" (one folder up), or run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 [-Id <extension id>] [-SkipFfmpeg]
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -Uninstall
#
# It copies the helper (with its own copy of Node.js, the official signed node.exe) into
#   %LOCALAPPDATA%\StreamSnag\Helper\<version>
# registers it with Chrome, Edge, Brave and Chromium for this user, offers to install ffmpeg with winget,
# and adds "StreamSnag helper" to Settings > Apps > Installed apps, where it can be removed.
# (Tests set STREAMSNAG_TEST_HOME and STREAMSNAG_TEST_REG_ROOT so a run never touches the real ones.)
param([switch]$Uninstall, [switch]$SkipFfmpeg, [string]$Id = '')

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $here 'package.json') | ConvertFrom-Json).version
$base = if ($env:STREAMSNAG_TEST_HOME) { $env:STREAMSNAG_TEST_HOME } else { Join-Path $env:LOCALAPPDATA 'StreamSnag\Helper' }
$regRoot = if ($env:STREAMSNAG_TEST_REG_ROOT -match '^[\w-]{1,64}$') { "HKCU:\Software\$($env:STREAMSNAG_TEST_REG_ROOT)" } else { 'HKCU:\Software\Microsoft\Windows\CurrentVersion' }
$appKey = "$regRoot\Uninstall\StreamSnagHelper"

function Have($command) { return [bool](Get-Command $command -ErrorAction SilentlyContinue) }

# A file's SHA-256, through .NET: Get-FileHash goes missing when this script is started from PowerShell 7
# (its module path does not suit Windows PowerShell; seen on GitHub's Windows runner, 2026-11-12).
function HashOf($file) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($file)
  try { return [System.BitConverter]::ToString($sha.ComputeHash($stream)) } finally { $stream.Dispose(); $sha.Dispose() }
}

function Ask($question) {
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes)$')
}

function HaveFfmpeg {
  if (Have 'ffmpeg') { return $true }
  $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet'
  if (Test-Path -LiteralPath (Join-Path $winget 'Links\ffmpeg.exe')) { return $true }
  return [bool](Get-ChildItem -LiteralPath (Join-Path $winget 'Packages') -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host "StreamSnag helper $version" -ForegroundColor Cyan
Write-Host '-----------------------'

# ------------------------------------------------------------------ remove
if ($Uninstall) {
  Set-Location -LiteralPath ([IO.Path]::GetTempPath()) # (a folder that is in use cannot be removed)
  $nodeHere = Join-Path $here 'node.exe'
  if (Test-Path -LiteralPath $nodeHere) { & $nodeHere (Join-Path $here 'install.js') --uninstall }
  # Windows (or a virus scanner) can hold node.exe for a moment after it exits, and a running helper holds
  # it for as long as the browser keeps it open (seen on GitHub's Windows runner, 2026-11-13). So node.exe
  # goes first, tried for a few seconds; while one stays held, nothing else is removed, so this script and
  # the Installed apps entry are still there to remove it again.
  $held = { @(Get-ChildItem -LiteralPath $base -Recurse -File -Filter 'node.exe' -ErrorAction SilentlyContinue) }
  for ($try = 0; ($try -lt 20) -and (& $held).Count; $try++) {
    if ($try) { Start-Sleep -Milliseconds 300 }
    & $held | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  }
  if ((& $held).Count) {
    Write-Host 'The browsers no longer use the helper, but it is still running.' -ForegroundColor Yellow
    Write-Host 'Close your browser, then remove StreamSnag helper again (Settings > Apps > Installed apps).' -ForegroundColor Yellow
    exit 1
  }
  Remove-Item -LiteralPath $appKey -Recurse -Force -ErrorAction SilentlyContinue
  # The helper's own data goes too: %LOCALAPPDATA%\StreamSnag holds the transcription models (hundreds of MB),
  # the desk's covers, a few caches and the list of folders the user let StreamSnag read (a fresh computer
  # check found it left behind, 2026-11-13). The helper's folder is inside it. (Tests name their own.)
  $data = if ($env:STREAMSNAG_TEST_HOME) { $env:STREAMSNAG_TEST_DATA } else { Join-Path $env:LOCALAPPDATA 'StreamSnag' }
  $gone = @($base, $data) | Where-Object { $_ }
  $left = { @($gone | Where-Object { Test-Path -LiteralPath $_ }) }
  for ($try = 0; ($try -lt 20) -and (& $left).Count; $try++) {
    if ($try) { Start-Sleep -Milliseconds 300 }
    & $left | ForEach-Object { Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ((& $left).Count) {
    Write-Host 'The browsers no longer use the helper, but a few of its files are still open.' -ForegroundColor Yellow
    Write-Host 'Close any window showing its folder, then delete this folder:' -ForegroundColor Yellow
    Write-Host "  $((& $left)[-1])"
    exit 1
  }
  Write-Host 'StreamSnag helper removed.' -ForegroundColor Green
  exit 0
}

# ------------------------------------------------------------------ 1. copy it into place
$dest = Join-Path $base $version
New-Item -ItemType Directory -Force -Path $dest | Out-Null
if ((Resolve-Path -LiteralPath $here).Path -ne (Resolve-Path -LiteralPath $dest).Path) {
  foreach ($file in Get-ChildItem -LiteralPath $here -File) {
    $target = Join-Path $dest $file.Name
    # (The same file already there is left as it is: node.exe cannot be replaced while a browser runs it.)
    if ((Test-Path -LiteralPath $target) -and (HashOf $target) -eq (HashOf $file.FullName)) { continue }
    try {
      Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    } catch {
      Write-Host "Could not copy $($file.Name). Close your browser (it may be using the helper) and run this again." -ForegroundColor Red
      exit 1
    }
  }
}
# Files from a downloaded zip carry Windows' "came from the internet" mark; the copies the browsers start do not need it.
Get-ChildItem -LiteralPath $dest -File | Unblock-File
Write-Host "Helper copied to $dest" -ForegroundColor Green

# ------------------------------------------------------------------ 2. ffmpeg (one finished MP4 from a video's picture and sound)
if (HaveFfmpeg) {
  Write-Host 'ffmpeg found.' -ForegroundColor Green
} elseif (-not $SkipFfmpeg -and (Have 'winget') -and (Ask 'Install ffmpeg (free; joins a video''s picture and sound into one MP4)?')) {
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
} else {
  Write-Host 'Skipped ffmpeg. You can install it later: winget install Gyan.FFmpeg' -ForegroundColor DarkGray
}
# A package may bring more to offer (extras.ps1 beside this script); the same switches apply.
$extras = Join-Path $here 'extras.ps1'
if (Test-Path -LiteralPath $extras) { . $extras }

# ------------------------------------------------------------------ 3. register it with the browsers
$node = Join-Path $dest 'node.exe'
$install = Join-Path $dest 'install.js'
# A package made for an extension whose id is known says it in id.txt (otherwise install.js knows it, or asks).
$idFile = Join-Path $dest 'id.txt'
if (-not $Id -and (Test-Path -LiteralPath $idFile)) { $Id = (Get-Content -Raw -LiteralPath $idFile).Trim() }
if (-not $Id) {
  # A copy made before the extension had its store id asks for it, before trying (install.js says by its exit
  # code alone whether it knows one: 3 = it doesn't).
  & $node $install --needs-id
  if ($LASTEXITCODE -eq 3) {
    Write-Host 'StreamSnag shows its ID in Settings > Local helper.' -ForegroundColor Yellow
    $answer = $null
    try { $answer = Read-Host 'Paste the ID here' } catch { }
    $Id = "$answer".Trim()
    if (-not $Id) {
      Write-Host 'No ID was given, so nothing was set up. Run setup again and paste the ID when it asks.' -ForegroundColor Red
      exit 1
    }
  }
}
$idArgs = @()
if ($Id) { $idArgs = @('--id', $Id) }
& $node $install @idArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ------------------------------------------------------------------ 4. an entry in Installed apps, and older copies removed
New-Item -Path $appKey -Force | Out-Null
$size = [int]((Get-ChildItem -LiteralPath $dest -File | Measure-Object -Property Length -Sum).Sum / 1KB)
$values = @{
  DisplayName = 'StreamSnag helper'; DisplayVersion = $version; Publisher = 'StreamSnag'; InstallLocation = $dest
  UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $dest 'setup.ps1')`" -Uninstall"
}
foreach ($k in $values.Keys) { Set-ItemProperty -LiteralPath $appKey -Name $k -Value $values[$k] }
foreach ($k in @('NoModify', 'NoRepair')) { Set-ItemProperty -LiteralPath $appKey -Name $k -Value 1 -Type DWord }
Set-ItemProperty -LiteralPath $appKey -Name 'EstimatedSize' -Value $size -Type DWord
Get-ChildItem -LiteralPath $base -Directory | Where-Object { $_.Name -ne $version } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host 'Done. Restart your browser, then in StreamSnag open Settings > Local helper and press Check helper.' -ForegroundColor Cyan
