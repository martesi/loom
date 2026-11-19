# Assets navigator workflow enrichment

**Status:** Proposed. This document is a plan, not implementation or test evidence.
**Scope:** Enrich the existing Assets navigator and its Canvas handoff. Keep one
repository Canvas, stable asset IDs, one placement per asset, and at most one set
membership. No code changes are part of this planning task.

## Contract and inspected evidence

- [`r/ui.md`](../../r/ui.md) owns selection, catalog/filesystem boundaries,
  placement, lifecycle, and set semantics.
- [`product-patterns-and-test-audit.md`](../product-patterns-and-test-audit.md)
  records product references and existing test evidence. Its passing results do
  not prove the new combined workflows below.
- `frontend/src/routes/canvas.tsx` passes the authoritative selection, visible
  IDs, reveal requests, refresh signal, and action requests into `LibraryPanel`.
  Its Assets drop handler calls `ImageService.PlaceImages` with an optional set
  ID, then selects Canvas nodes or the target set after success.
- `frontend/src/components/canvas/library-panel.tsx` already has search, state,
  placement, tag, saved views, sort, and All Assets/Folders modes. Folders bypasses
  semantic filters. Reveal currently resets filters; mode switching retains
  local query state but needs explicit selection and restoration rules.
- `frontend/src/lib/asset-views.ts` supports Recent, Oldest, Name ascending, and
  Name descending. Equal keys need a stable asset-ID tie-breaker.
- `asset-list.tsx` supports range/toggle selection and selected-row drag. Listing
  failures currently use the route error callback; a dedicated listing recovery
  state is needed. Saved-view loading has a separate retry boundary.
- Folder moves currently use per-asset `MoveFile` calls. Partial success is
  possible. Rename must use the asset's actual parent path, not an unrelated
  remembered folder. These are review targets, not changes made by this plan.

The working tree contains in-flight work. Re-read these files before
implementation; do not replace or revert that work.

## 1. Catalog query and presentation

All Assets is a semantic catalog, not a folder listing. Combine text search,
placement, one tag, and state with AND. Preserve the existing service search
fields; document and test those fields before adding new search syntax.

| Control | Proposed rule |
| --- | --- |
| Search | Keep entered text during refresh, drawer close/open, mode switches, and retry. Ignore obsolete responses from earlier queries or repositories. |
| Placement | All placements, Placed, or Unplaced. Placement does not mean set membership. |
| Tag | All tags or one stable tag ID. A deleted/unavailable tag must not silently broaden the query. Offer removal of that filter. |
| State | Active excludes archived and trashed assets; All includes every catalog record; Archived excludes trash; Trash includes trashed records; Missing matches unavailable files regardless of lifecycle state. Active can include missing records. |
| Sort | Recent, Oldest, Name ascending, Name descending; resolve equal keys by stable ID. Sorting changes order, not membership or selection. |
| Filter chips | Show each active constraint, including search. Remove one without resetting others. Clear filters returns to Active, all placements, all tags, and empty search; preserve sort/layout. |
| Saved view | Save query, sort, and layout only. Never save selection, folder, drag state, or Canvas placement. Mark an edited saved view as modified. |

Keep the contract's default compact thumbnail-and-filename rows without
checkboxes or metadata columns. Optional gallery/view work must remain an
explicit presentation choice, not make metadata overlays mandatory.
Show result count separately from selected count. Keep accessible labels,
selected states, focus cues, and translated plural messages.

## 2. Selection, bulk actions, and drag ownership

Use the route's single active selection context. Inspector does not create a
second selection. IDs, not row indices or filenames, define selected assets.

