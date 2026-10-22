#!/usr/bin/env bash
# Bundle teleclaude for distribution: dist/index.js (daemon+CLI) and
# dist/channel-server.js (MCP server Claude Code spawns per topic).
#
# node-pty (native prebuilds) and puppeteer (Chromium download) stay external
# and are installed from the tarball's dependencies on the installing machine.
#
# GOTCHA (verified by the 2026-08-21 node-MCP spike): esbuild's puppeteer
# externalization is NOT lazy. screenshot.ts's top-level import of puppeteer
# gets hoisted into a static top-level ESM import in the bundle, which
# resolves EAGERLY at process startup, before any screenshot/browse/android/
# ios tool is ever called. That means dist/index.js and dist/channel-server.js
# MUST be run from a location where `node_modules/puppeteer` (and
# `node_modules/node-pty`) are resolvable via normal Node module resolution —
# i.e. dist/ needs to sit inside (or under) the package root where npm
# installed these as real dependencies. Do not copy dist/*.js out to a bare
# directory without node_modules next to (or above) it.
#
# The --banner:js createRequire shim below is load-bearing: ajv's
# generated-code `require(...)` calls (deep in the bundled MCP SDK dependency
# tree) need a real `require` in an ESM bundle, and esbuild does not provide
# one automatically for --format=esm.
set -euo pipefail
cd "$(dirname "$0")/.."

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
VERSION="$(node -p "require('./package.json').version")"

rm -rf dist
npx esbuild src/index.ts src/channel-server.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --outdir=dist \
  --external:node-pty --external:puppeteer \
  --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
  --define:process.env.TELECLAUDE_BUILD_COMMIT="\"$SHA\"" \
  --define:process.env.TELECLAUDE_BUILD_VERSION="\"$VERSION\"" \
  --log-level=warning

chmod +x dist/index.js
echo "built dist/index.js + dist/channel-server.js (v$VERSION @ $SHA)"
