# Loom agent instructions

Toolchain (go, bun, wails3, task, chromium, xvfb) is provided by the Nix
flake. Do not assume these exist on the host `PATH`.

When `nix` is present (`command -v nix` succeeds), run repo commands inside
the shell:

- Default shell — builds, unit tests, frontend:
  `nix develop --command bash -lc '<cmd>'`
- E2E / browser shell — Playwright, `test:e2e`, benchmarks, anything needing
  Chromium or a virtual display (supplies `CHROMIUM_BIN`, xvfb, xdotool):
  `nix develop .#e2e --command bash -lc '<cmd>'`
- Preferred WSL GPU E2E shell when runtime device and mount checks pass:
  ```sh
  if [ -e /dev/dxg ] && find /dev/dri -maxdepth 1 -type c -name 'renderD*' -readable -writable -print -quit | grep -q . \
    && [ -d /run/opengl-driver/lib ] \
    && [ -d /run/opengl-driver/share/glvnd/egl_vendor.d ] \
    && [ -d /usr/lib/wsl/lib ] \
    && [ -d /usr/lib/wsl/drivers ]; then
    nix develop .#e2e-wsl-gpu --command bash -lc '<cmd>'
  else
    nix develop .#e2e --command bash -lc '<cmd>'
  fi
  ```
  Device presence does not prove acceleration. Verify the WebGL renderer; it
  must name the GPU and D3D12. The fallback shell is `.#e2e`.

`.envrc` (`use flake`) loads only the default shell, never either e2e shell.

- Work in your own git worktree by default; do not edit the shared checkout.
- Run tests for changed paths: frontend logic → `cd frontend && bun run test`
  plus affected Playwright specs; Go → `go test` for affected packages; e2e
  harness → `cd frontend && bun run test:harness` plus one focused spec.
- Run focused specs from `frontend`: `bunx playwright test e2e/<spec>.spec.ts`.
  Set `E2E_WORKERS` to control parallel workers. Artifacts are in
  `.cache/e2e/runs/<run-id>/` relative to the repository root.
- Full `bun run test:e2e` is not the default for scoped local changes; CI runs
  the full suite.
