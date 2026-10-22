#!/usr/bin/env bash
# Teleclaude one-shot installer: installs deps, runs setup if needed, and
# installs the background service. Safe to re-run (idempotent).
#
# Usage:
#   ./scripts/install.sh
#
# Run from a terminal, NOT from inside a Teleclaude chat.
set -euo pipefail

# Resolve project root (this script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo "==> Teleclaude installer ($ROOT)"

# --- Prerequisites ---
command -v node >/dev/null 2>&1 || { echo "✗ node not found. Install Node.js 20+ first."; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "✗ npm not found. Install Node.js 20+ first."; exit 1; }
echo "    node $(node -v), npm $(npm -v)"

# --- Dependencies ---
echo "==> Installing dependencies (npm install)"
npm install

# --- Config / setup ---
CONFIG="$HOME/.teleclaude/config.json"
TOKEN="$HOME/.teleclaude/bot_token"
if [ ! -f "$TOKEN" ] || [ ! -f "$CONFIG" ]; then
  echo "==> No config found — running setup"
  npx tsx src/index.ts setup
else
  echo "==> Config already present — skipping setup (edit $CONFIG to change authorized users)"
fi

# --- Service ---
echo "==> Installing background service"
npx tsx src/index.ts install

echo
echo "✓ Done. $(npx tsx src/index.ts version)"
echo "  Logs:    tail -f ~/.teleclaude/logs/teleclaude.log"
echo "  Update:  npx tsx src/index.ts update"
echo "  Restart: npx tsx src/index.ts restart"
