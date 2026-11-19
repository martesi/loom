# Command palette, shortcuts, and Canvas chrome polish

**Status:** Partial implementation in progress; see delivery notes below.
**Scope:** Polish the existing Canvas interaction model, not a new editor shell.

## Contract and evidence

Use [the UI experiment plan](../ui-experiment-plan.md) as the interaction
contract and [the product UI specification](../../r/ui.md) for selection, sets,
relationships, and lifecycle semantics. Keep one active selection surface,
one placement per asset, and the distinction between unplace, trash, and purge.
Do not add backend capabilities or change service contracts in this pass.

The relevant tracked sources are:

- `frontend/src/routes/canvas.tsx`: action catalog, dispatcher, palette execution,
  asset loading, drawer state, top island, and Focus Canvas.
- `frontend/src/lib/action-catalog.ts`: action shape, fuzzy search, shortcut
  matching, and platform hint formatting.
- `frontend/src/components/canvas/command-palette.tsx`: `>` / `@` modes,
  recent results, disabled reasons, dialog and result navigation.
- `frontend/src/components/canvas/canvas-dock.tsx`: idle, single, and multiple
  modes. It currently has separate labels and eligibility props.
- `frontend/src/components/canvas/shelf-panel.tsx`: overlay, pin, resize,
  hidden-state inertness, and deferred opening focus.
- `frontend/e2e/command-palette.spec.ts`, `shelves.spec.ts`, and
  `canvas-dock.spec.ts`: extend these contracts rather than replace them.
- `frontend/src/routes/ui-mocks.tsx`: the `/ui-mocks` studio, night, and contact
  concepts are visual comparison tools, not alternative production behavior.

Several requested features already exist. The work is to close gaps and make
all entry points agree. In particular, palette execution currently catches an
error before the recent-command update; a failed action can therefore appear
as recent. Asset loading has no explicit palette loading/error view, and asset
matches are not highlighted. Close-time focus restoration and later action
focus use separate animation-frame requests, which need an explicit handoff.

## Design direction

Use the references already linked in the UI experiment plan as inspiration:

| Reference | Apply to Loom | Do not copy |
| --- | --- | --- |
| Figma Actions menu | Searchable actions as an alternate path to visible tools; concise labels and context | A second command inventory or editor-specific tools |
| VS Code palette | Explicit command prefix, fuzzy ranking, recents, visible shortcuts, predictable keyboard operation | File-opening semantics for asset results or browser-conflicting bindings |
| tldraw action definitions | One action definition for menus, palette, shortcuts, and dock | A separate selection or canvas state model |
| Excalidraw contextual UI / Zen Mode | Quiet idle chrome and deliberate Focus Canvas | Hover-only actions or a mode with no visible exit |

Review the three mock concepts for spacing, contrast, surface hierarchy, and
information density. Keep the approved top-island / dock / overlay-drawer
structure. Do not make a theme or shell replacement part of this plan.

## 1. Palette and action catalog

### Search and result behavior

- Empty input shows recent commands, then the command inventory. `>` explicitly
  searches commands; no prefix also searches commands. `@` searches assets in
  the current repository by filename, path, and tags, independent of drawer
  filters. Explain both prefixes in the input hint and empty state.
- Keep case-insensitive fuzzy subsequence matching. Prefer exact/prefix matches,
  word starts, and consecutive characters. Search localized labels,
  descriptions, categories, and curated aliases. Use stable action IDs for ties
  and recents; never use translated labels as identity.
- Define multi-word and accent matching with fixtures before changing ranking.
  Map normalized match offsets back to displayed text so accents, combining
  characters, and Unicode characters do not produce wrong highlights.
- Highlight filename/path/tag evidence for asset matches. If an action matches
  only an alias or description, do not imply that its label matched.
- Keep disabled commands visible and navigable with `aria-disabled` and a short
  reason. Enter or click must not run them, close the palette, or add a recent.
  Recheck current eligibility at execution time, not only when results render.
- Keep active results visible after typing, scrolling, and mode changes. Preserve
  the existing agreement between focused result, selected result, and Enter;
  pointer hover must not replace a keyboard-focused result.
