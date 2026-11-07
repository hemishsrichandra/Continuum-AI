#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null; then
  export PATH="$HOME/.local/share/continuum-node/node-v22.16.0-linux-x64/bin:$PATH"
fi
if ! command -v node >/dev/null; then
  printf 'Install Node 22 in WSL, then run npm ci and npm start.\n' >&2
  exit 1
fi
exec node server/start.js
