# Unified floating panel (no top bar), session-scoped undo (incl. groups), live-dir Explorer + FS management, multi-window repo switching, settings, drag-and-drop

Implementation plan — companion to `docs/panel-unification.md` (the spec-level addendum
explaining *why*, in `docs/init.md`'s voice). This file is the concrete, stage-by-stage
build plan: not yet implemented as of writing. A fresh session can pick this up directly —
each stage names the exact files/functions/types involved.

## Context

The reported problems, and the decisions made resolving them through several rounds of clarification:

1. **Undo/redo reaches across app restarts** — `operation_log` has no session boundary.
2. **Library and Detail aren't on the same panel; no drag-to-canvas; no Explorer** — Board and Library are separate routes today.
3. **No ctrl+click-to-detail gesture.**
4. **Trash/Archive are buried** in context menus and a bulk-bar, not the toolbar.
5. **The Library filter `<select>`s show a double border.**

Resolving these surfaced two real inconsistencies against `docs/init.md` (the project's design spec), now reconciled — **the floating-panel mechanics follow the spec's explicit "floating overlay (not a layout sibling)" line** (confirmed with the user), and **the double-border fix is a proper `components/ui/select.tsx`** wrapping `@base-ui-components/react/select` (already a dependency, already the pattern `button.tsx` uses), not a native-`<select>` patch. `docs/init.md` itself stays unedited; `docs/panel-unification.md` is the addendum recording these decisions in spec form.

Scope then expanded through further discussion, each confirmed with the user:

- **Explorer is a live OS-directory browser**, not a client-side grouping of DB rows — needs a new backend directory-listing API, **and must be lazy-loaded and virtualized** (folders fetch children only on expand; only in-viewport rows render, via `@tanstack/react-virtual`).
- **FS management is in scope**: directory listing, **physical trash-move** (confirmed via research: `SetTrashed` today only flips a DB flag — the spec says it should move the file into `.loom/trash/`, and it doesn't), and **in-app rename/move**. Hash-based reconciliation ("manual rescan") stays deferred.
- **All panel tabs persist state** — Library/Explorer/Detail stay mounted, not torn down on tab-switch or panel hide.
- **`TopNav` is removed entirely.** Everything it held gets a new home:
  - **Undo/Redo**: no buttons anywhere — keyboard shortcuts only (already wired), plus new entries in a **new pane-level (canvas-background) right-click context menu**, since no such menu exists today (only per-node context menus do).
  - **Repo name label**: dropped from the UI entirely.
  - **Repo identity/switching**: replaced by a **select at the bottom of the floating panel** showing the current repo, expandable to show other repos (open elsewhere, or recent-but-closed) with full live cross-window tracking — confirmed via reading the actual Wails v3 source that this is buildable with real APIs.
  - **Board switcher**: moves to the **top of the floating panel** (proposed default — not explicitly specified by the user, flagged here for correction if wrong).
  - **Layout mode (Manual/Auto)**: moves into a **new Settings screen**, presented as a gear-icon-triggered modal (not a panel tab) — nothing like this exists today, built from scratch.
  - **"Auto-arrange selection"**: toolbar + node context menu (same treatment as "Group as set").
  - **"Group as set"**: toolbar (enables the currently-disabled Group button), node context menu (when the right-clicked node is part of a ≥2 selection), and a new Ctrl/Cmd+G shortcut.
  - **Zoom-percent readout**: no work needed — `ZoomControls` already renders it inline; `TopNav`'s copy was redundant.

**Two further findings from an explicit undo-coverage and component-consistency audit:**

- **Group mutations have zero undo/redo support today** — confirmed via code: `GroupService.CreateGroup`/`Ungroup`/`AddMember`/`RemoveMember`/`SetCover` (`internal/service/group_service.go`) are the *only* mutating service methods in the whole codebase that never call `recordOp`, and the code's own comment flags this as a deliberate-but-incomplete scope cut. `docs/init.md`'s own undo minimum (Stage 5) never lists groups either. Since the user asked for create/dismiss specifically, and leaving the other three (`AddMember`/`RemoveMember`/`SetCover`) as the only remaining unrecorded mutations would just reproduce the identical gap right next to the fix, **all five get undo coverage**, not just create/dismiss.
- **A second real component-consistency bug, same shape as the double-border one**: `frontend/src/components/board/board-switcher.tsx` has two raw `<button>`s (lines 70-73, 158-161) that hand-replicate `Button`'s `ghost` variant (`bg-transparent text-ink hover:bg-black/[0.04]`) instead of using the shared `Button` component — the exact same "reinvented styling instead of reusing the primitive" pattern that caused the select bug, just without a visible rendering defect (yet). Fixed alongside `board-switcher.tsx`'s relocation into the floating panel. Everything else flagged by the audit (~28 other raw `<button>`s, 7 raw `<input>`s with no shared `Input`/`Checkbox` component anywhere) are either genuinely one-off icon/link buttons or a broader latent-drift risk with no active bug — **not actioned in this pass**, noted in Risks.

## Approach

Twelve stages, dependency-ordered:

### Stage 1 — Undo/redo session-scoping (backend only)
New `internal/store/session.go`: package-level `map[string]int64` (repo path → boundary seq), guarded by a mutex — every service call opens a fresh `*Repo` via `store.Bootstrap`, so there's no existing per-process state to hook into. `(r *Repo) undoSessionBoundary()` lazily computes `MAX(seq)` from `operation_log` the first time a path is seen this process. Modify `PeekUndo`/`PeekRedo` (`internal/store/oplog.go`) to return `nil` once the cursor has receded to (or the redo target sits at-or-before) that boundary.

### Stage 2 — Group create/dismiss/membership undo coverage (backend only)
All five `GroupService` methods (`internal/service/group_service.go`) get wired into the existing `OpStep`/`recordOp` machinery in `internal/service/undo_service.go`, following the file's established patterns:

- **Create/Ungroup** share one step kind, `stepGroupExistence`, mirroring the boolean-toggle idiom already used by `stepSetArchived`/`stepSetTrashed`: payload `{GroupID, Exists bool, Name, Kind string, CoverImageID int64, MemberIDs []int64}`. `CreateGroup`'s forward is `{Exists:true, ...the created group's actual assigned ID and fields}`, inverse `{Exists:false, GroupID}`. `Ungroup`'s forward is `{Exists:false, GroupID}`, inverse `{Exists:true, ...fields captured by reading the group *before* deleting it}`. Because the group's ID is DB-autogenerated, redoing a create (or undoing an ungroup) must re-insert with that *same* ID rather than allocating a new one — add an unexported `repo.recreateGroup(id, name, kind, coverImageID, memberIDs)` (explicit-ID insert) alongside the existing auto-ID `CreateGroup`, used only by `applyStep`'s `Exists:true` case. `applyStep` guards each member ID with the existing `repo.ImageExists`/`purgedErr` pattern before recreating.
- **AddMember/RemoveMember** mirror `stepTagAdd`/`stepTagRemove` exactly: new `stepGroupMemberAdd`/`stepGroupMemberRemove`, payload `{GroupID, ImageID}`.
- **SetCover** mirrors `stepSetArchived`'s toggle pattern: new `stepGroupSetCover`, payload `{GroupID, CoverImageID}`. The service method must read the group's current cover before changing it (to build the inverse), same as how archive-toggle already knows prior state from its caller.

### Stage 3 — Backend FS-management primitives
- **Directory listing**: new `(r *Repo) ListDirectory(relPath string) (DirListing, error)` — non-recursive `os.ReadDir` over one directory under the repo root (clamp any path that escapes the root). For media files found, mirror `ScanAndRegisterImages`'s `INSERT OR IGNORE INTO images (file_path)` scoped to that directory, so every listed file always has a real DB row — Explorer can reuse the same `ImageInfo`/`LibraryRow` shape as Library, and drag-and-drop never special-cases "not yet imported." Exposed as `ImageService.ListDirectory(repoPath, relPath)`.
- **Physical trash-move**: modify `(r *Repo) SetTrashed(imageID int64, trashed bool) error` (`internal/store/image.go:191-196`) to move the file between its current path and `.loom/trash/<relative-path>` (creating parent dirs, collision-suffixing) in addition to the flag update. `TrashImage`, `RestoreImage`, and undo's `applyStep(stepSetTrashed, ...)` all funnel through this one function, so this single fix makes trash/restore/undo-trash/undo-restore all physically correct.
- **Rename/move**: new `(r *Repo) MoveFile(imageID int64, newRelPath string) (oldPath, newPath string, err error)` (`os.Rename` + `file_path` update). New `ImageService.MoveFile(repoPath, imageID, newRelPath)`. New op-log step `stepMoveFile` (`moveFileStepPayload{ImageID, OldPath, NewPath}`), following the same `OpStep` pattern as Stage 2's additions.

### Stage 4 — Generic SettingsService (backend)
New `internal/service/settings_service.go`: thin `Get(repoPath, key) (string, error)` / `Set(repoPath, key, value string) error` over the existing `settings` table (`scope='repo'` — the schema's `CHECK` constraint already limits it to that scope, no migration needed). Used by: panel visibility/dock-side (Stage 7), and the Settings screen (Stage 11). Layout mode itself keeps using its existing dedicated `boards.layout_mode` column and `BoardService.SetLayoutMode` — the Settings screen just calls that existing method, it doesn't route layout mode through the generic key-value store.

### Stage 5 — Multi-window repo tracking (backend)
Grounded directly in the installed Wails v3 beta source (`~/go/pkg/mod/github.com/wailsapp/wails/v3@v3.0.0-beta.4/pkg/application`): `Window` interface exposes `Focus()`, `ID() uint`, `OnWindowEvent(eventType events.WindowEventType, callback) func()`; `WindowManager` exposes `GetByID(id) (Window, bool)`, `NewWithOptions(...) *WebviewWindow`; `events.Common.WindowClosing` is the close-event constant. `application.Get().Window.Current()` (already used in `repo_service.go:78`) resolves the calling window. A window's `Name` is set once at creation and can't be renamed later, so tracking by name doesn't work for the app's initial (repo-less-at-launch) window — hence a small explicit registry instead:

New `internal/service/window_registry.go`: package-level `map[string]uint` (repo path → window ID) + mutex. `registerRepoWindow(repoPath, window)` records the mapping and calls `window.OnWindowEvent(events.Common.WindowClosing, ...)` to delete the entry on close. `focusedWindowForRepo(repoPath) (application.Window, bool)` looks it up via `Window.GetByID`.

Modify `internal/service/repo_service.go`:
- `open(path)`: check `focusedWindowForRepo(path)` first — if found, `.Focus()` it and return `RepoInfo{OpenedElsewhere: true}` (new field) so the calling window's frontend knows not to navigate itself into that repo. Otherwise, proceed as today, then `registerRepoWindow(path, application.Get().Window.Current())`.
- New `SwitchTo(path string) (*RepoInfo, error)`: used by the panel's repo-switcher (Stage 10) when picking a *different* repo than the one already open in the calling window — this window must never navigate away from its own repo, so this method never reuses "current window." If already open elsewhere, focus it (`OpenedElsewhere: true`). Otherwise, bootstrap the repo, then `application.Get().Window.NewWithOptions(...)` a brand-new window with `URL: "/?openRepo=" + url.QueryEscape(path)`, register it, return `OpenedElsewhere: true` (meaning: a window now shows it, but not this one).
- `ListRecentRepos`: add `IsOpen bool` per entry via `focusedWindowForRepo`.

Frontend: new bootstrap check (in `frontend/src/routes/index-route.tsx` or `root.tsx`) for an `?openRepo=` query param — on match, calls `RepoService.OpenRecent`, `setCurrentRepo`, and navigates straight to `/board`, bypassing the Landing page for windows spawned this way.

### Stage 6 — Select component
New `frontend/src/components/ui/select.tsx`: `Select`/`SelectTrigger`/`SelectContent`/`SelectItem` wrapping `@base-ui-components/react/select`'s `Root`/`Trigger`/`Popup`/`Positioner`/`Item`, styled via `cva` to match the existing pill filter look, following `button.tsx`'s `useRender` composition pattern. Removes the double-border at the root — no native `<select>` chrome exists to fight a custom border. Applied when the filters move into `LibraryPanel` (Stage 7).

### Stage 7 — Floating panel shell, Library moved in, TopNav removed
- Delete `frontend/src/routes/library.tsx` + `library-route.tsx`; remove `libraryRoute` from `router.tsx`.
- **Delete `frontend/src/components/top-nav.tsx` and its usage entirely** — no repo name, no undo/redo buttons, no board-switcher/layout-toggle/zoom slot.
- New `frontend/src/components/board/floating-panel.tsx` (`FloatingPanel`): `absolute`-positioned overlay (matching `CanvasToolbar`'s/old `SidePanel`'s treatment), dockable `left`/`right`, toggleable visible/hidden — both backed by new `settings` keys (`panel_visible`, `panel_dock_side`, Stage 4's `SettingsService`) with hardcoded defaults (`visible=true`, `left`) and no settings UI for them yet (matches the spec's own "defaults now, UI later" convention). **All three tabs (Library/Explorer/Detail) render simultaneously**, visibility toggled via CSS not conditional mounting, so state persists across tab switches and panel hide/show.
- Panel layout, top to bottom: **BoardSwitcher** (moved from `TopNav`'s children — while relocating, also normalize its two raw ghost-replicating buttons at `board-switcher.tsx:70-73,158-161` to `Button variant="ghost"`, per the audit finding above) → **Library/Explorer/Detail tab switcher** → active tab body → **repo select** (Stage 10) pinned at the bottom.
- `board.tsx`: canvas pane stays full-width/`relative flex-1`; `FloatingPanel` renders as another `absolute`-positioned sibling (like `CanvasToolbar`/`ZoomControls` already are), not a flex sibling — canvas stays fully interactive underneath for Stage 12's drag-and-drop.
- New `frontend/src/components/board/library-panel.tsx` (`LibraryPanel`): old `library.tsx`'s table/filter/bulk-bar content, using the new `Select` (Stage 6). Drop the `/library`-route cross-navigation in favor of `onRevealOnCanvas(imageId)` when already a board member; keep cross-window/cross-board navigation only when genuinely elsewhere.
- `board-route.tsx`: remove/reword the "Go to library" empty-state button.

### Stage 8 — Explorer tab (live directory browser, lazy-loaded and virtualized)
New dependency: `@tanstack/react-virtual` (pairs naturally with the already-present `@tanstack/react-router`, same maintainer ecosystem). New `frontend/src/components/board/explorer-panel.tsx`:
- **Lazy-loaded**: starts at the repo root, fetches a directory's children via `ImageService.ListDirectory` (Stage 3) only when that folder is expanded (`expandedDirs: Set<string>` state) — never a big upfront recursive fetch.
- **Virtualized**: the tree is flattened into a single "currently visible rows" array (folder rows + file rows, computed from `expandedDirs` and each loaded directory's children — a folder collapses out its entire subtree from the flattened list, not just visually hides it), fed to `useVirtualizer` from `@tanstack/react-virtual`. Only rows actually in the scrollable viewport are rendered/mounted, regardless of how many folders happen to be expanded or how many files a directory holds — this is what makes lazy-loading and virtualization compose correctly (lazy-load bounds *fetches*, virtualization bounds *DOM nodes*, independently).
- File entries reuse the shared row component (Stage 9) with the same `ImageInfo`/`LibraryRow` shape as Library. Rename/move UI: drag a file row onto a folder row to call `ImageService.MoveFile`; inline rename action (context menu or double-click) same call.

### Stage 9 — Detail tab replaces floating `SidePanel`; ctrl/cmd+click
Move `SidePanel` (`board.tsx:850-1018`) into `frontend/src/components/board/detail-panel.tsx`, stripped of its own overlay chrome (the `FloatingPanel` already provides that). `Board` gains `detailImageId`/`activeTab` state; a `useEffect` keyed on `singleSelectedImage` sets both on a new single canvas selection, without fighting manual tab-switching. New shared `frontend/src/components/board/panel-image-row.tsx` (used by Library and Explorer) gets ctrl/cmd+click → `onDetailRequest(imageId)`, skipping normal row-selection; plain click unchanged. New `ImageService.GetImage(repoPath, imageID)` (via existing, currently-unused `store.Repo.ListImagesByIDs`) resolves a Detail image that isn't part of the loaded board.

### Stage 10 — Repo select, board switcher wiring
Bottom-of-panel repo select: shows current repo; opening it lists other repos from `RepoService.ListRecentRepos` (now carrying `IsOpen`), distinguishing "open elsewhere" from "recent." Selecting one calls `RepoService.SwitchTo` (Stage 5) — on `OpenedElsewhere: true`, the current window does nothing further (a toast confirming "Switched to existing window" is a reasonable touch, not required). Top-of-panel `BoardSwitcher`: reuse the existing component (with Stage 7's ghost-button fix applied), just relocated from `TopNav`'s children into `FloatingPanel`'s header.

### Stage 11 — Settings screen + pane-level context menu + Group/Auto-arrange wiring
- New `frontend/src/components/board/settings-modal.tsx`, triggered by a new gear icon in `CanvasToolbar` (own divided section at the bottom). Contents for this pass: the Manual/Auto layout-mode toggle (calls existing `BoardService.SetLayoutMode`, just relocated here from `TopNav`). Built on the new `SettingsService` (Stage 4) as the general mechanism, even though this pass's only settings-table-backed values are the panel-visibility/dock-side keys from Stage 7 (not surfaced in the UI yet — no control for them in this pass, per the "defaults now, UI later" convention already used elsewhere).
- New pane-level context menu: `onPaneContextMenu` on `<ReactFlow>` (doesn't exist today — only `onNodeContextMenu` does), new `paneMenu` state, items: Undo, Redo (calling the existing `UndoService.Undo`/`Redo` + `refreshUndoState`, same as the deleted `TopNav` buttons did).
- `canvas-toolbar.tsx`: enable the currently-disabled Group button (`ToolbarButton disabled title={t\`Grouping arrives in a later stage\`}`) → wire to `handleGroupSelection` (now undo-covered per Stage 2), `disabled={selectedImageIds.length < 2}`. Add an Auto-arrange button next to it, `disabled` unless `layoutMode === 'manual' && selectedIds.length > 0`, wired to the existing `handleAutoArrange`.
- `nodeMenuItems` (`board.tsx`): add a "Group as set" entry when the right-clicked node is part of a ≥2-image selection (`selectedImageIds.includes(imageId) && selectedImageIds.length >= 2`), and an "Auto-arrange selection" entry under the same condition when in manual mode.
- New keyboard shortcut: Ctrl/Cmd+G → `handleGroupSelection` when `selectedImageIds.length >= 2`, following `use-undo.ts`'s existing hook pattern (new `useGroupShortcut` or extend the existing hook file).

### Stage 12 — Drag-and-drop from panel onto canvas, toolbar Archive/Trash, selection unification
- Drag source: `panel-image-row.tsx` gets `draggable` + `onDragStart` (custom MIME type `application/x-loom-image-id`, single id or JSON array for a multi-selection drag).
- Drop target: canvas wrapper div gets `onDragOver`/`onDrop`, converts via `rfInstance.current.screenToFlowPosition(...)`, calls new `handleDropImages` reusing `BoardService.AddImagesToBoard` + `ImageService.SetPosition` (same pattern as `handleNodeDragStop`) — no new backend surface, since Stage 3 already guarantees every draggable row has a real image id.
- Selection unification: `Board` tracks `lastSelectionSource: 'canvas' | 'panel'`, flipped whenever either selection becomes non-empty; toolbar actions target whichever was touched most recently.
- `canvas-toolbar.tsx` Archive/Trash section: divider below the tool buttons, Archive/Unarchive + Trash (new `danger` prop on `ToolbarButton`), both `disabled` with no active selection — reusing existing `ImageService.SetArchived`/`TrashImage` calls, benefiting automatically from Stage 3's physical-move fix.

## Files touched

**Backend:** `internal/store/session.go` (new), `internal/store/oplog.go`, `internal/store/image.go` (`ListDirectory`, `SetTrashed` physical move, `MoveFile`), `internal/store/group.go` or equivalent (`recreateGroup` explicit-ID insert), `internal/service/image_service.go` (`ListDirectory`, `MoveFile`, `GetImage`), `internal/service/group_service.go` (all 5 methods gain `recordOp` calls), `internal/service/undo_service.go` (`stepMoveFile`, `stepGroupExistence`, `stepGroupMemberAdd`, `stepGroupMemberRemove`, `stepGroupSetCover`), `internal/service/settings_service.go` (new), `internal/service/window_registry.go` (new), `internal/service/repo_service.go` (`open`, new `SwitchTo`, `ListRecentRepos` `IsOpen`), `main.go` (register the new `SettingsService`).

**Frontend:** new dependency `@tanstack/react-virtual`; `frontend/src/components/ui/select.tsx` (new), `frontend/src/router.tsx`, `frontend/src/routes/library.tsx` + `library-route.tsx` (deleted), `frontend/src/components/top-nav.tsx` (deleted), `frontend/src/routes/board-route.tsx`, `frontend/src/routes/index-route.tsx` (`?openRepo=` bootstrap), `frontend/src/routes/board.tsx`, `frontend/src/components/board/floating-panel.tsx` (new), `library-panel.tsx` (new), `explorer-panel.tsx` (new), `detail-panel.tsx` (new), `panel-image-row.tsx` (new), `settings-modal.tsx` (new), `board-switcher.tsx` (ghost-button fix), `canvas-toolbar.tsx`, `frontend/src/lib/use-undo.ts` (or a new sibling hook for Ctrl+G).

## Risks / tradeoffs

- Deleting `/library` outright is low-risk given no bookmarkable URLs in a desktop webview; a redirect stub is a cheap safety net if wrong.
- No file-watcher exists — Explorer can go stale while a folder is expanded; mitigated by per-folder manual refresh, matching the app's existing manual-rescan-only posture elsewhere.
- Physical trash-move and rename/move touch the filesystem directly — need care around cross-device moves, permission failures, and name collisions.
- The multi-window registry is grounded in real, verified Wails v3 APIs (read directly from the installed module source), which meaningfully de-risks Stage 5 — but it's still new infrastructure with no precedent elsewhere in this codebase, worth extra manual QA.
- `lastSelectionSource` arbitration (Stage 12) is a simple recency heuristic — needs manual QA around edge cases.
- BoardSwitcher-at-panel-top and Settings-gear-in-CanvasToolbar are this plan's own defaults for two placements the user didn't explicitly specify — flagged for correction if they don't match expectations.
- Redoing a group create (or undoing an ungroup) re-inserts the group row with its original explicit ID (Stage 2) — safe under SQLite's autoincrement semantics (an explicit ID insert doesn't conflict with later auto-assigned ones), but worth a direct test: create a group, undo, redo, confirm the group's ID and all its edges/cover are identical to before.
- The component-consistency audit found a broader gap this pass does *not* fix: there's no shared `Input`/`Checkbox` primitive anywhere in the frontend — 7+ raw `<input>` elements are each hand-styled independently (`library.tsx`, `board.tsx`, `board-switcher.tsx`, `board-picker.tsx`, `tag-picker.tsx`). No confirmed active bug from this today (unlike the select case), but it's the same category of risk and worth a future pass if another rendering inconsistency turns up there.
- Explorer virtualization is new to this codebase (no prior use of `@tanstack/react-virtual` or any virtualization library) — worth confirming row-height assumptions (folder rows vs. file rows, if their heights differ) are handled correctly by the virtualizer's size-estimation.

## Verification

- `go build ./...` and `go test ./...` after Stages 1–5 (all new backend code, including both sets of new op-log steps and the window-registry addition).
- `cd frontend && bun run build` (or the project's type-check script) after each frontend stage.
- Manual, in the running app:
  1. Undo/redo: make a change, relaunch, confirm the prior session's change is no longer undoable but still reflected in data; confirm Undo/Redo now only appear via keyboard shortcut and the new pane right-click menu.
  2. Create a group, undo it, redo it — confirm the group and its members/cover are restored identically. Ungroup it, undo, confirm restoration. Add/remove a member and toggle cover, confirm both undo/redo correctly.
  3. Confirm `TopNav` is gone entirely — no repo name, no top bar of any kind.
  4. Floating panel: overlays the canvas without resizing it; BoardSwitcher at top, tabs, repo-select at bottom; switching tabs preserves each tab's state; toggle visibility and confirm state still persists.
  5. Explorer: expand folders, confirm live directory contents match disk and only expanded/visible rows are rendered (check DOM node count doesn't scale with total files); drag a file between folders and rename one, confirm both the file and `file_path` update correctly.
  6. Trash an image, confirm the file physically lands in `.loom/trash/`; restore it; undo a trash action; confirm all three move the file correctly.
  7. Ctrl/cmd+click a Library/Explorer row → Detail tab shows that image; plain click still toggles selection.
  8. Drag a Library/Explorer row onto the canvas → added to board at drop position; confirm node repositioning still works afterward.
  9. Multi-select 2+ images, confirm Group-as-set works from toolbar, node context menu, and Ctrl/Cmd+G; confirm Auto-arrange works from toolbar and context menu in manual mode.
  10. Open the Settings modal via the new toolbar gear icon, toggle layout mode, confirm it matches the old TopNav toggle's behavior.
  11. Multi-window: open a repo, use the repo-select to open a second repo in a new window, then switch back to the first from the second window's repo-select — confirm it focuses the existing window rather than opening a third.
  12. Select images via canvas and via the panel; use toolbar Archive/Trash; confirm disabled state with no selection.
  13. Visually confirm the Library filter dropdowns no longer show a double border; confirm `board-switcher.tsx`'s buttons look unchanged after the `Button variant="ghost"` swap.
