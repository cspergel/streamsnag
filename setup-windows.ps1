# StreamSnag: one-step setup of the optional local helper on Windows.
# Run from the StreamSnag folder:  powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
# It checks for Node.js, offers to install ffmpeg and yt-dlp with winget, and registers the helper with
# Chrome, Edge, Brave and Chromium for your user account (no admin rights needed).

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Ask($question) {
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes)$')
}

function Have($command) {
  return [bool](Get-Command $command -ErrorAction SilentlyContinue)
}

$winget = Have 'winget'

Write-Host ''
Write-Host 'StreamSnag helper setup' -ForegroundColor Cyan
Write-Host '-----------------------'

# 1. Node.js runs the helper.
if (-not (Have 'node')) {
  Write-Host 'Node.js is needed to run the helper and was not found.' -ForegroundColor Yellow
  if ($winget -and (Ask 'Install Node.js LTS with winget now?')) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Have 'node')) {
    Write-Host 'Install Node.js 18 or newer from https://nodejs.org, then run this script again.' -ForegroundColor Red
    exit 1
  }
}
Write-Host ("Node.js " + (node --version) + " found.") -ForegroundColor Green

# 2. ffmpeg (merging video + audio, subtitles) and yt-dlp (playlists, sites the browser can't handle).
foreach ($tool in @(@{ Name = 'ffmpeg'; Id = 'Gyan.FFmpeg'; Why = 'merges video, audio and subtitles into one MP4' },
                    @{ Name = 'yt-dlp'; Id = 'yt-dlp.yt-dlp'; Why = 'lists playlists and downloads from 1000+ sites' })) {
  if (Have $tool.Name) {
    Write-Host "$($tool.Name) found." -ForegroundColor Green
  } elseif ($winget -and (Ask "Install $($tool.Name) ($($tool.Why))?")) {
    winget install --id $tool.Id -e --accept-source-agreements --accept-package-agreements
  } else {
    Write-Host "Skipped $($tool.Name). You can install it later: winget install $($tool.Id)" -ForegroundColor DarkGray
  }
}

# 3. Optional: AI through your Claude subscription.
if (-not (Have 'claude')) {
  Write-Host 'Optional: for AI features with your Claude subscription, run "npm i -g @anthropic-ai/claude-code", then "claude" once to sign in.' -ForegroundColor DarkGray
}

# 4. Register the helper with the browsers.
node native-host/install.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host 'Done. Restart your browser, then open StreamSnag Settings -> Local helper -> Check helper.' -ForegroundColor Cyan
