# The website edition's helper package only (copied in as files\extras.ps1 by scripts/build-helper-windows.mjs
# --site; setup.ps1 runs it after the ffmpeg step): yt-dlp, for playlists and the sites the browser can't save.
if ((Have 'yt-dlp') -or (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\yt-dlp.exe'))) {
  Write-Host 'yt-dlp found.' -ForegroundColor Green
} elseif (-not $SkipFfmpeg -and (Have 'winget') -and (Ask 'Install yt-dlp (free; lists playlists and saves from sites the browser cannot)?')) {
  winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements
} else {
  Write-Host 'Skipped yt-dlp. You can install it later: winget install yt-dlp.yt-dlp' -ForegroundColor DarkGray
}