- Show loading, empty, failure/retry, and result-limit states for asset search.
  Clear old repository results on a switch and reject late responses. Keep
  trashed assets excluded under the existing contract. A missing or stale result
  must show feedback, not select an unrelated asset.
- Retain the result limit unless measurement justifies a change. Explain the
  limit instead of presenting a capped count as the total repository count.
  Do not add a new search endpoint or dependency without evidence of need.

### Execution, recents, and safety

- Use one action definition for eligibility, disabled reason, label, shortcut,
  and execution across palette, dock, top island, and context menus. Keep route
  callbacks as the behavior owners. Audit Inspector and menu actions against
  the catalog; add missing access paths without inventing new product actions.
- Keep six distinct recent command IDs, most recent first, after successful
  execution only. Opening help, opening the palette, failed actions, disabled
  actions, and canceled destructive confirmations do not count as completed
  commands. Deduplicate against the main list and resolve eligibility afresh.
  Session-local history is sufficient; persistent history is not required.
- Give execution a clear completion/cancel/failure outcome. Editor-navigation
  commands count when the editor is opened; they do not submit unsaved values.
- Destructive commands use the existing lifecycle confirmation path. Purge must
  show one confirmation with the final count and scope; cancel leaves data and
  selection unchanged. Do not add confirmation to reversible unplace merely
  because it is visually marked as dangerous. Prevent repeat submission.

### Focus ownership

Define one close result rather than racing automatic restore against action focus:

| Outcome | Focus destination |
| --- | --- |
| Escape or outside dismissal | Connected, visible opener; otherwise Canvas host |
| Open drawer / navigate within Assets | Requested control or selected row after it mounts |
| Open Inspector field | Requested field after its data loads; opening must not submit |
| Choose placed `@` asset | Revealed Canvas node/selection, with Canvas selection ownership |
| Choose unplaced `@` asset | Revealed Assets row, with Assets selection ownership |
| Mutation completes | Relevant surviving selection or Canvas host |
| Confirmation opens | Confirmation dialog; on cancel, relevant selection/valid opener |
| Focus Canvas toggles | Canvas host, never the now-hidden trigger |

Cancel pending focus requests if the drawer closes, selection changes,
repository changes, or the target is removed. Retain Base UI focus trapping;
coordinate its restoration with the route-level destination. Hidden drawers,
island, and dock must be inert and absent from keyboard navigation.

## 2. Chrome and context menus

### Top island

Keep repository identity/selection, palette entry, and the single Assets and
Inspector toggle pair. Keep Import and Rescan in the repository actions menu.
Use catalog labels and hints; give icon controls accessible names, visible focus,
and expanded/pressed state. Long repository names truncate without moving the
drawer toggles off screen. Menus dismiss before drawer or selection Escape.
No edge tabs, permanent second toolbar, or hover-only trigger is needed.

### Dock morphing

| State | Primary actions | Eligibility |
| --- | --- | --- |
| Idle | Fit all, reset 100%, arrange; keep existing fit-selection access while auditing idle density | Empty Canvas explains unavailable fit/arrange |
| Single Canvas selection | Preview, Locate, Inspect, Fit selection, Unplace | Image/set/relationship rules come from the catalog |
| Multiple Canvas selection | Create Set with count, horizontal/vertical align, arrange selection, Unplace | Create Set requires eligible items; no silent partial operation |

Assets selection must not masquerade as Canvas selection. Use real graph
selection/eligibility rather than count alone. Keep dock position outside the
zoomable graph and independent of node movement. Do not steal focus when mode
changes. If a focused action disappears after an operation, move to a surviving
action or Canvas host. Announce a meaningful mode/count change without noisy
announcements on every render. Honor reduced motion.

At narrow widths, retain reachable actions with controlled horizontal scrolling
or catalog-backed overflow. Focused items scroll into view; do not depend on
hover or hide essential actions without another visible path. Do not introduce
toolbar arrow-key interception until it is reconciled with Canvas navigation.

### Drawers, pinning, and Focus Canvas

- Drawers overlay the unchanged Canvas host. Opening, resize, hide, and pin
  must not refit the graph, change zoom, or reflow its bounds.