| Gesture/action | Result |
| --- | --- |
| Plain click | Replace Assets selection and set the range anchor. Clear Canvas selection. |
| Shift-click | Select the inclusive contiguous range in the current filtered, sorted order. If the anchor is absent, select the clicked item and establish an anchor. |
| Ctrl/Cmd-click | Toggle one ID and update the anchor. No checkbox UI. |
| Select all | Select the complete current result set, not just mounted/visible rows. Folders selects files in the current directory, not descendants. |
| Query/folder change | After a successful load, intersect Assets selection with representable results. Report removed selection count; never leave hidden assets as silent bulk-action targets. |
| Sort/layout change | Preserve selected IDs; invalidate or rebase an absent range anchor. |
| Drag from selected item | Snapshot the active Assets IDs and repository identity at pointer-down. Drag that selection even if hover crosses another surface. |
| Drag from unselected item | Replace selection with that item, then drag it. |
| Cancel/rejected drop | Keep Assets ownership and selection; make no mutation. Clear transient drag feedback. |

Freeze or defer query/selection changes during a drag. Do not derive drag IDs
from whichever surface happens to be active at drop time. Reject foreign-repo,
malformed, stale, or empty payloads. Deduplicate IDs. Text inputs retain native
selection, clipboard, and Delete behavior.

Bulk commands act on the explicit selected IDs, with one count and one clear
scope. Preserve the contract: Assets Delete trashes; Canvas Delete unplaces;
Shift+Delete confirms permanent purge. Restore and lifecycle actions must show
eligibility for mixed selections, not silently skip unknown items. Purge uses a
snapshot of the deduplicated final count and requires confirmation.

## 3. Drop destination rules

| Destination | Mutation and follow-up |
| --- | --- |
| Canvas background | Place unplaced assets at the drop position. Already placed assets retain one node; preserve their stored position and offer Go to rather than duplicate them. Do not change set membership. Select the resulting visible Canvas representation. |
| Collapsed set | Place unplaced assets and assign membership as one operation. Move membership from another set when needed; remove an emptied source set. Select the target set and let Inspector show its context. |
| Expanded set target | Provide an explicit set drop zone with the same membership semantics. Dropping onto an ordinary member image must not imply set membership unless that zone is active. |
| Folder/breadcrumb | Move files; preserve IDs, metadata, placement, relationships, and sets. Keep Assets active and reveal the moved result in the destination folder. |
| Invalid destination | Show a rejected target and reason. Do not reinterpret an internal Assets payload as external file import. |

Set drops do not create relationships. Ctrl/Cmd relationship gestures remain
Canvas-only. Highlight the destination and show the intended operation and
asset count before release. Missing and trashed assets remain selectable for
inspection and recovery but cannot be placed; allow archived assets with bytes.
Reject an ineligible placement batch before mutation and explain how to refine
selection. Do not silently place only part of it.

Transfer ownership only after confirmed placement success. If an asset is
represented by a collapsed set, select that visible set rather than invisible
member nodes. Preserve the existing pinned/unpinned drawer policy; drawer
closure must not hide an error or steal focus before the mutation succeeds.

## 4. All Assets, Folders, reveal, move, and rename

- Retain All Assets query/view/sort/layout and its scroll anchor separately from
  Folders' current directory and scroll anchor. Switching mode does not clear
  either context or copy semantic filters into Folders.
- The two modes share one selection. Keep IDs representable in the destination;
  remove others after successful listing. Returning restores navigation/query
  state, not an old hidden selection. Keep the Inspector count consistent.
- Folders shows filesystem directories and present media. Exclude `.loom`.
  Missing records remain discoverable through All Assets and Inspector, not as
  fabricated physical files. Unsupported files must not look like registered
  assets. Verify the current directory API's handling of trash paths.
- **Reveal in Folders** is a single-asset command: navigate to its real parent,
  select and scroll to it, and preserve the prior All Assets query. If bytes are
  missing, reveal the nearest existing parent and explain why no row is selected.
- **Find in Assets** can temporarily bypass constraints that hide its target.
  Show that reveal context with a Return to previous view action; do not silently
  overwrite a saved view. **Go to Canvas** is enabled only for placed assets and
  centers their visible node/set representation.
- Rename is a single-file operation. Keep its real parent, stable ID, extension
  rules, and metadata. Reject separators, invalid names, and collisions visibly;
  never overwrite another file. Escape cancels; Enter commits once.
