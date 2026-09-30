#!/usr/bin/env bash
# Update from git, then serve.
#
# Two stages on purpose. Stage 1 replaces this file from origin/main.
# Stage 2 is a new process, so it runs the script that was just fetched,
# not the one that started the pull.
#
#   bash run.sh
#
# --run is the handoff. Keep that flag. An older stage 1 still passes it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "${1:-}" != "--run" ]]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "This folder is not a git checkout: $ROOT" >&2
    echo "Clone it once, then start with: bash run.sh" >&2
    exit 1
  fi
  echo "Fetching origin/main..."
  git fetch --prune origin
  git checkout -f main
  git reset --hard origin/main
  exec /usr/bin/env bash "$ROOT/run.sh" --run
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed." >&2
  exit 1
fi

stamp="node_modules/.install-stamp"
need_install=0
if [[ ! -d node_modules/express ]]; then
  need_install=1
elif [[ package.json -nt "$stamp" ]]; then
  need_install=1
elif [[ -f package-lock.json && package-lock.json -nt "$stamp" ]]; then
  need_install=1
fi
if [[ "$need_install" -eq 1 ]]; then
  echo "Installing dependencies..."
  npm install
  mkdir -p node_modules
  touch "$stamp"
fi

export PORT="${PORT:-3847}"
echo "Serving http://127.0.0.1:${PORT}"
exec node server.js
