#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI_DIR="$ROOT_DIR/cli"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run the SocialPoster plugin builder. Please install Node.js 20+ and try again." >&2
  exit 1
fi

if [ ! -d "$CLI_DIR/node_modules" ]; then
  echo "Installing CLI dependencies on first run..."
  (cd "$CLI_DIR" && npm install --no-audit --no-fund)
fi

exec node "$CLI_DIR/index.mjs" "$@"
