# Canvas, viewport, and Sets workflow enrichment

**Status:** Proposed. This document is a plan, not implementation or test evidence.
**Scope:** Strengthen the existing Canvas and Sets workflows. Keep React Flow,
the repository Canvas model, and the existing Playwright harness.

## Contract and evidence

[`r/ui.md`](../../r/ui.md) owns product semantics.
[`ui-experiment-plan.md`](../ui-experiment-plan.md) owns the full-viewport Canvas,
floating drawers, contextual dock, action catalog, and Focus Canvas direction.
This plan adds precise interaction rules and sequence-level acceptance tests.
It does not add boards, nested sets, spatial frames, or a persistent layout mode.

The inspected implementation provides these starting points:

- `frontend/src/routes/canvas.tsx` owns selection, projected image/set nodes,
  arrangement, alignment, membership drops, and viewport service calls.
- `arrange` uses `computeSubgraphLayout` and `placeCluster`. Collapsed sets move
  through member position updates rather than separate persisted deck positions.
- Alignment currently uses rounded mean **top-left** coordinates: horizontal
  alignment changes Y; vertical alignment changes X. Keep this definition unless
  a separate product decision adopts center or edge alignment.
- `selectedCanvasNodeIds` maps selected placed assets to visible image/deck nodes.
  The selection model also has one `group` field. Verify mixed and multiple-deck
  selection; one expanded set must not imply only one selectable set.
- The route has fit/reset/zoom commands and a transient `expanded` ID. Initial
  fitting currently uses a timer; restoration and save ordering need direct tests.
- `group-node.tsx` provides a cover deck, member count, and fallback name.
  `image-node.tsx` keeps actions in the dock and metadata on hover/focus.
- `shelf-panel.tsx` overlays the graph and makes hidden drawers inert. The route
  closes the opposite drawer on narrow-width open, but width transitions also
  need coverage.

## 1. Selection and gesture rules

| Input | Result |
| --- | --- |
| Plain node click | Replace Canvas selection with that visible item. Clear Assets selection. |
| Shift/Ctrl/Cmd node click | Toggle that item without losing other Canvas items. |
| Plain background marquee | Replace selection with intersected nodes, including partially intersected nodes. |
| Modified background marquee | Add intersected items to the current Canvas selection. Do not remove prior items. |
| Plain background click | Clear selection and collapse the active set. |
| Normal drag from selected node | Move the selected visible items together. |
| Normal drag from unselected node | Select that node first, then move it. |
| Space-drag or middle-drag | Pan without moving nodes or changing membership. |
| Ctrl/Cmd-drag from image | Create a relationship only after crossing the gesture threshold; never move that image. |

Use React Flow primitives and the existing authoritative selection context.
Do not create a second hidden selection for dragging. Snapshot drag ownership
and IDs at pointer-down. Clear transient gesture state on cancel and window blur.
Space-pan takes priority over selection or relationship initiation.

Keep modified click separate from modified drag: a small pointer displacement
must toggle selection, not create a link. Shift-marquee and Ctrl/Cmd-marquee must
have the same additive result. Edges remain selectable for navigation/unlink,
not endpoint reconnection. Canvas Select all includes placed assets represented
by collapsed sets, without counting the deck as an additional asset.

## 2. Arrange and align

- Keep explicit **Auto-arrange Canvas** and **Auto-arrange selection** commands.
  The first acts on all visible placed items; the second never moves outsiders.
- Preserve the existing `Shift+A` rule: arrange selection when at least two
  visible items are selected, otherwise arrange Canvas. Show this scope in the
  action description so a single selected item does not imply a local operation.
- Selection arrangement uses the induced subgraph: only edges whose endpoints
  are selected affect the local layout. Do not pull connected outside nodes in.
- Keep deterministic ordering for disconnected nodes and components. Use node
  dimensions, not thumbnail assumptions. Preserve outside positions and use the
  existing collision-aware cluster placement for the arranged result.
- A collapsed set is one layout item. Apply its resulting delta once to every
  placed member. An expanded set exposes ordinary member nodes; arrange only
  the selected members unless the full Canvas command is used.
- **Align horizontally** creates a row at the rounded mean selected top-left Y.
  **Align vertically** creates a column at the rounded mean selected top-left X.
  Preserve the other coordinate and each node's size. Alignment does not imply
  distribution, resizing, or overlap prevention.
- For alignment, translate each selected collapsed deck's placed members by the
  same delta. Deduplicate member updates when a deck and its IDs are represented
  in selection. Enable alignment only for two or more visible items.
- Arrange and align are one-shot persisted position mutations. Do not fit,
  reset, or change the viewport automatically. Preserve selection after refresh.
  Use one batch position operation per command and report errors visibly.