- Pin controls visibility persistence, not selection ownership or Inspector
  content. Explicit collapse still closes a pinned drawer.
- Assets stays open while browsing; an unpinned Assets drawer closes after a
  successful drop onto Canvas. Failed drops and active pointer drags do not hide
  it. Unpinned Inspector closes when Canvas-background interaction clears
  selection, not merely when the pointer leaves the drawer.
- At narrow widths, show one drawer at a time by default. Preserve pin preference
  when a drawer is temporarily hidden; do not stack two full-width drawers or
  leave obscured controls focusable.
- Focus Canvas hides island, dock, and drawers while retaining their open/pin
  state. Selection and direct manipulation continue. Keep `Mod+K`, `Mod+\\`,
  `?`, and a compact visible Exit Focus Canvas control available. Exiting
  restores prior chrome state without a viewport reset. Escape does not become
  a second undocumented Focus Canvas toggle.

### Context menus

Use catalog-backed subsets for Canvas background, selected image/set,
relationship, and Assets rows. Preserve the clicked-target versus existing
multi-selection rules. Include **Show commands** as the complete action path.
Offer keyboard context-menu access (`Shift+F10` / ContextMenu where supported),
focus the first applicable item, and restore the target on dismissal. Disable
ineligible actions with reasons. A menu or its pointer events must not trigger
background deselection, pan, or drawer auto-hide.

## 3. Shortcut audit and reference

The base scheme is already implemented in the route catalog. Audit bindings,
scope, and hints together; do not label all palette-only commands as missing
shortcuts. Preview, Locate, alignment, metadata editing, and lifecycle actions
can remain palette/dock/menu commands without new global letters.

| Area | Required audit / decision |
| --- | --- |
| Global entry | Preserve `Mod+K`, `?`, `Mod+B`, `Mod+I`, and `Mod+\\`; guard editable fields and modal editors |
| Selection / clipboard | Preserve surface-aware `Mod+A/C/V`, `Mod+Shift+C`; native editing wins in fields |
| Undo / redo | `Mod+Z`, `Mod+Shift+Z`, plus Windows/Linux `Ctrl+Y`; no macOS `Ctrl+Y` alias |
| Deletion | Delete/Backspace and shifted variants use active-surface semantics; never delete from text editing |
| View / grouping | `Shift+1/2`, `Shift+A`, `Mod+0`, `Mod+G`; unavailable grouping must not consume browser find-next |
| Zoom | Existing `Mod+=` and `Mod+-` need layout/key-event tests; intercept only in Canvas scope, otherwise preserve browser zoom |
| Assets view | Audit existing `Mod+Shift+1/2` gallery/list and `Mod+Alt+ArrowUp/Down` density bindings for browser/OS collisions and Assets scope; keep palette access if a binding cannot be used |
| Context menu | Add or verify keyboard invocation without duplicating application/global menu handlers |
| Gestures / lightbox | Include Space-drag, middle-drag, Mod-drag relationships, and preview arrows/Escape in help; they are not ordinary palette callbacks |

Never bind `Mod+R` or `Mod+P`. Only prevent default for a supported, eligible
action in its valid scope. Check `defaultPrevented`, composition, repeat on
destructive commands, platform modifiers, keyboard layouts, and nested editable
targets. Cover input, textarea, select, inherited contenteditable, and modal
editors. The current guard checks `[contenteditable=true]`; audit other editable
forms. Do not broaden global commands into text fields in this pass.

Make `?` a searchable, grouped shortcut reference, not just a filtered command
list. Include alternate bindings, active-surface meanings, gestures, lightbox
keys, Escape priority, and commands with no dedicated shortcut. Use the same
platform formatter for palette, tooltips, dock, menus, and help: Command glyphs
on macOS and Ctrl text on Windows/Linux. Resolve the platform at runtime.
Localize labels, reasons, aliases, and announcements through Lingui.

## 4. Verification plan

Extend existing Playwright suites with sequences, not only isolated button checks.
Use fixture repositories and semantic locators; avoid time-based sleeps and
rank positions that change with translations or recents.

1. **Palette → drawer → dock → Canvas:** run Show Folders, choose an unplaced
   `@` result, verify Assets selection and row focus; place it through the
   existing placement flow, verify auto-hide and Canvas ownership; use single
   dock Inspect, then Fit selection; close Inspector and continue Canvas input.
