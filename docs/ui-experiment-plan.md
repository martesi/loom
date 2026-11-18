# UI experiment plan: canvas first, contextual chrome

**Status:** Approved for implementation on `loom-ui-experiment`.
**Scope:** Visual and interaction changes to Loom's existing Canvas route.  
**Research date:** 2026-11-18.

## Direction

Make the Canvas the full-viewport workspace. Assets and Inspector become
floating drawers that overlay the canvas, so opening them never narrows or
reflows the React Flow viewport. Keep the most common canvas controls close to
the pointer, reveal less common controls on demand, and make every command
discoverable through one searchable palette.

This experiment changes presentation and command access only. It preserves the
Assets / Canvas / Inspector model, one active selection surface, one placement
per asset, set and relationship behavior, and the existing unplace / trash /
purge meanings defined in [`r/ui.md`](../r/ui.md).

## What the references suggest

| Reference | Observed pattern | Use in Loom |
| --- | --- | --- |
| [PureRef navigation and shortcuts](https://www.pureref.com/handbook/navigation/), [shortcut reference](https://www.pureref.com/handbook/shortcuts/) | The image board stays visually dominant; shortcuts, right-click menus, and a command palette provide access to less frequent controls. | Keep the idle canvas quiet. Put complete command access in the palette and context menus; keep only a few high-frequency controls visible. |
| [Obsidian Canvas](https://obsidian.md/help/plugins/canvas) | Canvas-level zoom controls remain available, selected cards get a contextual toolbar, and the command palette can navigate to groups. | Keep viewport actions reachable and show selection actions in context instead of a permanent second toolbar. |
| [Canvas Folding community plugin](https://community.obsidian.md/plugins/canvas-folding) | Hover controls can expose a fold action, while a visible hidden-item count keeps collapsed state legible. This is a community plugin, not core Obsidian behavior. | Treat hover as a way to reveal a small action affordance. Keep Loom set counts visible when collapsed; do not add a second folding model. |
| [Excalidraw UI source](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/main-menu/DefaultItems.tsx), [Zen Mode action](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/actions/actionToggleZenMode.tsx) | A tool toolbar and contextual controls coexist with a mode that hides editor chrome. | Offer a deliberate Focus Canvas mode, while retaining normal direct-manipulation controls in the default mode. |
| [tldraw UI](https://tldraw.dev/docs/user-interface), [actions](https://tldraw.dev/sdk-features/actions) | One action definition can drive a toolbar, menu, keyboard shortcut, and shortcut hint. UI can be hidden while the editor and shortcuts remain active. | Use one Loom action catalog as the source for palette entries, shortcuts, and toolbar/context-menu items. |
| [Figma Actions menu](https://help.figma.com/hc/en-us/articles/23570416033943-Use-the-actions-menu-in-Figma-Design), [keyboard access](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard) | A searchable action surface provides an alternate route to tools and commands, with keyboard-first navigation. | Make the palette a reliable alternative to visible chrome, with clear action names and shortcut hints. |
| [VS Code command palette and tips](https://code.visualstudio.com/docs/editing/getting-started/tips-and-tricks), [keybindings](https://code.visualstudio.com/docs/configure/keybindings) | Commands are searchable, shortcuts are shown beside results, and keyboard navigation is consistent. | Use fuzzy matching, arrow-key navigation, Enter to run, Escape to close, and shortcut hints from the same action catalog. |
| Local xyflow examples under `/tmp/opencode/loom-refs/xyflow/examples/react/src/examples/` | `NodeToolbar`, `Panel`, `Controls`, `useReactFlow`, and `fitView` show supported selection-relative toolbars and viewport overlays. | Keep Loom chrome outside the zoomable graph content; use xyflow selection and viewport APIs instead of duplicating graph state or transforms. |

## Current implementation

- `frontend/src/routes/canvas.tsx` renders a full-width header above a flex row
  containing `ShelfPanel`, the React Flow `<main>`, and a second `ShelfPanel`.
  On wide displays the shelves are layout siblings; each starts at 320 px and
  can be resized from 240 to 480 px. At widths below 1100 px they overlay the
  route instead. Thus opening both wide-screen shelves covers 640 px of the
  available row by reducing the Canvas width.
- `ShelfPanel` already has close buttons, edge triggers, resize separators, and
  keyboard resizing. Closed shelves have zero width. Its content is provided by
  `LibraryPanel` and `DetailPanel`, which can remain the sources of their current
  catalog and metadata behavior during this experiment.
- `CanvasDock` is a five-action bottom toolbar: Fit all, Fit selection, Reset
  100%, Auto-arrange, and Create set. `SelectionHud` appears for a Canvas
  selection and exposes Preview, Locate, Unplace, Create set, Align, and
  Auto-arrange Subgraph as applicable.
- `ImageNode` already has a hover overlay, but its “Quick Action” pill is
  currently non-interactive. This is the natural place to trial real hover and
  keyboard-focus actions without adding another always-visible toolbar.
- The route header currently provides repository selection, Rescan, Import, and
  the Assets / Inspector toggles. There is no command palette today.
- Existing keyboard behavior includes `Mod+B` (Assets), `Mod+I` (Inspector),
  surface-scoped `Mod+A`, copy / converted copy / paste, Delete / Shift+Delete,
  `Shift+1`, `Shift+2`, `Shift+A`, `Mod+0`, `Mod+G`, Space-drag pan, and
  `Mod`-drag relationship creation. Undo / redo is wired through
  `useUndoShortcuts`.
- `frontend/e2e/shelves.spec.ts` asserts panel widths, open/closed state, edge
  triggers, resizing, and toggles. `canvas-dock.spec.ts` asserts the dock's
  five controls, hover HUD behavior, hit areas, and viewport shortcuts. Canvas,
  library, relationship, set, clipboard, and lifecycle behavior already has
  broad Playwright coverage, summarized in
  [`product-patterns-and-test-audit.md`](product-patterns-and-test-audit.md).

## Proposed layout and reveal rules

### Canvas and persistent controls

1. Let the React Flow host occupy the whole route viewport. Header, drawers,
   dock, and HUD are positioned as overlays outside the zoomable node layer.
   Opening, closing, or resizing a drawer must not change the host rectangle or
   trigger a fit/reset of the graph.
2. Replace the full-width header with a compact floating top island: repository
   selector, command-palette trigger, and Assets / Inspector toggles. Put Import
   and Rescan under a small repository/actions menu so they stay discoverable
   without occupying a permanent row.
3. Keep slim, labeled edge tabs for Assets and Inspector when their drawers are
   closed. Hover or keyboard focus may reveal the tab label; click, Enter, or
   the existing `Mod+B` / `Mod+I` shortcut opens the drawer. Do not make hover
   the only way to open it.
4. Default both drawers closed when entering the Canvas. Opening either overlays
   the graph; the other drawer can be opened independently. The user can pin an
   open drawer to keep it visible across Canvas interactions. Retain resizable
   widths and the accessible separator while the drawer is open.
5. The Inspector follows the active selection even when closed. Selecting a
   node does not unexpectedly open it; the selection HUD and palette provide
   contextual actions, and `Mod+I` opens the full metadata view when wanted.

### Auto-hide and contextual controls

| Event | Assets | Inspector | Other controls |
| --- | --- | --- | --- |
| Open from edge tab, top island, shortcut, or palette | Opens as an overlay; retains search, folder, and filters. | Opens with the current selection. | Restore focus to the control that opened it when closed. |
| Click or pan on Canvas while an unpinned drawer is open | Remains open while browsing; closes after a successful Assets-to-Canvas drop. | Closes when the Canvas background clears selection. A selected node does not force it open. | Never close during an active pointer drag. |
| Click its close button or press Escape with no higher-priority dialog/menu | Closes. | Closes. | Keep edge tabs available. Escape first closes a modal, palette, or context menu. |
| Pin an open drawer | Remains open during Canvas clicks, selection changes, and pointer exit until explicitly closed/unpinned. | Same. | Expose pin state in the button name and `aria-pressed`. |
| Enter Focus Canvas mode (`Mod+\`) | Hidden; pin state is retained. | Hidden; pin state is retained. | Hide top island, dock, edge tabs, and selection HUD. The palette and shortcut remain available; edge hover/focus or the shortcut exits the mode. |

On image hover and keyboard focus, replace the placeholder “Quick Action” pill
with a small action strip for Preview and More. Keep the resolution badge and
filename treatment. Keep the selection HUD for Canvas selection, but put
secondary actions under More if the current row of buttons competes with the
image. Do not put controls over the image in a way that blocks dragging,
selection, or relationship gestures. Touch users get the same actions from
selection and the context menu, without hover requirements.

Simplify the persistent dock to Fit all, Fit selection when enabled, and Reset
100%. Put Auto-arrange in a small overflow menu and keep Create set in the
multi-selection HUD and palette. Preserve the existing action IDs where they
still represent the same action; the visual grouping can change.

## Command palette

### Entry and search behavior

- Primary entry: `Mod+K`, the top-island button, and a **Show commands** item in
  context menus. `?` opens the shortcut reference. Do not overload `Mod+P` or
  `Mod+R`, which commonly mean print/open or browser reload.
- The default query searches commands. `>` explicitly scopes to commands;
  `@` switches to repository asset search by filename, tag, and path. Running an
  asset result selects it and reveals it in Canvas if placed or Assets if
  unplaced.
- Match translated label, description, category, and curated synonyms with a
  case-insensitive fuzzy subsequence matcher. Prefer word starts and consecutive
  characters; highlight matched ranges. Keep stable action IDs independent of
  translated text. Show recent commands only after a real command has run.
- Results show label, short description, category, shortcut, and context. Keep
  unavailable actions visible but disabled with a short reason (for example,
  “Select at least two Canvas items”). Destructive actions retain confirmation.
- Up / Down moves the active result; Enter runs it; Escape closes. Preserve the
  prior focus on close. After running a navigation or drawer action, focus the
  resulting surface; after a mutation, return focus to the Canvas selection.

### Action catalog

The palette should expose every user-facing command represented by a button,
context menu, shortcut, selection HUD, or Inspector action. It is context-aware,
not limited to the currently visible toolbar. The following is the initial
catalog, grouped by eligibility; exact labels can be tuned in implementation.

| Category | Commands | Availability / result |
| --- | --- | --- |
| Workspace | Open Assets; Open Inspector; switch repository; Import media; Rescan repository; Toggle Focus Canvas; Show keyboard shortcuts | Always. Drawer commands open the overlay; import uses the existing file input; rescan uses the existing reload path. |
| Assets navigation | Show All Assets; Show Folders; Focus asset search; Search assets (`@`); filter by state, placement, or tag; navigate to repository root / current folder | Open Assets as needed and focus the relevant control. Preserve existing All Assets / Folders selection and filters. |
| Canvas view | Fit all; Fit selection; Reset zoom to 100%; Zoom in; Zoom out; Auto-arrange Canvas; Auto-arrange selection | Zoom and fit commands persist viewport through the existing viewport service. Fit selection is disabled with no Canvas selection. |
| Selection and sets | Select all in active surface; Clear selection; Preview; Locate in Assets; Create set; Expand selected set; Collapse active set; Compare set; Set cover image; Edit set name/kind; Dissolve set; Align horizontally; Align vertically; Auto-arrange selection; Unplace from Canvas | Show only applicable commands or disable them with a reason. Preserve the one active selection surface and set rules. |
| Asset metadata and file | Rename asset; Move/rename file path; Show in Folders; Add tag; Save prompt; Archive; Unarchive; Restore from trash; Compress selected assets | Rename is available for one asset in Folders. Bulk metadata actions use the existing Inspector forms and common-value behavior. |
| Relationships | Go to source; Go to derived; Remove relationship; Go to a source/derived asset from Inspector | Requires selected relationship or related image. Keep current DAG/self-link validation and confirmation behavior. |
| Clipboard and lifecycle | Copy original media; Copy converted media; Paste media; Trash selected Assets; Unplace selected Canvas items; Permanently purge selected assets | Copy/paste remains surface-aware. Delete keeps its current active-surface meaning; purge requires one confirmation with final count. |
| Context menus | Select all; Auto-arrange Canvas; Create set; Auto-arrange selection; Find in Assets; Remove from Canvas; Trash selection; Archive/Unarchive; Dissolve set; Show commands | Keep right-click/pointer context actions backed by the same action definitions as the palette. |

The catalog does not invent repository-wide “empty trash,” restore-all, invert
selection, or file-manager reveal commands. Add those only if the product
separately adopts the corresponding behavior and backend support.

## Keyboard scheme

`Mod` means Command on macOS and Control on Windows/Linux. These are the default
bindings to preserve or add; they must appear in the same action catalog used by
the palette and visible controls.

| Shortcut | Scope | Action |
| --- | --- | --- |
| `Mod+K` | Global | Open command palette |
| `?` | Global | Open shortcut reference |
| `Mod+B` | Global | Toggle Assets |
| `Mod+I` | Global | Toggle Inspector |
| `Mod+\` | Global | Toggle Focus Canvas |
| `Mod+A` | Active surface | Select all visible Assets or placed Canvas items |
| `Escape` | Layered | Close modal/palette/context menu; then close unpinned drawer; then clear selection/collapse active set |
| `Mod+Z`, `Mod+Shift+Z`; `Ctrl+Y` on Windows/Linux | Global except editable fields | Undo / redo |
| `Mod+C` | Active selection | Copy original media |
| `Mod+Shift+C` | Active selection | Copy converted media |
| `Mod+V` | Active surface | Paste; Canvas focus places at viewport center, Assets focus leaves items unplaced |
| `Delete` / `Backspace` | Active surface | Canvas: unplace; Assets: trash; selected relationship: unlink |
| `Shift+Delete` / `Shift+Backspace` | Active surface | Open permanent-purge confirmation |
| `Shift+1` / `Shift+2` | Canvas | Fit all / fit selection |
| `Mod+0` | Canvas | Reset zoom to 100%, retaining center |
| `Shift+A` | Canvas | Auto-arrange Canvas or current selection using existing selection behavior |
| `Mod+G` | Canvas | Create set from eligible multi-selection; leave the browser's find-next shortcut untouched when grouping is unavailable |
| Space + drag / middle-drag | Canvas | Pan |
| `Mod` + drag from image A to image B or set | Canvas | Create relationship from A; preserve rejection feedback |
| Arrow keys / Escape | Lightbox | Previous / next image; close preview |

Do not bind `Mod+R` or `Mod+P` in this experiment. Avoid single-letter global
commands. Do not intercept browser/system editing shortcuts while focus is in
an input, textarea, select, contenteditable region, or modal editor. Keep
`Mod+A/C/V/Z` native inside text fields.

## Component migration path

1. **Create the action catalog and shortcut map.** Wrap existing route
   callbacks rather than duplicating service calls. Move current keyboard
   handling to one dispatcher with active-surface and editable-focus guards.
   Give actions stable IDs, localized labels, categories, aliases, shortcut,
   enabled predicate, disabled reason, and execution callback.
2. **Make the Canvas viewport full bleed.** Refactor `ShelfPanel` into a
   floating overlay while retaining `LibraryPanel` and `DetailPanel` as its
   contents. Move repository, import/rescan, palette, and drawer triggers from
   the full-width header into the floating island. Preserve the current
   separators, resizing bounds, selection ownership, and drag/drop data
   transfer.
3. **Add progressive controls and reveal rules.** Keep CanvasDock and
   SelectionHud actions wired through the catalog. Replace the image-node
   placeholder with real hover/focus actions. Add pin state, auto-hide rules,
   edge tabs, and Focus Canvas mode. Keep all non-hover alternatives available.
4. **Add the palette and asset search mode.** Use the existing Base UI dialog
   dependency if suitable; otherwise use current dialog primitives. Reuse the
   shared action catalog for results and shortcut hints. Keep asset search on
   the current LibraryService query path.
5. **Retire obsolete layout assumptions.** Update tests that encode side-by-side
   widths or an always-visible five-button dock. Keep stable semantic labels and
   test IDs when they still identify the same behavior. Do not change the data
   model or service contracts as part of this UI pass.

## Accessibility and localization

- Implement the palette as an accessible dialog with a labeled combobox and
  result list. Support arrow-key navigation, Enter, Escape, visible active
  result, match-count announcement, focus trap, and focus restoration.
- Give edge tabs, pin toggles, drawer controls, HUD actions, and icon-only
  controls accessible names and visible focus indicators. Use `aria-expanded`
  / `aria-pressed` for open and pinned state. A drawer hidden visually must not
  leave its controls in the tab order.
- Treat hover as an enhancement. The same actions must work through keyboard
  focus, selection, context menus, and palette. On touch, use tap to reveal the
  contextual action row. Respect reduced-motion preferences.
- Keep the interaction usable at narrow widths: drawers overlay the Canvas,
  one drawer at a time by default, and the palette fits the viewport. Do not
  assume hover or a mouse.
- Loom uses Lingui, but most Canvas, Inspector, and selection labels are still
  English-only. Localize command labels, descriptions, categories, aliases,
  drawer controls, status announcements, and disabled reasons through Lingui.
  Keep action IDs and keyboard bindings locale-independent; render `Mod` as
  platform-appropriate glyphs/text.

## E2E impact

Existing behavior suites remain the contract for selection, drag/drop,
relationships, sets, metadata, clipboard, and asset lifecycle. Layout assertions
must change: the current shelf suite assumes wide-screen side-by-side drawers,
320 px defaults, and width changes; the dock suite assumes five permanent
buttons. Those are visual assertions and should be replaced with assertions for
overlays and reduced chrome, not treated as zero-impact compatibility.

Add focused Playwright coverage for:

- Canvas host bounds remain unchanged when either or both drawers open, close,
  resize, or auto-hide; overlays do not intercept graph gestures outside their
  bounds.
- Initial closed state, edge-tab click/focus/tap, keyboard toggles, pin/unpin,
  action-completion auto-hide, and no hide during drag or while focus is inside
  a drawer.
- Focus Canvas mode hides controls and can be exited with its shortcut and edge
  affordance; Escape follows the documented layered behavior.
- Palette opens from shortcut and button; fuzzy word/acronym/substring
  matching, category/alias matching, asset `@` search, result execution,
  disabled reasons, destructive confirmation, and focus restoration work.
- Every palette shortcut hint matches the active keyboard binding on macOS and
  Windows/Linux. Typing in search, prompt, tag, and rename fields does not
  trigger global commands.
- Existing CanvasDock and SelectionHud actions still invoke their original
  behaviors through the catalog; hover controls work with pointer and keyboard,
  while touch has a tap/context-menu path.
- Responsive drawer/palette behavior at narrow widths, screen-reader labels,
  reduced motion, and no keyboard focus into hidden controls.

Keep unit tests to pure fuzzy matching, action eligibility, shortcut
normalization, and palette search helpers under `bun:test`, consistent with
`r/ui.md`. Do not claim the plan is validated by running the suite; implementation
approval and a later verification pass are separate steps.

## Approval boundary

The original approval gate is satisfied by the user's continuation instruction
for this branch. Keep implementation within the scope and behavior contract
above.