- Move supports folder drop and an accessible destination command. Preflight
  destinations and collisions. Prefer an atomic batch boundary; if unavailable,
  report completed and failed IDs explicitly and refresh authoritative results.
  Never call a partial move a success or retry already completed moves blindly.
- External rescans and rename/move races must preserve identity where the
  existing service contract permits it. If a folder disappears, show recovery
  and a parent-navigation action instead of resetting to root without notice.

## 5. Outage and retry behavior

Distinguish loading, successful empty results, failed first load, and stale
results after refresh failure. Keep query, folder, scroll anchor, selection, and
drawer state through an outage. Never clear selection because a request failed.

- Show an inline error with **Retry listing**. Keep last successful rows visible
  but label them stale. Disable mutation and Select all until their scope is
  verified; do not present stale counts as current results.
- Retry the latest query/folder, not the failed request's obsolete parameters.
  Cancel or ignore superseded responses, including repository switches.
- Tag loading and saved-view loading have separate status and retry actions.
  A saved-view failure must not block basic catalog browsing or overwrite stored
  views with defaults. Keep existing save-error/retry semantics distinct.
- Do not automatically replay mutations after an outage. If a placement or move
  reply is lost, refresh and reconcile by stable ID first. Retry unresolved work
  only when its service operation is safe; otherwise request user confirmation.
- Announce loading/errors without repeated alerts. A successful retry clears the
  error and reconciles selection against the confirmed result set.

## 6. Product inspiration, with Loom limits

- **Figma layers:** Borrow fast name lookup, range/toggle selection, reveal of a
  selected canvas object, and clear active-item focus. Do not make Assets a layer
  stacking list: catalog sort must not change Canvas z-order or create nesting.
- **Lightroom catalog:** Borrow the separation of semantic queries from physical
  folders, visible active filters, reusable views, and clear missing-file
  recovery. Do not add boards, multiple catalogs per repository, or multi-set
  collection membership through this work.
- **PureRef hierarchy:** Borrow compact set representation, an explicit drop
  target, and a reliable way to locate members on a crowded Canvas. Use Inspector
  and set expansion first. A full nested hierarchy, arbitrary ordering, and
  spatial frames remain out of scope.

These are interaction references, not claims of identical product behavior or
permission to copy implementation code. Use the audit's official documentation
links for research; verify exact Figma Layers behavior before implementation.

## 7. Action catalog deltas and Inspector follow

Keep one action catalog for command palette, dock, context menu, and shortcuts.
Reuse existing mode, search, selection, archive/trash/purge, navigation, and view
actions instead of parallel local command logic. Check current IDs before adding.

| Delta | Enablement/scope |
| --- | --- |
| Clear Assets filters / focus filter controls | All Assets; retain sort and layout. |
| Select all results | Assets active and current listing confirmed; label result scope/count. |
| Reveal in Folders / Rename | Exactly one eligible asset; Rename requires a present writable file. |
| Move selected assets | Assets selection with present movable files; show destination and count. |
| Go to Canvas / Find in Assets | Stable-ID navigation; use visible collapsed-set representation where needed. |
| Place selection / Add selection to set | Same eligibility and one-placement semantics as drag; accessible alternative to drag. |
| Retry listing / tags / saved views | Only the failed boundary; keep distinct labels and disabled reasons. |
| Return to previous Assets view | Only during temporary reveal context. |

Inspector follows Assets single/multi-selection, then Canvas node/set context
after a successful drop. Multi-selection shows count and common/bulk-editable
metadata, not another item list. Opening, editing, or retrying Inspector does
not transfer selection ownership. Guard metadata requests against stale replies
and asset removal. Empty selection shows useful context without retaining a
previous asset's editable fields.

## 8. Empty states

| State | Message/action direction |
| --- | --- |
| No registered assets | Import files or rescan; explain that Assets import leaves items unplaced. |
| No query matches | Show active constraints; Clear filters. Do not imply the repository is empty. |
| Empty folder | Show current path, parent navigation, and import/move guidance. |
| No unplaced assets | Explain that all matching assets are placed; offer All placements. |
| Empty Trash | Explain trash scope without offering irreversible actions. |
| No missing assets | Confirm no missing files match this query. |
| Failed load | Error and Retry, never a successful-empty message. |
| Selection removed by confirmed filter change | Update count and Inspector; announce the change without a modal. |

