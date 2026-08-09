#!/usr/bin/env bash
# Launches headless Chromium with a CDP port already open, to drive with
# `agent-browser --cdp <port> ...` (run inside the `web-e2e` nix devShell).
#
# Why not just `agent-browser open <url>` and let it launch Chrome itself?
# That's the normal path — try it first. In at least one sandboxed
# environment (Claude Code's bubblewrap sandbox), agent-browser's own
# launch-and-attach handshake reliably fails with "Connection reset without
# closing handshake" on the CDP websocket, even against a correctly-linked
# Chromium with --no-sandbox and --remote-allow-origins=* set. Starting
# Chromium ourselves and having agent-browser attach via --cdp sidesteps
# whatever that handshake trips over. Use this script only if the normal
# path hangs or resets.
set -euo pipefail

if [ -z "${CHROMIUM_BIN:-}" ]; then
  echo "CHROMIUM_BIN is not set — run this inside 'nix develop .#web-e2e'" >&2
  exit 1
fi

port="${1:-9222}"
profile_dir="$(mktemp -d)"

echo "Starting Chromium on CDP port $port (profile: $profile_dir)" >&2
exec "$CHROMIUM_BIN" \
  --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --remote-allow-origins=* \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" \
  --user-data-dir="$profile_dir" \
  about:blank