## 3. Lifecycle meanings across surfaces

| Action | Meaning |
| --- | --- |
| Canvas Delete/Backspace or Unplace | Remove placement only. Preserve file, asset identity, metadata, relationships, and set membership. |
| Assets Delete/Backspace | Trash selected assets. Keep the existing retention and restore policy. |
| Explicit Canvas Trash action | Trash assets, not just their nodes. Label it distinctly from Unplace. |
| Selected edge Delete/Backspace | Remove that relationship; do not trash either endpoint. |
| Shift+Delete/Backspace on either surface | Confirm irreversible purge with the deduplicated final asset count. |
| Dissolve set | Remove membership/set metadata; preserve assets and their placements. |

Inspector and dock commands use the active surface; opening Inspector does not
transfer selection ownership. Text editors retain native Delete and shortcuts.
Snapshot purge IDs for the confirmation. Cancel makes no change.

For a selected deck, Unplace affects its placed members only. Semantic commands
that act on the whole set must state that scope and count all affected assets,
including unplaced members. A set with no placed members is not an empty set:
it remains in metadata but has no Canvas deck. Removing the last membership,
not merely the last placement, triggers empty-set cleanup.

## 4. Sets workflow

| Operation | Planned rule |
| --- | --- |
| Create | Require at least two selected, placed, ungrouped images. Keep positions; create one collapsed set. Make the new set the active selection after success. |
| Expand | Double-click a deck or run Expand selected set. Reveal placed members at stored positions; do not place unplaced members or auto-fit. |
| Collapse | Run Collapse active set or click outside its members. Hide member nodes behind the deck without changing stored positions. |
| Switch expansion | Expanding B collapses A in the same state transition. Only one set is expanded at a time. |
| Add member | Normal-drop an ungrouped image or Assets item onto a collapsed deck. Show a clear membership target state. |
| Move member | Drop a member of A onto B. Replace membership atomically, never duplicate it; clean up A if it becomes empty. |
| Place into set | Dropping an unplaced Assets item places and adds it as one operation. A repeated drop cannot create another placement. |
| Move collapsed set | Translate all placed member positions by the deck's flow-coordinate delta. Preserve offsets and sizes; leave unplaced members unplaced. |
| Cover | Choose a member explicitly through Inspector/palette. Persist the cover; changing it does not move members. |
| Rename/kind | Edit set metadata, not files. Commit through the existing service boundary; retain cover-based fallback when name is blank. |
| Dissolve | Remove the set, reveal placed members at unchanged positions, and clear stale expanded/selected set IDs. |

Click-outside means a completed Canvas background click, a click on an unrelated
Canvas item, or selection transfer to Assets. Inspector, dock, palette, rename,
and cover interactions are not outside clicks. Do not collapse on pointer-down,
during a member drag, on pan, or while completing a membership drop. A modified
marquee is a selection gesture, not an outside-click collapse.

Use the existing cover fallback when the requested cover cannot be displayed.
Verify cover removal/membership transfer and missing thumbnails. If the cover
leaves a set, select a deterministic remaining-member fallback rather than a
stale foreign member. Keep total member count visible; Inspector can distinguish
placed from unplaced members. Do not pretend that expansion shows all members
when some are unplaced.

Drag completion must handle a selection containing images and collapsed decks.
Each moved deck receives its own delta; each asset receives at most one update.
Do not parse `set-*` IDs as image IDs in a membership batch. Preserve relative
positions for ordinary multi-item movement and avoid a second translation after
the service response.

Sets remain semantic membership, not geometry. Moving an expanded member outside
the old bounds does not remove membership. A relationship from image A to a
collapsed set remains a one-time fan-out to current members. Membership changes
must not rewrite these edges; a set cannot be a relationship source.

## 5. Viewport, Focus Canvas, and narrow widths

- Persist one repository viewport `{x, y, zoom}`. Restore it after the graph host
  is ready, before a save callback can overwrite it. Reject non-finite values and
  retain the graph engine's supported zoom limits.
- Without saved state, fit placed visible items once after dimensions are ready.
  With no placed items, retain a usable default and do not run repeated fits.
  Prefer readiness signals to a fixed delay in a later implementation.
- Save completed pan/zoom gestures and completed Fit all, Fit selection, Reset,
  Zoom in/out, and navigation-to-node commands. Serialize/coalesce writes so an
  older save cannot win after a newer gesture. Report save failures.
- Fit all frames rendered image/deck bounds. Fit selection uses selected visible
  items and is disabled for Assets-only or edge-only selection.