2. **Placed asset navigation:** search by filename, tag, and nested path; choose
   a placed result; assert reveal, single dock, and focus without changing
   placement. Repeat after repository switch and delayed/failed asset loading.
3. **Keyboard-only:** open palette, type `>`, navigate enabled and disabled
   results, Tab/Shift+Tab within dialog, Enter exactly once, and Escape restore.
   Open drawers, focus requested editors, invoke context menu by keyboard,
   close it, and resume selection. Assert pointer hover does not steal a focused
   palette result. Use an existing non-drag placement path for keyboard-only work.
4. **Dock progression:** idle → single → multiple → single → idle. Verify
   counts, catalog eligibility, set rules, mutation outcomes, focus after a
   disappearing action, and no accidental background gesture from dock clicks.
5. **Safety and recents:** disabled Enter stays open; failed command is not
   recent; successful commands deduplicate; purge opens exactly one count-aware
   confirmation; cancel changes nothing and does not add a completed recent.
6. **Overlay and Focus Canvas:** compare host bounds/viewport through open,
   resize, pin, successful/failed drop, and Focus Canvas entry/exit. Test no hide
   during drag, retained pin/open state, visible exit, palette access, and no
   keyboard focus into hidden chrome. Test layered Escape one layer at a time.
7. **Shortcut guards:** exercise search, rename, prompt, tag, select, and
   contenteditable fields; assert native select/copy/paste/undo and typed `?`
   remain native. Check reserved R/P events are not prevented. Test unavailable
   grouping, layout-sensitive zoom keys, platform hints and redo aliases.
8. **Narrow viewport:** cover 360px and the existing drawer breakpoint, plus a
   short viewport. Verify palette/footer fit, scrolling active results, long
   repository names, single-drawer presentation, reachable dock actions, focus
   visibility, and no document-level horizontal overflow. Repeat with reduced
   motion and keyboard-only input.

Keep pure tests under `bun:test` for fuzzy ranking/highlight offsets, prefix
parsing, stable ties, eligibility, recents outcomes, shortcut normalization,
platform aliases, and editable/scope classification. Browser event behavior and
focus handoffs remain E2E responsibilities. Platform simulation checks hints
and dispatcher logic; it does not prove physical OS shortcuts are available.

## Delivery order and completion gate

1. Inventory action entry points and record catalog/shortcut parity gaps.
2. Specify execution outcomes and focus handoff; close recents and async gaps.
3. Polish search states, highlighting, help, and platform hints.
4. Unify chrome/menu action metadata; polish morphing, narrow layout, and focus.
5. Add sequence coverage and run relevant existing behavior suites.

Complete when all visible commands have catalog access, hints match dispatch,
keyboard-only sequences work, hidden chrome is inert, reserved shortcuts remain
native, lifecycle semantics are unchanged, and viewport bounds remain stable.
### Implementation slice: destructive confirmation and palette focus

- Palette Trash and Purge now use the existing lifecycle dialog. The dialog
  states the affected asset count and offers separate trash and permanent-delete
  wording. Cancel clears the pending operation without changing selection or
  data. Unplace remains reversible and does not ask for confirmation.
- Palette closure no longer restores focus to its opener before command actions
  run. Asset/Inspector navigation focuses a visible control in the requested
  drawer. Palette lifecycle mutations return focus to the Canvas host.
- Validation: `bunx tsc --noEmit` in `frontend` passed. Playwright was not run
  because Chromium is missing in this environment.

### Review verdict: partial

Code review only; browser focus, trapping, and event behavior remain unverified.
The E2E worker owns browser verification. The earlier slice notes describe
implemented paths, not completion of the contract.

- **Recents and eligibility:** The palette rechecks the current catalog entry
  before running it, and disabled results remain open. Recents are distinct,
  capped at six, and async rejections are reported without an update. However,
  confirmation-opening actions count before confirmation, including on cancel;
  help and palette-opening commands count too. Some callbacks return without
  completing an operation. Synchronous throws are not caught by
  `Promise.resolve(currentAction.execute())`. There is no explicit outcome
  contract or eligibility recheck after the deferred animation frame.
