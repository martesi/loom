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

- Work in your own git worktree by default; do not edit the shared checkout.
- Run tests for changed paths: frontend logic → `cd frontend && bun run test`
  plus affected Playwright specs; Go → `go test` for affected packages; e2e
  harness → `cd frontend && bun run test:harness` plus one focused spec.
- Run focused specs from `frontend`: `bunx playwright test e2e/<spec>.spec.ts`.
  Set `E2E_WORKERS` to control parallel workers. Artifacts are in
  `.cache/e2e/runs/<run-id>/`.
- Full `bun run test:e2e` is not the default for scoped local changes; CI runs
  the full suite.