- Reset 100% changes zoom to `1` while preserving the world point at the center
  of the Canvas host. It does not move graph nodes or reset translation to zero.
- Drawer open/close/resize, Focus Canvas entry/exit, and set expansion/collapse
  must not implicitly fit or reset. Keep the React Flow host rectangle unchanged.
- Focus Canvas hides drawers, top island, and dock while preserving selection,
  expanded set, viewport, and drawer pin/open state. The palette and `Mod+\\`
  remain usable. Opening a drawer explicitly exits Focus Canvas.
- Keep expansion and Focus Canvas transient across reload. Restore the repository
  viewport, not a former UI mode. Follow the experiment's default closed drawers.
- On narrow widths, show at most one drawer. Reconcile a wide-to-narrow resize
  when both drawers are open; prefer the most recently used drawer. Retain pin
  intent, but never let two pinned overlays make the workspace unusable.
- Bound drawers, dock overflow menus, dialogs, and palette to the viewport.
  Keep all commands reachable without hover. Hidden controls must be inert;
  restore focus to a visible trigger or Canvas, never a hidden control.

## 6. Product inspiration and limits

Use the references in
[`product-patterns-and-test-audit.md`](../product-patterns-and-test-audit.md):

- **Figma sections:** borrow clear names, visible collection identity, and easy
  whole-collection movement. Do not borrow containment-based membership,
  resizable section frames, nested hierarchy, or another placement model.
- **Obsidian Canvas viewport:** borrow direct pan, fit-all, fit-selection, reset,
  and easy access to viewport commands. Loom's explicit repository viewport
  contract is the source of truth; this reference is not proof of identical
  viewport persistence in Obsidian.
- Keep the experiment's viewport-anchored contextual dock. A toolbar that follows
  a node can be clipped at viewport edges and compete with image dragging.

## 7. Verification plan

Extend the existing Playwright suites. Reuse isolated repository fixtures and
tracked harness configuration; discover runtime paths and ports through the
harness. Do not add a second browser runner or hard-code environment values.

### Primary sequence: select → arrange → align → set → viewport reload

1. Place differently sized A, B, C plus outside item D. Add A → B and B → C.
2. Select D, then plain-marquee A/B. Assert exact selected IDs and cleared D.
   Modified-marquee C; modifier-toggle B off and on. Assert ownership and count.
3. Auto-arrange selection. Assert A/B/C change, D is unchanged, edges survive,
   and viewport does not change. Reload data without losing selection.
4. Align horizontally. Assert equal top-left Y, unchanged X and sizes. Align
   vertically in a separate branch and assert equal X, unchanged Y.
5. Create set from A/B/C. Assert one deck, count three, one membership per asset,
   and preserved positions. Rename and choose B as cover; assert persisted label.
6. Drag the collapsed deck at non-unit zoom. Expand and assert the same world
   delta for A/B/C, unchanged relative offsets, and unchanged D.
7. Fit selection, pan, zoom, then Reset 100%. Capture the world center and saved
   viewport. Enter Focus Canvas; invoke fit through the palette, then pan/zoom.
8. Reload after persistence completes. Assert the latest viewport returns within
   numeric tolerance, metadata/positions survive, and expansion is collapsed.
   Confirm no initial fit overwrites the saved viewport.

### Additional regression sequences

- Expand A, drag a member to B, verify A collapses only after completion, then
  expand B. Move A's final member and assert automatic deletion of empty A.
- Include an unplaced set member: deck drag/align/arrange never places it.
  Unplace all visible members and verify membership survives without a deck.
- Select two decks plus an image, then drag, arrange, and align. Assert every
  placed member moves exactly once and all unselected positions are unchanged.
- Assets multi-drag into a set, including already placed and foreign-set assets:
  verify active selection transfer, one placement each, and atomic membership.
- Click a member, Inspector, palette, unrelated image, and background in turn.
  Assert collapse rules; pan/cancel must not collapse or mutate membership.
- Unplace from Canvas, locate in Assets, place again, trash from Assets, restore,
  then cancel/confirm purge. Assert file/metadata effects and exact purge count.
- Test Shift/Ctrl/Cmd marquee, relationship threshold/cancel, and Space-pan at
  different zooms. Assert selection, positions, and edge count, not just rendering.
- At narrow width and on wide-to-narrow resize, open/pin drawers, enter/exit Focus
  Canvas, and use palette/dock overflow actions. Assert stable host bounds, one
  visible drawer, usable focus, and no hidden tab stops.
- Save multiple quick viewport changes, switch repositories, and reload each.
  Assert repository isolation and last-completed viewport persistence.