- **Lifecycle:** The dialog displays a pluralized count for the captured IDs,
  and cancel clears the pending IDs. Canvas trash and purge open it; reversible
  unplace does not. Assets trash instead calls `remove(false)` directly and
  bypasses confirmation. Submission has no pending guard, so repeat activation
  can start duplicate requests. Confirmation focus and cancel restoration need
  browser verification.
- **Keyboard:** The global dispatcher excludes inputs, textareas, selects,
  editable ancestors, and dialogs for ordinary shortcuts, and checks composition,
  repeat, and default prevention. Those checks occur after Space and Escape
  handling; composition or a previously handled Escape can still change state.
  The palette's own Enter and arrow handlers do not guard composition. Its
  popup intercepts Enter from the retry button, which can prevent retry.
- **Focus and accessibility:** Base UI provides the dialog primitives and the
  palette has a title, description, combobox, listbox, options, and live count.
  Reviewed top-island icon buttons have accessible names. Focus trapping and
  restoration require browser verification. Dismissal has no connected/visible
  opener check or Canvas fallback. Action handoff relies on action-ID substrings
  and English `aria-label` selectors, so it fails in translated locales and
  can focus the wrong control or no control. Placed and unplaced `@` results
  update selection but do not explicitly focus the node or revealed row;
  missing assets fail silently. Confirmation can compete with the scheduled
  Canvas focus. Pending handoffs are not canceled on later state changes.
- **Asset search:** Loading, error, retry, empty states, non-trashed filtering,
  and late-response cancellation exist. Filename, path, and tags are searched
  and highlighted, but normalized offsets are applied directly to original
  characters, producing incorrect Unicode/accent highlights. Results are capped
  at 50 without explaining the limit; the displayed count is only the capped
  count. Loading and error content, including an interactive retry button, are
  placed inside the listbox rather than outside its option structure.
- **Shortcut reference:** Searchable category headings and catalog aliases are
  present, with runtime Mac/non-Mac key glyphs via `ShortcutKeys`. It omits
  gestures, lightbox keys, Escape priority, and commands without shortcuts.
  It shows the `Ctrl+Y` alias on macOS even though dispatch excludes it.
  Grouped visual order can differ from the flat keyboard navigation order, and
  disabled help results do not show their reasons. The formatter duplicates
  rather than shares `displayShortcut`.
- **Localization:** New palette status, hint, and footer text uses Lingui.
  The confirmation's `Cancel` button is plain text, and catalog aliases remain
  untranslated. Review the conditional plural messages for extraction and
  translation, and remove locale-dependent DOM selectors.
- Remaining gaps include palette asset loading/highlighting and grouped
  shortcut help, plus broader focus handoffs for command types not covered by
  this slice.

### Implementation slice: asset states and grouped shortcut reference

- The `@` asset search now clears stale results on palette/repository changes,
  reports loading and failure states, and offers retry. Filename, path, and tag
  evidence is highlighted in matching results.
- The `?` reference groups catalog shortcuts by their action category and shows
  all catalog shortcut aliases with the shared platform-aware shortcut display.
  It retains the palette's combobox/listbox semantics and searchable results.
- Validation: `bunx tsc --noEmit` in `frontend` passed. Playwright was not run
  because Chromium is missing in this environment.

### Terra review correctness follow-up

- Assets Trash now opens the count-aware lifecycle confirmation used for Purge.
- Trash and Purge are recorded as recent only after confirmation and successful
  completion. The confirmation blocks repeat submission while a request is
  pending.
- Localized the confirmation Cancel label and catalog aliases with Lingui.
- Validation: `bunx tsc --noEmit` passed. Playwright was not run.

### Palette final polish follow-up

- Match highlights map normalized Unicode offsets back to displayed characters,
  including decomposed accents and supplementary characters.
- Shortcut groups now use the same flattened category order for display and
  keyboard navigation. The asset empty state explains the 50-result cap.
- Palette navigation and activation ignore IME composition events. Enter on the
  retry button remains a native button activation and does not run the selected
  palette result.
- Validation: `bunx tsc --noEmit` passed. Playwright was not run.
