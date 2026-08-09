# Canvas node fixes: invisible nodes, delete-vs-trash, filename display, shortcut hints, stale Explorer

Implementation plan for the five issues logged in `.ref/0.md`. Not yet implemented as of writing — a
fresh session can pick this up directly from the file/line references below.

## Context

`.ref/0.md` lists five issues found after the recent resize feature (commit `4ea4c9c`) and the trash/explorer work (`23f56db`, `5b22215`):

1. Canvas nodes sometimes render invisible / without size after the resize change.
2. Delete/Backspace on the canvas sends images to trash; it should only remove them from the board, and that action should also be reachable from the context menu.
3. The always-visible filename footer on image nodes is unwanted; a filename should only appear on hover, gated by a settings toggle, with no footer at all.
4. Context menu items should show keyboard-shortcut hints using `<kbd>`, with the correct symbol for the user's OS.
5. A trashed image can still appear untouched in the Explorer panel.

Investigation found concrete root causes for all five, detailed below per item. Design questions resolved with the user: the node footer is removed entirely (no prompt/archived/missing text on the node body — the missing-file badge stays since it's a separate corner overlay, not the footer), the filename appears only on hover and only when the new setting is on, and `Kbd` is added via the shadcn/ui CLI, which the project now adopts as the standard way to add UI components going forward.

## 1. Invisible/sizeless nodes

**Root cause:** `board.tsx`'s node-building `useEffect` (lines ~359-419) sets each `FlowNode`'s top-level `width`/`height` to `img.canvasW || undefined` / `img.canvasH || undefined` for nodes that have never been resized (both image nodes and group nodes). `ReactFlow`'s `fitView` prop (`board.tsx:1280`, runs on mount) computes the viewport from node dimensions *before* the DOM `ResizeObserver` has measured anything, so a node with `width`/`height` still `undefined` at that moment contributes a degenerate (zero-size) box to the fit calculation — producing a bad initial viewport transform that can leave nodes scaled/positioned off-screen until something else forces a re-measure (drag, resize, zoom).

This is the same gap the existing comment at `board.tsx:570-582` already works around for drag hit-testing (`node.measured?.width ?? 150`) — it just isn't closed at node-creation time.

**Fix:** Give every node a concrete `width`/`height` from creation, never `undefined`, so `fitView` always has a real box to work with:
- Add shared constants `DEFAULT_NODE_WIDTH = 150`, `DEFAULT_NODE_HEIGHT = 110` in a small new `frontend/src/lib/node-size.ts` (this literal pair is currently copy-pasted in `image-node.tsx:27`, `group-node.tsx:142`, and twice more in `board.tsx:573-574,581-582` — consolidating removes the exact kind of drift that caused this bug).
- In `board.tsx`, change lines ~365-366 and ~386-387 to `width: img.canvasW || DEFAULT_NODE_WIDTH, height: img.canvasH || DEFAULT_NODE_HEIGHT` (and the group node's cover-based equivalent).
- Update `image-node.tsx:27` and `group-node.tsx:142`'s inline-style fallback and `board.tsx:573-574,581-582`'s hit-testing fallback to use the same constants instead of the repeated `150`/`110` literals.

## 2. Delete key should detach, not trash

**Current behavior:** `board.tsx:1255` wires `onNodesDelete={() => handleToolbarTrash()}`, and `deleteKeyCode={['Backspace', 'Delete']}` (`board.tsx:1279`) triggers it — so pressing Delete/Backspace always calls `ImageService.TrashImage` (soft-delete, moves the file to `.loom/trash/`). There's a separate, already-implemented "detach from this board only" primitive, `BoardService.RemoveImagesFromBoard(repoPath, boardID, imageIDs)` (`internal/service/board_service.go:114-127`, bound at `frontend/bindings/loom/internal/service/boardservice.ts:40-42`), which only deletes the board-membership row and leaves the file/DB record untouched. It's currently only used by `board-picker.tsx` and `detail-panel.tsx`, never from the canvas.

**Fix — keep both actions, retarget only the keyboard path:**
- Add `handleRemoveFromBoard(imageIds: number[])` in `board.tsx`, mirroring `handleTrash` (`board.tsx:850-859`) but calling `BoardService.RemoveImagesFromBoard(repo.path, boardId, imageIds)`, then clearing selection / closing Detail if needed / `loadBoard()`.
- Add `handleToolbarRemoveFromBoard`, mirroring `handleToolbarTrash` (`board.tsx:898-912`), operating on `activeSelectionImageIds`.
- Change `onNodesDelete={() => handleToolbarTrash()}` to `onNodesDelete={() => handleToolbarRemoveFromBoard()}`. This is the only behavior change to the Delete/Backspace key.
- Leave the **toolbar** Trash button (`onTrash={handleToolbarTrash}`, `board.tsx:1305`) and the existing "Trash" menu items untouched — clicking Trash explicitly still trashes.
- Add a new "Remove from board" item to `nodeMenuItems` (`board.tsx:987-1079`) and `selectionMenuItems` (`board.tsx:1086-1127`), calling `handleRemoveFromBoard([imageId])` / `handleToolbarRemoveFromBoard`. Place it with its own `separatorBefore` ahead of Archive, so the order reads: neutral actions → Remove from board → Archive/Unarchive → (separator) → Trash.

## 3. Node footer removal + hover-only filename

**Current behavior:** `image-node.tsx:69-83` always renders a footer div with the filename (unconditional) and a status line (missing/prompt/archived text, conditional). This footer already existed before the resize commit; resizing just made it more visible.

**Fix (per user decision — no footer at all, filename on hover only, gated by a setting):**
- Remove the footer div from `image-node.tsx` entirely. The missing-file badge (the red "!" circle, `image-node.tsx:63-67`, an absolute overlay on the image, not part of the footer) stays; since we're dropping the "File not found on disk" text it used to pair with, give the badge a `title` attribute with that text so the information isn't silently lost.
- Add a hover-revealed filename overlay inside the image container (`image-node.tsx`'s `relative flex-1` div): absolutely positioned bottom-right, small text on a translucent background (e.g. `absolute bottom-1 right-1 max-w-[80%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white`), shown via `opacity-0 group-hover:opacity-100` (the outer node div already has the `group` class used for the handle-hover treatment) — and only rendered/opaque at all when the new setting is on.
- Drop `promptText`/`archived` from `ImageNodeData` and the node body — no replacement UI for them per the user's answer; they remain visible in the Detail panel / list view.
- New setting `show_file_names` (SettingsService key, string `'true'`/`'false'`, default off) added the same way `floating-panel.tsx` already handles `panel_visible`/`panel_dock_side` (`floating-panel.tsx:26-27,100-109`): load with `SettingsService.Get` in a mount `useEffect` in `board.tsx`, keep as local state, and now also **write** it with `SettingsService.Set` when toggled (this file currently only reads its two keys — this is the first writer).
- Add a "Display" section to `settings-modal.tsx` with a toggle for "Show file names", following the existing Layout section's structure (`settings-modal.tsx:58-76`); wire `open`/`onChange` props through `floating-panel.tsx` the same way `layoutMode`/`onLayoutModeChange` already flow through.
- Pass the resulting boolean down into each image node's `data` (`board.tsx`'s node-building `useEffect`, ~line 367) as `showFileName`, and read it in `image-node.tsx` to gate the hover overlay's opacity/visibility.

## 4. Keyboard-shortcut hints in menus, and adopting shadcn/ui going forward

No `Kbd`/shortcut-display component or OS-detection utility exists anywhere in `frontend/src` today. `MenuAction.label` (`menu.tsx:6`) is already `ReactNode`, so no change to `menu.tsx`'s type is needed — shortcut hints can be composed directly into the label at the call site.

Per user direction, this is also where the project adopts the shadcn/ui CLI as the standard way to add UI components from now on (not just for `Kbd`). As of the July 2026 shadcn/ui release, Base UI (`@base-ui-components/react`) is the CLI's *default* primitive library (Radix now needs an explicit `-b radix` override) — matching what `button.tsx`/`select.tsx`/`toast.tsx` already hand-roll today. The one-time setup cost is real, though: no `components.json` or `@/*` alias exists yet, and shadcn's semantic theme vocabulary collides with one existing token name. This section is a one-time foundation, done once, ahead of generating `Kbd`.

### 4a. One-time shadcn setup

- `npx shadcn@latest init` — creates `components.json`, adds a `@/*` path alias (`compilerOptions.baseUrl`/`paths` in `tsconfig.json`, `resolve.alias` in `vite.config.ts`). Existing files keep their relative imports; only new/regenerated files use `@/...`.
- It detects and reuses `frontend/src/lib/utils.ts`'s existing `cn` (already the exact `clsx` + `tailwind-merge` shape it generates) rather than duplicating it.

### 4b. Merge shadcn's theme into `index.css`, not alongside it

Rather than declining shadcn's CSS variables (which would leave every future `shadcn add` visually inconsistent), map its semantic slots onto this project's existing Fluent-style palette (`index.css:3-24`) so generated components pick up the current look automatically:

| shadcn slot | maps to |
|---|---|
| `background` | `--color-surface` (#f3f2f1) |
| `foreground` | `--color-ink` |
| `card` / `popover` | `--color-card` |
| `card-foreground` / `popover-foreground` | `--color-ink` |
| `primary` | `--color-primary` (renamed from `accent`, see below) |
| `primary-foreground` | `#ffffff` |
| `secondary` / `muted` | `--color-surface` |
| `secondary-foreground` / `muted-foreground` | `--color-ink-subtle` |
| `destructive` | `--color-danger` |
| `destructive-foreground` | `#ffffff` |
| `border` / `input` | `rgba(0,0,0,0.08)` (matches the existing `border-black/8` convention) |
| `ring` | `--color-primary` |
| `radius` | leave `--radius-sm/md/lg` as they are (already literal px, not calc-derived) |

No `.dark` block — this app is light-only today, so skip generating dark-mode variables rather than leaving an unused/inconsistent second palette.

**The collision:** shadcn reserves `accent`/`accent-foreground` for a neutral hover-highlight fill (e.g. `data-[highlighted]:bg-accent` in every menu/select it generates) — a completely different concept from this project's existing `--color-accent`, which is the **brand blue** (buttons, selection rings, badges — 56 call sites across 15 files: `image-node.tsx`, `group-node.tsx`, `button.tsx`, `select.tsx`, `canvas-toolbar.tsx`, `zoom-controls.tsx`, `menu.tsx` call sites in `board.tsx`, etc.). Per user decision, resolve this by renaming the existing brand token — it's semantically shadcn's `primary` anyway:
- `index.css`: `--color-accent` → `--color-primary`, `--color-accent-soft` → `--color-primary-soft`.
- Mechanical rename across all 15 files: `bg-accent`→`bg-primary`, `text-accent`→`text-primary`, `ring-accent`→`ring-primary`, `border-accent`→`border-primary`, `accent-soft`→`primary-soft` (word-boundary-safe find/replace, e.g. `grep -rl` the list already gathered, then per-file `Edit`/`sed` with care around unrelated substrings).
- `accent`/`accent-foreground` is then genuinely free for shadcn's own meaning: map `--color-accent: var(--color-surface)` (or a slightly darker neutral if `--color-surface` reads too close to `--color-card`), `--color-accent-foreground: var(--color-ink)`.

### 4c. Generate Kbd

- `npx shadcn@latest add kbd` — generates `Kbd`/`KbdGroup` at `frontend/src/components/ui/kbd.tsx` (pure styling, no Base UI/Radix runtime dependency). With 4b done, its default classes (`bg-muted`, `text-muted-foreground`, `border`) now resolve to this project's real palette instead of needing manual restyling.
- Add `isMac` to `frontend/src/lib/utils.ts`: `export const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)`.

### 4d. Use the shortcuts
- In `board.tsx`, build a small local helper (e.g. `modKey = isMac ? '⌘' : 'Ctrl'`) and compose labels like:
  ```tsx
  label: (
    <span className="flex items-center justify-between gap-2">
      <span>{t`Remove from board`}</span>
      <Kbd>{isMac ? '⌫' : 'Del'}</Kbd>
    </span>
  ),
  ```
- Apply this to the items that actually have a bound shortcut today: "Remove from board" (Backspace/Delete, both `nodeMenuItems` and `selectionMenuItems`), "Group as set" (`${modKey}G`, from `useGroupShortcut`), "Undo" (`${modKey}Z`) and "Redo" (`${modKey}⇧Z` / `Ctrl+Shift+Z`) in `paneMenuItems` (`board.tsx:1133-1169`, shortcuts already wired via `useUndoShortcuts`/`useGroupShortcut` in `lib/use-undo.ts`). Leave items with no bound shortcut (Trash, Archive, Select all, Auto-arrange, etc.) as plain labels.

## 5. Trashed image not reflected in Explorer

**Root cause:** confirmed as a stale-cache/invalidation gap, not a missing UI element — `panel-image-row.tsx:108-126` already renders a "Trashed" badge and `explorer-panel.tsx`'s file rows already use that component (`explorer-panel.tsx:704-709`). `ExplorerPanel` caches directory listings (`dirCache`) and only re-fetches a directory when *it itself* moves/trashes/renames a file inside it (`explorer-panel.tsx:298-321`). Trashing from the canvas or Library never tells Explorer to refetch, so its cached row keeps showing the pre-trash state. `TrashImage` genuinely moves the file out of its directory into `.loom/trash` (`internal/store/image.go:317-391`), and `.loom` is already excluded from directory listings (`internal/store/image.go:139`), so once Explorer's cache is refreshed, the stale row simply disappears (it moved away) — no new badge logic is needed, just invalidation.

Board.tsx already has exactly this kind of cross-panel signal for Library: `libraryRefreshToken` (`board.tsx:108`), bumped after canvas-driven undo/redo and the toolbar's batch archive/trash (`board.tsx:197,214,228,894,910`) and read by `LibraryPanel` to force a refetch (`library-panel.tsx:133-136`). Two gaps let the bug through:
- The *single*-item canvas paths — `handleArchiveToggle` (`board.tsx:844-849`) and `handleTrash` (`board.tsx:850-859`), used by the node context menu's Archive/Trash — never bump `libraryRefreshToken` at all.
- Nothing bumps it for Library/Detail-driven mutations (they call `onChange?.()`, which is `onBoardsChanged={loadBoard}` in `board.tsx:1321` — reloads the board but doesn't touch the token), and nothing bumps it for Explorer at all.

**Fix:**
- In `board.tsx`, also call `setLibraryRefreshToken((v) => v + 1)` inside `handleArchiveToggle` and `handleTrash` (closing the single-item gap).
- Change `onBoardsChanged={loadBoard}` (`board.tsx:1321`) to an inline callback that also bumps the token: `() => { loadBoard(); setLibraryRefreshToken((v) => v + 1) }`. This covers Library's and Detail's own archive/trash/restore actions and board-list changes uniformly.
- Add a `refreshToken: number` prop to `ExplorerPanel` (`explorer-panel.tsx`), passed the same `libraryRefreshToken` value from `floating-panel.tsx` (mirroring how `LibraryPanel` already receives it). Add a `useEffect` keyed on it (skip the initial `0`, same guard `library-panel.tsx:134` uses) that re-runs `loadDir` for every path currently present in `dirCache`, so all already-expanded directories refetch and drop/update any now-stale rows.

## Files touched

- `frontend/src/routes/board.tsx` — node width/height defaults, remove-from-board handlers + menu items + Delete-key rewire, filename-setting state, refresh-token bumps, `onBoardsChanged` wrapper, kbd-annotated menu labels.
- `frontend/src/components/board/image-node.tsx` — drop footer, add hover filename overlay, `title` on missing badge, use shared size constants.
- `frontend/src/components/board/group-node.tsx` — use shared size constants.
- `frontend/src/lib/node-size.ts` (new) — `DEFAULT_NODE_WIDTH`/`DEFAULT_NODE_HEIGHT`.
- `frontend/src/lib/utils.ts` — add `isMac`.
- `frontend/components.json` (new), `frontend/tsconfig.json`, `frontend/vite.config.ts` — shadcn/ui CLI init (path alias + registry config).
- `frontend/src/index.css` — merge shadcn's semantic theme slots onto the existing palette (table in section 4b); rename `--color-accent`/`--color-accent-soft` → `--color-primary`/`--color-primary-soft`; define shadcn's `accent`/`accent-foreground` as the neutral hover slot.
- 15 files with `accent`-named Tailwind classes (`bg-accent`, `text-accent`, `ring-accent`, `border-accent`, `accent-soft`) — mechanical rename to `primary`/`primary-soft`: `image-node.tsx`, `group-node.tsx`, `button.tsx`, `select.tsx`, `board-picker.tsx`, `board-switcher.tsx`, `canvas-toolbar.tsx`, `detail-panel.tsx`, `explorer-panel.tsx`, `library-panel.tsx`, `prompt-picker.tsx`, `repo-select.tsx`, `tag-picker.tsx`, `zoom-controls.tsx`, `routes/landing.tsx`.
- `frontend/src/components/ui/kbd.tsx` (new, via `shadcn add kbd`) — `Kbd`/`KbdGroup`, picks up the merged theme automatically.
- `frontend/src/components/board/settings-modal.tsx` — new "Display" section with the show-file-names toggle.
- `frontend/src/components/board/floating-panel.tsx` — thread the new setting props through to `SettingsModal`; pass `refreshToken` to `ExplorerPanel`.
- `frontend/src/components/board/explorer-panel.tsx` — accept `refreshToken`, refresh cached dirs on change.

## Verification

- `cd frontend && bun run build` (or the project's existing typecheck/lint script) to catch type errors from the `ImageNodeData`/props changes, and `bun run check` (biome) to catch any leftover `-accent` class names the rename missed.
- After the `accent`→`primary` rename, visually diff a few `accent`-heavy screens (primary buttons, a selected canvas node's ring, a selected tag/badge) against how they looked before — should be pixel-identical, since this is a pure rename, not a value change. Then check a shadcn-generated surface (the new Kbd, or any future `shadcn add`'d dropdown) actually gets a visibly different (neutral, not blue) hover fill — confirming the collision is truly resolved, not just renamed-and-still-colliding.
- Run the app (`headless-gui`/`run` skill or normal dev flow), open a board with several never-resized images, reload/re-navigate to it, and confirm nodes render at full size immediately (no invisible/zero-size flash) — this is the best manual check for item 1 since it's a race-condition-shaped bug.
- On canvas: select an image, press Backspace — confirm it disappears from the board but still shows up in Library with status "active" (not trashed), and reappears if re-added to the board. Right-click a node and confirm "Remove from board" is present and behaves the same; confirm the toolbar Trash button and context-menu Trash still actually trash.
- Hover a node with the setting off (default) — no filename appears anywhere. Turn on "Show file names" in Settings, hover — filename appears bottom-right over the image; confirm no footer/prompt/archived text renders in either state.
- Open the context menu (node, selection, and pane) and confirm shortcut hints render as `⌘`/`⌫` on a Mac user agent and `Ctrl`/`Del` otherwise (can spot-check via devtools' `navigator.platform` override).
- Trash an image via the canvas node menu (single) while Explorer has that file's directory expanded — confirm the row disappears/updates without manually collapsing the folder. Repeat trashing from Library while Explorer is open.