## 9. Sequence-level E2E acceptance

Use the existing isolated Playwright harness and discover ports, fixture roots,
and runtime configuration from tracked harness code. Do not hard-code a local
environment. Use stable asset IDs and accessible controls; assert selection,
Inspector context, service-visible state, and rendered representations. Prefer
condition waits to sleeps. Existing individual tests remain useful, but add
these complete workflows:

1. **Filter → select → drag → expand set → verify.** Seed distinct tags, states,
   names, and placements. Search, choose Active/Unplaced/tag, sort by name, select
   a Shift range, toggle one item, and assert exact IDs/count. Drag from a selected
   row onto a collapsed set. Verify one placement per ID, target membership,
   Canvas ownership, and set Inspector. Double-click to expand; verify exact
   members, stored placement, and unchanged outsiders. Reload and verify state.
2. **Canvas background and repeat drop.** Filter to unplaced assets, select all
   results, drop on background, and assert selection handoff. They disappear from
   the Unplaced result after refresh. Reveal an already placed asset and drop it
   again; assert no duplicate node and no unintended membership/position change.
3. **Move membership.** Filter/select assets from two sets plus an ungrouped asset,
   drop onto the target set, expand, and verify exact membership. Verify emptied
   source-set cleanup and no new relationship edges.
4. **Drag ownership and cancellation.** Begin with Canvas selected, choose Assets,
   build a range/toggle selection, and drag from selected versus unselected rows.
   Verify exact payload effects. Cancel or reject the drop; verify Assets stays
   active and no mutation occurs. Repeat with the drawer pinned and unpinned.
5. **Mode preservation and physical edits.** Set a query/sort/view, switch to
   Folders and back, and assert restored context plus representable selection.
   Reveal one nested asset, rename it, move it by folder drop, and verify path,
   bytes, ID, placement, metadata, and relationships. Test collision and partial
   failure reporting without overwrites or duplicate retries.
6. **Outage → retry → continue.** Fail a listing after successful results. Verify
   stale indication, preserved query/selection, disabled unsafe actions, and no
   empty-state claim. Change query during the failure, restore service, retry,
   and verify only the latest result wins. Complete filter/select/set-drop/expand
   afterward. Independently fail tags and saved views; basic browsing must work.
7. **Lost mutation reply.** Apply placement but fail its response. Verify no early
   ownership transfer; reconcile and confirm exactly one placement before any
   retry. Cover partial folder moves with explicit per-ID outcomes.
8. **State and bulk-action boundaries.** Cover Active, All, Archived, Trash,
   Missing with tag and placement intersections. Verify absent range anchors,
   equal-key sorting, Select all beyond mounted rows, filtered-away selection,
   missing/trashed drop rejection, Assets trash versus Canvas unplace, and purge
   confirmation cancellation/count.
9. **Keyboard and Inspector.** Run equivalent select/place/add-to-set/reveal
   commands without drag. Verify text fields retain native shortcuts, hidden
   drawers do not receive focus, Inspector never owns selection, and retry/empty
   states expose accessible labels in list and supported gallery presentation.

Keep Bun tests limited to pure query matching, deterministic sorting, selection,
and payload normalization helpers. Use service tests for batch validation,
identity preservation, collision rejection, membership atomicity, and placement
idempotence. UI behavior remains Playwright's job.

## Delivery order and completion gate

1. Confirm query/state semantics and service eligibility; add deterministic scope
   and sort helpers without changing product boundaries.
2. Add independent listing recovery and latest-request guards, then mode/reveal
   restoration and explicit selection reconciliation.
3. Unify drag and command eligibility; add drop feedback and safe move/rename
   handling with explicit partial-failure outcomes.
4. Add Inspector, action catalog, and empty-state behavior through existing
   boundaries. Run the complete sequences above plus existing regression tests.

