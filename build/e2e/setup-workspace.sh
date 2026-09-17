#!/usr/bin/env bash
set -euo pipefail

LOOM_ROOT="$(git rev-parse --show-toplevel)"
LOOM_E2E_CACHE="$LOOM_ROOT/.cache/e2e"
mkdir -p "$LOOM_E2E_CACHE/playwright-report" "$LOOM_E2E_CACHE/test-results" "$LOOM_E2E_CACHE/tmp"

export LOOM_ROOT LOOM_E2E_CACHE
