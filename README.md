# Loom

Loom is a local-first desktop workspace for image collections and derivation graphs. It keeps original media on disk, stores Loom metadata in `.loom/`, and renders cached thumbnails on one infinite Canvas so large repositories stay responsive.

**Status:** active development. The current product model is one repository with three surfaces: Assets, Canvas, and Inspector.

## Core workflow

- **Assets** is the searchable catalog and filesystem view. Assets may stay unplaced.
- **Canvas** is one infinite relationship workspace per repository. Drag assets onto it to place them.
- **Relationships** record source → derived provenance. Ctrl/Cmd-drag an image onto another image or set to create one. Cycles are rejected.
- **Sets** group sibling images such as variants or turnarounds. Select 2+ Canvas images and use **Create set** or `Ctrl/Cmd+G`.
- **Inspector** edits metadata and exposes Sources / Derived navigation for the active selection.

Trash, restore, rename, move, import, clipboard operations, placement, sets, relationships, viewport state, and core metadata are persisted per repository. Trash is retained for 30 days, then permanently purged automatically.

## Development

The project uses Go + Wails v3 for the desktop/backend layer and React + TypeScript + Vite for the frontend. Nix provides the development toolchain.

```sh
nix develop
task dev
```

Server mode is useful for browser-driven development and E2E work:

```sh
task dev:server
```

Build the desktop app with:

```sh
task build
```

## Checks

```sh
nix develop --command go test ./...
nix develop --command bash -lc 'cd frontend && bun run build'
nix develop .#e2e --command bash -lc 'cd frontend && bun run test:e2e'
bun run test:agent -- snapshot
bun run benchmark:1k
```

Focused Playwright specs live under `frontend/e2e/`. `benchmark:1k` records 1,000-photo Canvas latency and browser resource metrics to `.cache/e2e/benchmark-1k.json`. Arca owns the agent-driven Chromium/dev-server lifecycle from `.config/arca.toml`; test runtime artifacts stay under `.cache/`.

## Repository layout

```text
frontend/        React UI and Playwright tests
internal/        Go store, services, media, and domain logic
build/           Wails/task build and E2E helpers
r/               current product/design decisions
docs/            older design context and migration notes
```

`r/ui.md` describes the current Assets / Canvas / Inspector interaction model. Older documents under `docs/` may describe superseded board-era decisions.