Complete only when workflows survive refresh/reload/outage, preserve identity
and one-placement/one-set invariants, expose no hidden bulk-action scope, and
produce clear recovery without replaying destructive work. Record actual test
results separately; this proposed plan does not claim verification.

## Implementation notes — slice 1 (Assets navigator)

- Added per-filter chips including search and a Clear filters action. Clearing
  returns the catalog to Active/all placements/all tags/empty search while
  leaving sort and layout unchanged.
- Added Select all results for the complete currently rendered catalog result,
  plus a selected count. Existing row click behavior provides Shift range and
  Ctrl/Cmd toggle selection.
- Added specific empty messages for missing, trash, and unplaced result scopes.
- All Assets and Folders continue to use separate local query/filter and folder
  state; this slice does not change Canvas or drag/drop behavior.
- Earlier verification reported a passing typecheck before the final folder
  select-all adjustment, then an unused `field` error in `detail-panel.tsx:519`.
  The Inspector file is in flight and has changed since that report: line 519
  no longer declares `field`. The error is not attributable to the Assets
  changes; its current status has not been checked.

## Slice 1 static review

**Verdict: changes needed.** This review did not run a build, typecheck, or
Playwright. Findings describe source behavior, not runtime test results.

- The controls pass search, placement, state, and tag ID to `ListImages`.
  Missing requests state `all`, then filters `row.missing` on the client;
  Archived and Trash use their store states. Folder mode bypasses these filters
  and intersects catalog IDs with the current directory's files.
- `internal/store/library.go` joins the unparenthesized unplaced predicate
  `canvas_x IS NULL OR canvas_y IS NULL` with other predicates using `AND`.
  SQL precedence lets rows bypass search or tag constraints. The client
  rechecks state and placement, but not search or tag. Fix the predicate and
  cover intersections before treating these filters as verified.
- The local select-all button uses all `sortedRows`, not only viewport rows,
  and folder mode limits them to the current directory. The route's active
  surface shortcut uses the same IDs via `visible.current` after a successful
  load. During a query or folder change, and after a load error, both retain
  prior results; select-all can target the old scope. The shortcut's enablement
  also considers Canvas nodes when Assets is active. Selection is not
  reconciled when results change, so hidden selected IDs remain action targets.
- Counts use Lingui plural macros and row options expose selected state.
  However, status and placement chips render raw English values, and the
  fallback tag label is untranslated. Chip names do not say that activation
  removes a filter. The selected count is not announced as a live update.
- The list has translated scope-specific empty text, but gallery mode always
  shows the generic filter message, including for an empty repository, Trash,
  Missing, and Unplaced. The list's unplaced message can mask an empty Trash
  when both constraints are set. Neither presentation distinguishes loading or
  failed listings from a successful empty result. Folder guidance and the
  unplaced All placements action remain incomplete.

**Next slice: drag/drop.** Review payload ownership, eligibility, cancellation,
Canvas and set handoff, and folder-move partial failures against sections 2–4.
Keep the query and selection findings above visible as prerequisites for safe
bulk operations. Canvas is owned by the concurrent Canvas workers.

## Slice 1 review fixes

- Grouped the unplaced SQL predicate so search, tag, and lifecycle conditions
  apply to both unplaced cases.
- Selection is reconciled against each successfully loaded result set. Select
  all is disabled while a load is pending or has failed.
- Added loading and listing-failure messages to the list view. Gallery mode
  uses the list empty state when it has no results. Filter chips use translated
  labels, and list empty messages distinguish unplaced results and other scopes.
- Verification: `cd frontend && bunx tsc --noEmit` passed.
  `nix develop -c go test ./internal/store` passed. Playwright was not run.

## Implementation notes — slice 2a (Assets drag source)

- The list drag source keeps `application/x-loom-assets` as the authoritative
  stable-ID payload and adds a plain-text count for native drop-target
  interoperability. It snapshots the current Assets selection at drag start;
  dragging an unselected row sends only that row and updates Assets selection.
