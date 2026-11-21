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

`.envrc` (`use flake`) loads only the default shell, never `.#e2e`.
