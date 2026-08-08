# Panel unification, session-scoped undo, live Explorer + FS management — spec addendum

Supplements `docs/init.md`, which stays as originally written except where noted below.
This addendum resolves several usability gaps found once Stages 1–5 were in daily use, and
fills in parts of Stage 2 ("File lifecycle management") that were speced but never built.

## Supersedes: Stage 4's separate-route Library design

`docs/init.md` Stage 4 originally speced Library as "a second route alongside the canvas,"
connected to the board via a cross-navigation pair (canvas "find in list" ↔ list "show on
board"). In practice this made it impossible to drag an item from the list directly onto a
board, since the two views were never visible at once.

**New design**: Board and Library live on one screen. A single floating panel — following
Stage 1's existing "floating overlay (not a layout sibling)" control-panel design, exactly
the same mechanism `CanvasToolbar` and the old `SidePanel` already used — now hosts three
switchable views:

- **Library** — the existing flat, filterable list (unchanged in content, moved from its own
  route into a panel tab).
- **Explorer** — new. A live view of the on-disk directory tree under the repo root, distinct
  from Library's DB-backed flat list. Folders are fetched lazily (only on expand, via a new
  non-recursive directory-listing backend call) and the rendered row list is virtualized, so
  neither backend load nor DOM size scales with total repo file count.
- **Detail** — the per-image inspector, previously a separate floating `SidePanel` shown on
  canvas selection; now a tab in the same panel instead of a second floating element.

All three tabs stay mounted simultaneously (visibility toggled via CSS, not conditional
render), so switching tabs or hiding the panel never resets a tab's scroll position, filters,
tree-expansion state, or selection.

The panel is dockable left or right and independently toggleable, backed by two new
`settings` keys (`panel_visible`, `panel_dock_side`) with hardcoded defaults — following the
same "settings storage with sensible defaults now, editing UI later" convention `docs/init.md`
already establishes for other Stage-1 settings.

The panel also now hosts the board switcher (top) and a repo switcher (bottom — see below);
the top bar (`TopNav`) that previously held these, plus undo/redo buttons and the repo name,
is removed entirely.

## Fills in: Stage 2 file-lifecycle gaps

Three Stage-2-speced behaviors existed only as schema/comments, not working code, until now:

- **Trash didn't physically move files.** The original Stage 2 text says trashing "moves the
  file to `.loom/trash/` and flags the DB row" — the implementation only ever did the flag.
  Fixed: trash/restore (and their undo/redo inverses) now perform the actual file move, with
  collision-suffixing on the trash destination.
- **In-app rename/move** (Stage 2's "in-app rename/move... updates `file_path` atomically")
  is implemented for the first time, surfaced through the new Explorer tab: drag a file onto
  a different folder to move it, or rename it in place. Fully undoable, same as every other
  mutation.
- **Directory listing** is new infrastructure Stage 2 never anticipated needing on its own —
  it exists specifically to back Explorer's live tree, and reuses the same "auto-register on
  sight" policy `ScanAndRegisterImages` already applies globally, just scoped lazily to one
  directory at a time.

Hash-based reconciliation ("manual rescan" — detecting externally renamed/modified files via
`content_hash`) remains deferred, matching Stage 2's original framing of it as a distinct,
separately-triggered maintenance action, not bundled into this pass.

## Extends: Stage 5 undo/redo

- **Session-scoping**: undo/redo previously read the entire `operation_log` with no
  boundary, so it could reach back across app restarts. It's now bounded to the current
  process's session — history from prior runs stays in the database, untouched, but is
  invisible to undo/redo once the app restarts.
- **Groups are now undoable.** `docs/init.md`'s Stage 5 undo minimum never listed group
  actions, and none of `GroupService`'s five mutating methods (create, ungroup, add member,
  remove member, set cover) ever recorded an operation — the only mutating service in the
  codebase with that gap. All five now participate in the same op-log mechanism as every
  other action.
- **Rename/move** (above) is undoable through the same mechanism.

## New: multi-window repo switching

`docs/init.md`'s Repo model section states the single-window-per-repo invariant ("opening an
already-open repo focuses its existing window rather than opening a second one") but this was
never implemented — `ListRecentRepos` only tracked "opened at some point," nothing tracked
which repos currently have a live window. This addendum implements it for real: an in-process
registry maps repo path → window, backed by Wails v3's actual window APIs (`Window.Focus()`,
`WindowManager.GetByID`/`NewWithOptions`, `OnWindowEvent(events.Common.WindowClosing, ...)`
for registry cleanup on close). A repo-switcher at the bottom of the floating panel lists
recent repos, distinguishing ones already open elsewhere (selecting one focuses that window)
from closed ones (selecting one opens a genuinely new window).

## New: Settings screen

`docs/init.md` listed a full settings UI as an "Anytime item" — deferred, not core. This
addendum builds a minimal one now, specifically to give the Manual/Auto layout-mode toggle
(previously a `TopNav` button) a home after `TopNav`'s removal. A generic `SettingsService`
(get/set over the existing per-repo `settings` table) backs it, though this pass's only
actual settings-table consumers remain the panel visibility/dock-side keys above — layout
mode itself keeps using its existing dedicated `boards.layout_mode` column.

## Component consistency

While auditing the Select double-border bug (a native `<select>` missing `appearance-none`,
fixed by building a proper `components/ui/select.tsx` on the already-present
`@base-ui-components/react` primitives — the stack `docs/init.md` already commits to, just
never actually used for Select), a second instance of the same root cause turned up:
`board-switcher.tsx` hand-replicates the `Button` component's `ghost` variant instead of
using it. Fixed alongside that component's relocation into the panel. A broader
finding — no shared `Input`/`Checkbox` primitive exists anywhere, so several raw `<input>`s
are each styled independently — is noted here as a known latent-drift risk, not yet actioned;
revisit if another concrete rendering bug traces back to it.