- Missing and trashed rows cannot start a drag. Archived rows remain eligible.
- The browser owns Escape and outside-drop cancellation. A cancelled or rejected
  drag performs no source-side mutation and does not change selection ownership.
- The custom drag image shows the batch count. Gallery drag source behavior and
  Canvas drop handling are outside this slice.
- Verification: `bunx tsc --noEmit` pending. Playwright was not run.

## Slice 2b static review

**Verdict: changes needed.** This is a source review only. No build, typecheck,
or Playwright run was performed for this review.

- List and gallery send the same selected stable IDs, text count, effect, and
  count preview. Both block a missing or trashed drag origin. A mixed selection
  can still contain such IDs; Canvas preflight rejects the entire batch.
- Canvas converts screen coordinates with `screenToFlowPosition`. The service
  places new assets at that point with a six-column offset and preserves existing
  coordinates. Already placed IDs still consume offset slots.
- A collapsed-set drop makes one `PlaceImages` call. Its transaction places
  assets, moves existing membership, removes empty sets, and repairs covers.
  The service checks trash inside the transaction, but the missing-file check is
  only a preflight; file state can change before commit.
- **Blocking:** the successful Canvas drop never calls `reload()`. The stored
  placement or membership changes, but Canvas data and the Assets refresh signal
  stay stale. New nodes and set membership may not render until another refresh.
  A background drop also selects member IDs even when their visible
  representation is a collapsed set.
- Payloads contain IDs but no repository identity. Foreign-repository IDs can
  resolve to unrelated local assets. Empty custom payloads fall through to the
  external-file path. Drag state is captured at drag start, not pointer-down,
  and query/selection changes are not frozen during a drag.
- Folder moves use settled per-ID operations and report failed IDs and a success
  count after `change()`. They do not report completed IDs explicitly. If the
  refresh fails, its error masks the move outcomes, so the user cannot identify
  which moves succeeded or failed. Folder payload validation also accepts empty
  arrays and nonpositive IDs.
- Drop target feedback, expanded-set drop zones, and an accessible placement
  alternative remain outside this implementation. Existing listing/selection
  recovery findings also remain relevant.

**E2E leftovers:** Run the sequences in section 9 after fixes, especially list
and gallery mixed-eligibility batches; zoomed/panned background placement and
repeat drop; multi-set membership move and empty-set cleanup; collapsed-set
selection handoff; cancellation and foreign-repository payload rejection; and
partial folder moves with both successful and failed refresh. Verify reload and
persisted state, not only the immediate UI.

## Implementation notes — slice 2b (drop side)

- Gallery cards now match list drag eligibility and payload behavior: stable IDs,
  selected-batch snapshots, plain-text count, and a batch drag preview. Missing
  and trashed cards cannot start a drag.
- Canvas drops deduplicate and validate IDs, reject unavailable/missing/trashed
  assets before mutation, and use the drop point for placement. Dropping on a
  collapsed set passes its ID to the existing atomic `PlaceImages` operation,
  which preserves existing positions and moves membership (including empty-set
  cleanup). Successful drops transfer selection to Canvas/set; a failed drop
  does not transfer ownership.
- Dropping onto the Unplaced Assets list is not implemented as a destination;
  it has no drop handler and therefore performs no mutation.
- Folder moves now settle independently, refresh authoritative rows, and report
  failed stable asset IDs instead of treating partial success as full success.
- Verification: `bunx tsc --noEmit` pending. Playwright was not run.

## Slice 2b review fixes

- Successful Canvas asset drops now use `reload()` before transferring selection.
  The reload refreshes Canvas data and the Assets listing signal, so persisted
  placement and membership are visible before selection handoff.
- Background drops select a collapsed set node instead of its hidden member
  nodes. Drops onto a set select that set directly.
- Loom drag payloads now include the source repository path. Canvas and folder
  drops reject payloads from another repository with a reason.
- Folder moves report per-ID outcomes before refreshing. A refresh failure is
  reported after those outcomes and does not hide which moves succeeded or
  failed.
- Verification: `cd frontend && bunx tsc --noEmit` passed. Playwright was not
  run.
