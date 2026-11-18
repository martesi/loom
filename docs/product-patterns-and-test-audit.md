# Product patterns and UI test audit

Research snapshot: 2026-11-18. External products are UX references; their
different data models should not be copied into Loom.

## Patterns worth borrowing

- **Keep catalog queries separate from spatial placement.** Lightroom Classic
  separates filesystem folders from catalog collections, and removing a photo
  from a collection does not delete the catalog record or file. Its Smart
  Collections also show a useful path for future metadata-driven views. Loom's
  All Assets / Folders split and unplace / trash / purge distinction fit this
  model, while Loom should keep the simpler one-set membership rule.
- **Make spatial grouping easy to enter and leave.** PureRef lets users select
  multiple references, group them, drag items into groups, move groups as one,
  and removes empty groups. Its hierarchy view is a fallback for selection and
  ordering when the canvas is crowded. Loom's compact collapsed set, drag
  membership, and explicit expansion are a good fit; a full hierarchy is not
  justified yet.
- **Treat the viewport as saved workspace state.** Obsidian Canvas offers
  Space/middle-drag pan, zoom-to-fit, zoom-to-selection, reset zoom, and
  persistent canvas documents. Keep those operations easy to reach and test
  that repository viewport state returns after reload.
- **Match connection affordances to the job.** ComfyUI's visible typed handles
  make sense for constructing executable workflows. PureRef and Obsidian use
  spatial gestures for board-like work. Loom's Ctrl/Cmd-drag keeps image
  relationships explicit without permanent handles; source, target, cycle,
  and self-link feedback should remain visible during the gesture.
- **Reuse the graph engine's tested primitives.** The xyflow React examples
  cover controlled selection, connection start/end, viewport controls, and
  fit-view behavior. Loom already uses React Flow, so prefer its existing
  selection and viewport APIs over custom parallel state.

## Reference checkout and license

Cloned to `/tmp/opencode/loom-refs/` for local UX/code-structure inspection:

- `xyflow`: [MIT](https://github.com/xyflow/xyflow/blob/main/LICENSE), directly
  relevant because Loom uses React Flow.
- `comfyui-frontend`: [GPL-3.0](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/LICENSE),
  UX reference only. Do not copy code without a license compatibility review.

PureRef, Lightroom, Obsidian, and Figma were reviewed through official docs;
their application sources were not cloned.

## Prioritized contract and test gaps

1. **P0 — concurrent E2E runs could steal fixture discovery.** The harness
   wrote one shared `.cache/e2e/fixture-root.txt`, used a fixed default port,
   shared Playwright output directories, and built bindings plus `frontend/dist`
   concurrently in the checkout. Run IDs now flow through one helper; fixtures,
   temporary repos, reports, and test output use that run's directory. An unused
   port is selected when none is configured, and one checkout-wide lock
   serializes binding generation, the frontend build, and the server build.
   The lock never removes a stale lock automatically: it fails with recovery
   instructions so concurrent waiters cannot unlink a new owner's lock. Signal
   handling terminates the build process tree and waits for it to exit before
   releasing the lock.
2. **P1 — selection ownership needed a direct regression assertion.** Existing
   tests covered selection transfer on placement but did not explicitly prove
   that choosing an asset clears Canvas selection and returning to Canvas
   clears Assets selection. Added that assertion to `canvas.spec.ts`.
3. **P1 — marquee test did not test selection.** It asserted only that nodes
   remained rendered. It now asserts that a plain marquee replaces the prior
   selection with the two enclosed nodes.
4. **P1 — clipboard payload validation lacked a pure unit boundary.** Browser
   E2E already covers clipboard round trips and import. Normalization is now a
   standalone pure function with `bun:test` coverage for valid and malformed
   payloads.
5. **P2 — relationship edge cases needed explicit UI assertions.** Added
   Playwright coverage for self-link rejection, rejecting collapsed sets as
   relationship sources, and using Sources to reveal and select an unplaced
   asset. Existing tests continue to cover cycle rejection, set fan-out,
   navigation, and unlinking.
6. **P2 — translation coverage is partial.** Added Lingui extraction for the
   Canvas dock, Selection HUD, common Inspector actions, section headings, and
   form accessibility labels. Round 3 adds pluralized set and asset counts,
   plus the Assets shelf's mode, search, filter, choice, and empty-state text.
   English remains the only shipped locale; remaining literal labels in other
   Canvas and Assets paths, including filter chips and selection summaries,
   still need extraction before another locale is added.

## Existing evidence and remaining work

- Two concurrent Playwright invocations passed with separate ports and fixture
  roots. After adding the three P2 UI regressions, the full 43-test server-mode
  suite passed. Go tests, frontend typecheck, Biome, and production build also
  passed.
- Node's `test:harness` verifies that lock contenders serialize, stale locks
  remain for explicit recovery, and a ready build descendant exits before
  cleanup. Bun's `test:unit` remains limited to pure helpers as required by
  `r/ui.md`.
- E2E coverage already exists for asset range/toggle selection, multi-row drag,
  placement invariants, normal move versus modified relationship drag, hidden
  handles, sets, unplace/trash/purge, viewport persistence, Sources/Derived
  actions, and import.
- Go coverage already exercises membership-based migration, import naming and
  byte preservation, placement idempotence, atomic set membership, empty-set
  cleanup, purge, and viewport round-trip. Invalid viewport values now have
  direct rejection coverage.
- The regular Playwright config builds and launches an isolated production-mode
  server. `.config/arca.toml` is a separate dev-server route on port 9245. The
  `test:agent` command selects an Arca profile separate from the default. That
  profile has a fixed data directory and CDP port, so concurrent
  `test:agent` runs are unsupported; run agent-browser checks one at a time.
- CI retries are disabled until each test attempt gets a fresh copy of its
  mutable fixture repo. A retry currently could inherit files and `.loom` state
  from the failed attempt.
- The Sources, self-link, and collapsed-set source cases now have direct
  browser assertions. The collapsed-set case also checks that no relationship
  preview appears while the Ctrl-drag is in progress.
- Round 3's Lingui extraction contains 201 English messages. Set and asset
  counts are full plural messages, including the set badge's surrounding text.

## Sources

- [PureRef image selection and groups](https://www.pureref.com/handbook/features/)
- [PureRef arrange and align](https://pureref.com/handbook/images/organize/)
- [Lightroom Classic collections](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/photo-collections.html)
- [Lightroom Classic folder/catalog model](https://helpx.adobe.com/lightroom-classic/desktop/manage-catalogs-and-files/lightroom-catalog-basics.html)
- [Obsidian Canvas guide](https://obsidian.md/help/plugins/canvas)
- [Figma sections](https://help.figma.com/hc/en-us/articles/9771500257687-Organize-your-canvas-with-sections)
- [ComfyUI node connections](https://github.com/Comfy-Org/docs/blob/main/basic-concepts/nodes.mdx)
- [xyflow React examples](https://github.com/xyflow/xyflow/tree/main/examples/react)