Use stable IDs and accessible names. Compare world positions and relative
offsets with tolerance; do not rely only on screenshots or fixed screen pixels.
Wait for observable operation completion, not arbitrary sleeps. Preserve existing
relationship, shelf, dock, and lifecycle suites. Pure selection, delta,
layout-scope, and viewport-center helpers may use `bun:test`; UI evidence remains
Playwright. Add service tests only where atomicity or ordering needs proof.

## Delivery order and completion gate

1. Confirm the explicit rules above against existing tests and service semantics.
2. Strengthen selection/gesture normalization and mixed deck movement.
3. Complete set commands and state cleanup through the shared action catalog.
4. Harden viewport readiness/save ordering and responsive Focus Canvas behavior.
5. Add the primary sequence and targeted regression branches; run existing suites.

Implementation is complete only when the contract and sequence assertions pass
and no workflow introduces extra placements, stale set IDs, unintended trash,
or automatic viewport jumps.

## Implementation review (2026-11-19)

- **Verdict: keep with follow-up, not complete.** The arrangement filter uses
  edges whose endpoints are in the requested scope. The position batches keep
  only the last update for each asset ID; this prevents duplicate writes but
  does not resolve conflicting deltas. Visible deck and member nodes should be
  mutually exclusive; test that invariant and mixed selections. These changes
  are local and can be reverted independently.
- Set creation deduplicates and filters for placed images, but its selection
  update is broken: `CreateGroup` returns `GroupInfo | null`, not a number.
  The existing IDs may still visually select the deck, but `selection.group`
  remains null, so group-specific commands are not guaranteed to work. The
  enablement check also does not require placed, non-trashed IDs; filtering
  can silently turn an enabled action into a no-op or a partial selection.
  The new selection code is independently reversible; keep the useful filter
  pending a consistent eligibility rule and explicit success handling.
- **Typecheck:** Four `asset-gallery.tsx` errors for `LibraryRow.width` and
  `height` remain. The gallery and Go `LibraryRow` are unchanged from the
  working-copy parent; Go declares both fields, but the generated frontend
  binding used by this check does not. Check binding generation and provenance
  before changing the model. The newly added `replaceAll` in
  `clipboard-payload.ts` exceeded the ES2020 library target; replaced it with
  an equivalent global replacement. Its three focused tests pass. One earlier
  typecheck also reported a missing generated `PurgeExpiredTrash` binding in
  the concurrently changing route; that error was absent on the next run.
- **Next slice:** Correct create-set eligibility and use the returned
  `GroupInfo.id` after a successful reload. Add a focused regression that selects
  two placed ungrouped images, creates a set, and checks membership, unchanged
  positions, and active group selection; include an ineligible/unplaced case.
  Use the existing harness and run only the targeted test when available. This
  establishes the set step before extending the full selection-to-reload
  sequence. No Playwright run was made for this review.

## Focused workflow E2E results (2026-11-19)

- Added `frontend/e2e/canvas-workflows.spec.ts` for selection, selection
  arrangement, horizontal alignment, set creation/expansion, and viewport
  restoration after reload. The spec uses the existing fixture helpers and the
  configured single worker.
- The dock and action catalog share the same `canCreateSet` predicate. The
  fixture config contains only the three image files; it does not pre-group
  them. Generated image records use group ID `0` for ungrouped images, so the
  strict `groupId == null` check incorrectly rejected all three. Eligibility
  now treats both `null` and `0` as ungrouped.
- `bunx tsc --noEmit` passes. The first focused `canvas-workflows.spec.ts` run
  passed selection, arrangement, alignment, Create Set, and expansion, then
  failed after reload because the test expected the transiently expanded
  members to remain visible. Expansion is transient by contract, so the test
  expectation was incorrect; it now expects the collapsed three-member deck,
  verifies the restored viewport, expands the deck, and compares member
  positions.
- Initial attempts to click overlapped nodes directly were test interaction
  issues; the test now uses Canvas Select all from the pane context menu. The
  final observed failure is the disabled action, not node hit testing.

## Focused workflow rerun (2026-11-19)

- Ran
  `nix develop .#e2e --command bash -lc 'cd frontend && bunx playwright test e2e/canvas-workflows.spec.ts'`
  with the configured single worker. The production server compiled, and the
  one workflow test passed (3.4 s; 9.8 s total).
- Per-test result: `select, arrange, align, create and expand a set, then
  restore viewport` — passed. This covers the corrected collapsed-deck reload
  expectation, viewport restoration, and post-reload expansion/position checks.
- Triage: the earlier post-reload failure was a test bug caused by expecting
  transient expansion to survive reload. No remaining test or app failure was
  observed; no Canvas application code was changed for this rerun.
