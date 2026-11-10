#!/bin/sh
# StreamSnag: setup of the optional local helper on macOS and Linux.
# Run from the StreamSnag folder:  sh setup.sh
# Registers the helper with Chrome, Edge, Brave and Chromium for your user, and tells you what's missing.
set -e
cd "$(dirname "$0")"

have() { command -v "$1" >/dev/null 2>&1; }

echo "StreamSnag helper setup"
echo "-----------------------"

if ! have node; then
  echo "Node.js 18 or newer is needed to run the helper: https://nodejs.org (or: brew install node / sudo apt install nodejs)"
  exit 1
fi
echo "Node.js $(node --version) found."

for tool in ffmpeg yt-dlp; do
  if have "$tool"; then
    echo "$tool found."
  else
    echo "Optional: install $tool for full features (macOS: brew install $tool, Debian/Ubuntu: sudo apt install $tool)."
  fi
done
have claude || echo "Optional: for AI with your Claude subscription, run 'npm i -g @anthropic-ai/claude-code', then 'claude' once to sign in."

node native-host/install.js

echo
echo "Done. Restart your browser, then open StreamSnag Settings -> Local helper -> Check helper."
