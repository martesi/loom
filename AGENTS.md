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
  render_node=
  for node in /dev/dri/renderD*; do
    if [ -c "$node" ] && [ -r "$node" ] && [ -w "$node" ]; then render_node=1; break; fi
  done
  if [ -e /dev/dxg ] && [ "$render_node" = 1 ] \
    && find -L /run/opengl-driver/lib -type f -name '*.so*' -readable -print -quit | grep -q . \
    && find /run/opengl-driver/share/glvnd/egl_vendor.d -maxdepth 1 -type f -name '*.json' -readable -print -quit | grep -q . \
    && [ -d /usr/lib/wsl/lib ] \
    && find /usr/lib/wsl/drivers -type f \( -name '*.so' -o -name '*.so.*' \) -readable -print -quit | grep -q .; then
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
