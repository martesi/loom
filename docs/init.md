# Loom — design spec

Local-first desktop app for managing image files and the derivation
relationships between them (which images were used to build which other
images), with prompt tracking, tagging, and multi-board organization.

Origin problem: Obsidian's canvas becomes laggy at zoom because it decodes
full-resolution image embeds on every repaint. Loom's core performance fix is
architectural — the canvas only ever renders small cached thumbnails; full
files are touched rarely (open, export, convert).

## Stack

- **Backend**: Go + Wails v3 (beta) — chosen over v2 for the static-analysis
  binding generator (better generated TS, preserves comments/param names).
  Beta status is acceptable here since this is a personal tool, not something
  shipped under external compatibility guarantees. Fallback path if v3 proves
  too unstable: swap to Wails v2, which only touches the backend bootstrap —
  schema and frontend are unaffected.
- **DB**: SQLite via `modernc.org/sqlite` (pure Go, no cgo — simplifies
  cross-compilation).
- **Image conversion**: shells out to the user's existing ffmpeg + SVT-AV1
  pipeline via `os/exec`, preserving already-tuned encode parameters exactly.
  Bundled as a Wails sidecar binary in production builds. Framed as a
  candidate plugin, not a hardcoded core assumption — see Stage 4.
- **File watching**: `rjeczalik/notify` — chosen over `fsnotify` for native
  recursive watching (FSEvents on macOS, `ReadDirectoryChangesW` on Windows;
  Linux inotify has no native recursive mode, so there the library performs
  the per-directory subtree walk for us rather than it being hand-rolled).
  The repo's `.loom/` folder is always **excluded** from the watch, or
  thumbnail/DB writes would trigger a change-notification feedback loop.
- **Frontend**: React 19 + React Compiler, TanStack Router, Vite 8,
  Tailwind v4, shadcn/ui (base-ui primitives), Lingui (vite plugin, `.po`
  files, no compile step), Biome (single quote / no semi / ES5 trailing
  comma), TypeScript 7, Bun.
- **Canvas/graph rendering**: a virtualized node-graph library (e.g.
  react-flow or equivalent) — needs to support hundreds of nodes at 60fps and
  a custom low-zoom LOD rendering path (see Stage 3).
- **Layout algorithm**: **d3-dag** for auto-layout mode (dagre-compatible
  API as an easy starting point, with `sugiyama`/`decrossOpt` available to
  upgrade quality later without switching libraries — see Algorithm Notes).
  Manual-mode "auto-arrange selection" uses d3-dag for the cluster's
  internal shape, then a simple bounding-box offset for placement (v1) —
  true interior-gap-avoiding packing is shelved, not solved out of the box
  by any layout library, and not needed for v1 (see Stage 3, Algorithm
  Notes).
- **Image lightbox/preview**: an existing library (e.g. Fancybox or
  equivalent) — not hand-rolled.

---

## Data model (SQLite)

Core tables, evolved through the conversation to their final shape:

- **`prompts`** — `id`, `name` (nullable, free-form label, e.g. "prompt 1" —
  not required, not enforced-unique), `prompt_hash` (unique, dedup key —
  hashed over `text` **and** `negative` together, with an empty `negative`
  hashed consistently so the pair is always the unit), `text`, `negative`,
  `created_at`. One row per distinct `text+negative` pair, optionally wearing
  a name — dedup (FindOrCreate-by-hash) and naming don't conflict. Prompts
  form a small **managed library**: you browse/pick an existing one by name
  (or by text snippet when unnamed), or create a new one. Each row's stable
  `id` means rename/edit-name needs no migration later. Usage count is
  *always* computed (`COUNT(*) FROM images WHERE prompt_id = ?`), never
  stored, so it can't drift.
- **`images`** — `id`, `file_path`, `thumb_path`, `prompt_id` (nullable FK),
  `width`, `height`, `file_size`, `content_hash` (nullable, populated only on
  manual rescan — see Stage 2), `archived` (bool), `trashed` (bool, separate
  from archived), `canvas_x`, `canvas_y`, `group_id` (nullable),
  `created_at`, `updated_at`.
- **`relationships`** — directed edges: `id`, `source_image_id`,
  `derived_image_id`. A derived image can have multiple sources (multi-input
  composition). This join table *is* the graph — no separate graph DB needed
  at this scale (hundreds of images). **The graph must stay acyclic**: link
  creation rejects any edge that would introduce a cycle (a reachability
  check from `derived` back to `source` before insert), since the whole graph
  is consumed by the DAG-layout library (Stage 3) and a cycle would break it.
- **`tags`** + **`image_tags`** — tags target images only (not boards or
  variant groups, per explicit decision). Free-form (no central managed
  list) — but `tags` still has its own `id` per row, not just a string
  stored directly on the join table, so rename/merge/delete-everywhere
  operations can be added later without a migration.
- **`boards`** + **`board_images`** (many-to-many — an image can belong to
  multiple boards, per explicit decision) — `boards` also carries a
  `layout_mode` column (`auto` | `manual`), since layout mode is per-board.
  **Board membership is never inferred, only explicit** — see "New image →
  board assignment" below.
- **`groups`** — a generic **image set**: sibling images shown together,
  rather than parent/child (distinct concept from `relationships`).
  Generalized from the original "variant group" (alternate takes from the
  same input) to also cover sets like multi-angle turnarounds or sequences —
  the mechanics are identical, only the meaning differs. Columns: `id`,
  `name` (nullable, e.g. "dragon — turnaround"), `kind` (nullable hint —
  `variant` | `angles` | `sequence` | free-form; **display/filter metadata
  only, drives nothing structural in v1**, but lets an angle-set later render
  or filter differently without a migration), `cover_image_id` (nullable FK
  into `images` — the user-chosen representative shown when the group is
  collapsed on canvas). Relationship edges always attach to a specific member
  image, never to the group itself (see Group interaction rules in Stage 3).
- **`settings`** — key-value, split into **global** (language, recent-opened
  repo list) and **per-repo** (theme, accent, trash retention period, layout
  preferences, notification/bundling toggles). Per-repo settings live in that
  repo's `.loom/` folder; global settings live outside any repo, in a
  standard app-config location.
- **Operation log** (for undo/redo — see Stage 5) — append-only log of
  invertible actions, not yet schema-detailed.

### File identity model

Path is the fast-path identity signal. Hash (`content_hash`) is **not**
computed on every startup — that was explicitly rejected as unnecessary
overhead. Instead:

- **Startup**: lightweight — check that known paths still exist, flag
  missing ones. That's it.
- **Manual rescan** (triggered from Settings as a maintenance action):
  full reconciliation — compute hashes, detect renames/moves (path missing +
  hash matches an existing row → offer relink), detect in-place modification
  (path matches, hash differs → flag for user confirmation), detect genuinely
  new files (no path or hash match → create row, unlinked).
- Use a fast non-cryptographic hash (e.g. xxHash/BLAKE3) — this is
  change-detection, not integrity-critical, so cryptographic strength is
  unnecessary overhead.

### Metadata: DB only, no file writes (for now)

All relational metadata (prompt linkage, relationships, boards, tags, variant
groups, archive/trash state, canvas position) lives in SQLite only. Explicit
decision: **no writing to file EXIF/XMP at this stage** — deferred, not
abandoned (see Open Questions). Reasoning that was worked through and then
superseded by this final call: relational metadata (edges, board membership)
doesn't have a clean single-file representation anyway, so DB-only is a
reasonable permanent home for it regardless. Flat/portable data like prompt
text *could* still be embedded in files later without conflicting with this
decision.

One exception that survives: when the AVIF-conversion action runs, it copies
over existing EXIF/XMP metadata **from the original file into the converted
file**, best-effort, where present. This is preserving pre-existing metadata,
not writing new relational metadata — doesn't reopen the DB-only decision.

---

## Repo model

The app operates like Obsidian: point it at a folder ("open repo"), and it
creates a hidden `.loom/` inside that folder holding the SQLite DB, thumbnail
cache, trash folder, and per-repo settings. Implications:

- App needs a "recent repos" / open-folder launcher as its real entry point,
  plus a no-repo-open landing state.
- Supports **multiple windows**, each on a **different** open repo —
  single-window-per-repo is an enforced invariant: opening an already-open
  repo focuses its existing window rather than opening a second one. This
  keeps SQLite writes, cache invalidation, and the undo stack single-owner
  per repo, so nothing downstream has to reason about same-repo concurrency.
- Thumbnails and trash live inside `.loom/`, keeping the repo folder clean
  from an external file-explorer's perspective (real images + one hidden
  folder, no scattered app cruft).
- Git-sync / cross-machine sync of `.loom/` is a non-concern — image
  collections are too large and the DB is binary; not worth designing for.
- Folder scanning is **recursive** (subfolders included, not just repo root).

### New image → board assignment (resolved)

Newly discovered/imported/registered images get **no board membership by
default** — they land "unsorted," visible via the list/library view (Stage
4) and an "unassigned" filter, but not shown on any canvas until explicitly
placed. This was worked through as a real question and resolved as follows,
worth recording since the reasoning isn't obvious from the schema alone:

- **A repo already answers "what group is this image part of."** Boards are
  a finer-grained organizing tool *within* one already-scoped repo, not a
  second layer of "which universe does this belong to" — if the intent is
  to keep two sets of images from mixing at all, that's what separate repos
  are for. So boards don't need (and shouldn't have) inference logic trying
  to guess where a new image "should" go — there's no ambiguity to resolve,
  because the repo already did that job.
- **Relationships can't drive board placement**, because relating happens
  *after* an image is already placed somewhere with something to connect
  it to — there's no source/derived link to infer a board from at the
  moment of import. (An earlier draft of this spec proposed inheriting the
  source's board automatically; that was based on a wrong assumption about
  ordering and is superseded by this section.)
- **Placement is always explicit**: drag from the list onto a board, or a
  batch "add selection to board" action — currently the only board-population
  mechanism (folder-based auto-suggestion was considered and deferred; see
  Stage 6 — it didn't match how boards are actually meant to be used, so
  it's pulled out pending a separate discussion rather than assumed as a
  bulk variant of manual placement).

---

## Build stages

Ordered so each stage is independently useful and later stages don't require
re-architecting earlier ones. **Anytime items** (below the staged list) are
deliberately pulled out of this sequence — they don't change any earlier
stage's architecture, so slotting them in early or late is purely a
scheduling choice, not a dependency one. Keeping them out of the numbered
stages means the fastest path to a mostly-complete, usable app is just
Stages 1–5 without stopping for polish along the way.

### Stage 1 — Core CRUD + single-repo canvas (MVP)

The minimum needed to replace the Obsidian workflow.

- Repo open/create (`.loom/` bootstrap, SQLite init + migrations).
- `images`, `prompts`, `relationships` tables and backend services
  (register, list, link/unlink source, archive toggle, delete).
- Manual prompt attach/reuse picker — a browse-and-pick list over the managed
  prompt library (shows `name`, falling back to a text snippet when unnamed),
  backed by FindOrCreate-by-hash (over `text+negative`) so picking and dedup
  don't fight. Prompt automation from generation tooling is explicitly out of
  scope for now.
- Canvas view: renders non-archived images as thumbnail nodes, draws edges
  for relationships, supports pan/zoom, drag-to-reposition (manual layout
  only at this stage).
- Manual "link source" interaction: multi-select images, drag onto a target
  → creates source→derived edges. No confirmation dialog (see Stage 5 re:
  undo replacing warnings).
- Thumbnail generation: triggered on import/discovery (not lazily on view),
  output format AVIF. For **video** files (in scope generally — see Stage 4),
  the thumbnail is the **midpoint frame** extracted via ffmpeg. Quality/size
  *values* are anytime-tunable (see Anytime Items) — but the generation
  pipeline itself (the mechanism that produces and stores a thumbnail per
  image) is core and belongs here.
  - Note on the AVIF-thumbnail choice vs. the core perf premise: AVIF decode
    is ~2–3× WebP per image, but since canvas nodes render as DOM `<img>` the
    webview decodes each thumbnail **once** and caches the bitmap — pan/zoom
    repaints reuse the cache regardless of source format, so AVIF costs only a
    one-time board-load decode (low hundreds of ms for a large board), never a
    per-frame tax. This assumption holds only while node rendering is
    DOM-`<img>`-based; a future move to `<canvas>`/WebGL would need thumbnails
    pre-decoded to `ImageBitmap` once. (The memory cost — decoded RGBA bitmaps
    resident for visible nodes — is identical for AVIF and WebP.)
- Startup reconciliation: lightweight only — flag missing files, do not hash.
- Control panel UI: floating overlay (not a layout sibling), functional
  left/right dock and show/hide — needs to exist for the app to be usable at
  all. Visible-by-default behavior, default side, and shortcut bindings are
  anytime items (see below); the panel mechanism itself is not.
- **Settings storage, with hardcoded defaults, wired UI deferred**: every
  setting mentioned anywhere in this spec (thumbnail quality/size, trash
  retention, theme, accent, dock side, panel visibility, LOD toggle, etc.)
  gets a real row/key in the `settings` store (global or per-repo, per the
  split decided earlier) **with a sensible default value from day one** —
  the app should behave as if fully configured from the start, just not
  configurable yet. Building a settings *screen* to edit these values is a
  separate, later piece of work (anytime item — see below); until that
  exists, defaults are simply what's in the store, unexposed to the user.
  This ordering (data model + defaults first, UI last) avoids two passes
  over the same features — each feature's default just gets written once,
  correctly, when that feature is built, rather than hardcoded inline now
  and migrated into `settings` later.
- **Default keyboard shortcuts**: a committed starting set, standard
  OS-idiomatic bindings for actions with a clear, common convention
  (user-remapping UI and any additional bindings beyond this set are
  anytime — see Anytime Items):
  - `Ctrl/Cmd+C` — copy selected image(s) **as-is**, i.e. the original file
    currently on disk (whatever format it's actually stored in — AVIF if
    already converted, original format otherwise). A straight file copy to
    clipboard, no conversion step involved.
  - `Ctrl/Cmd+Shift+C` — copy selected image(s) **converted**, using the
    configured widely-compatible export format (JPG/WebP copy-out path from
    ConvertService) — this is the "so they can be used in other tools"
    path from the original requirements, distinct from the plain-copy
    binding above.
  - `Ctrl/Cmd+V` — paste image(s) from clipboard into the current
    board/repo (import path). Raw clipboard bitmap data (no source file on
    disk) is written as `Untitled.<ext>` at repo root — `<ext>` inferred from
    the clipboard image's actual encoding — with collision suffixing
    (`Untitled 1.png`, `Untitled 2.png`, …).
  - `Ctrl/Cmd+A` — select all (scoped to current board/list view).
  - `Delete` **and** `Backspace` — both trigger the same action (trash
    selected image(s)); bound together because convention differs by OS/
    keyboard (Windows favors `Delete`; macOS keyboards commonly lack a
    forward-delete key and use `Backspace` for the same intent) — binding
    both avoids guessing wrong for half the users.
  - `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y` on Windows) —
    undo/redo. Only becomes functional once Stage 5 lands; the binding can
    still be reserved now.

### Stage 2 — File lifecycle management

Everything to do with files changing state or location, safely.

- **Trash** (distinct from archive): trashing moves the file to `.loom/trash/`
  and flags the DB row; archive is DB-flag-only, file stays in place. Trash
  auto-purges after a configurable retention period (hard-deletes file + DB
  row, cascading relationship rows). Restore-from-trash moves the file back.
- **AVIF conversion as a destructive, user-triggered mutation**: not
  automatic on import. User triggers conversion → ffmpeg produces the AVIF →
  original file moves to trash (recoverable) → DB row's `file_path` updates
  to the new AVIF path, while the row's identity (relationships, tags,
  boards, prompt link) persists across the transition. This reuses the same
  "path changes, ID persists" mechanism as a manual rename.
  - Metadata copy-through: existing EXIF/XMP from the original is copied into
    the converted file, best-effort.
  - Compression quality/parameters configurable in per-repo settings,
    same mechanism/location as thumbnail settings.
- **In-app rename/move**: performing these from within Loom updates
  `file_path` atomically as part of the same action — no reconciliation
  needed for app-initiated changes.
- **Manual rescan** (Settings → maintenance action): full hash-based
  reconciliation as described in the data model section above — detects
  external renames/moves, in-place modifications, and confirms with the user
  before relinking or flagging.
- **Missing file handling**: if a row's file is missing from disk, the
  canvas still shows its thumbnail (cached separately) with a visible
  "missing" warning state, rather than hiding the node.
- **Reveal in file explorer**: per-image action, OS-native "show in
  folder." Surfaced via right-click context menu (see Stage 3 for the
  context-menu mechanism itself, introduced there since canvas nodes are
  the primary place this and related per-image actions get triggered from).

### Stage 3 — Canvas UX: boards, layout, LOD

The canvas-specific complexity — this is the densest frontend stage.

- **Multi-board support**: `boards` + `board_images` (many-to-many, an image
  can belong to multiple boards). Board = a scoped canvas, keeping any single
  view navigable as the collection grows.
- **Context menu (right-click) on canvas nodes**: the mechanism itself is
  core to this stage — a per-image right-click menu is where several
  per-image actions live, rather than scattering them as separate always-
  visible buttons. Minimum actions wired in for v1: **reveal in file
  explorer** (Stage 2), **find in list/library view** (jump to and
  highlight this image's row in the Stage 4 list view — the canvas → list
  direction of the cross-navigation pair below), archive, trash. Additional
  actions (open preview, add/remove tags, add/remove board, set as variant
  cover) get added to this same menu as their owning features land — the
  menu is the shared home for per-image actions going forward, not a
  one-time fixed list.
- **Board auto-suggestion from folder structure**: **deferred — pulled out
  of Stage 3 entirely**, not just its toggle. This was previously written in
  as a Stage-3-core mechanism, but folder-based categorization doesn't
  actually match how boards are meant to be organized in practice (boards
  are a deliberate, explicit organizing tool — see "New image → board
  assignment" above) — so building this now risks encoding a wrong model.
  Move to Stage 6 (Deferred) pending a separate discussion of whether, and
  in what form, any auto-suggestion makes sense at all. Manual "add
  selection to board" (already in Stage 3 core) is the only board-population
  mechanism for now.
- **Layout mode is per-board**: `auto` or `manual`.
  - **Auto mode**: the board continuously re-arranges as the graph changes,
    via the DAG-layout library (d3-dag — see Algorithm Notes below).
  - **Manual mode**: positions are sticky (`canvas_x`/`canvas_y`), connection
    lines just draw between wherever nodes currently sit. "Auto-arrange" is
    available as a one-shot, user-triggered action **scoped only to the
    currently selected nodes** — never touches unselected nodes' positions.
    Placement for v1: lay out the selected cluster in isolation (via
    d3-dag), then place the resulting shape just past the bounding box of
    all currently-placed nodes (below or to the right — pick one
    consistently). This is a single offset calculation, not a search —
    deliberately simple over space-efficient.
    - The earlier idea of a second "fit into existing interior gaps"
      strategy is **shelved, not implemented for v1** — genuine
      obstacle-avoiding packing (placing a new cluster into leftover
      interior space without disturbing anything already there) is a real
      but nontrivial problem with no off-the-shelf solution (see Algorithm
      Notes below), and manually repositioning after an outward placement
      is a fine workaround given people don't reorganize boards especially
      often day to day. Revisit as an anytime item if it turns out to
      matter in practice.
- **Group display + interaction**: images in the same `group_id` are shown
  together (e.g. stacked/carousel node) rather than as separate nodes linked
  by derivation arrows, since they're siblings, not parent/child. Core, since
  `group_id` is part of the base schema and ungrouped display would
  misrepresent the data. Collapsed state renders the group's chosen
  `cover_image_id` thumbnail; a per-group "set as cover" action is part of
  this same piece of work. Following a relationship edge into a non-cover
  member of a collapsed group must auto-expand that group and focus the
  specific member — this "reveal member" behavior is core to this bullet, not
  an anytime add-on, since a relationship that silently resolves to the wrong
  visible image would be a correctness bug, not a missing nicety.
  - **Creation / membership actions** (context menu): "Group as set" on a
    multi-selection (cover defaults to the first selected), plus "add to
    set", "remove from set", "ungroup", and "set as cover". `name` and `kind`
    are set at creation or edited later.
  - **Edge ↔ group interaction rules** (these keep edges attached to specific
    members while making group-drop convenient):
    - Dropping a source onto a collapsed group **fans out to one real edge
      per member** (source→each member), stored as normal per-member edges —
      justified because members are alternates/angles of one derivation, so
      "this source produced this set" means it produced each. For an
      original-capture set with no upstream source, you simply never draw this
      edge and the rule doesn't fire.
    - A group **cannot be the _source_** of an edge (which member would be the
      source is ambiguous) — expand and drag from a specific member instead.
    - **Removing a member** from a group **keeps** any edges it had — it
      becomes a standalone derived image, its edges don't vanish.
- **Image preview/lightbox**: integrate an existing library (e.g. Fancybox)
  for full-res viewing without leaving canvas. Pulled back into core (out of
  Anytime Items) — this is a daily-use path, not polish: viewing images is a
  primary way the app gets used, not an edge case to defer.
- **Edge removal**: no confirmation dialog — undo (Stage 5) is the safety
  net, not a warning prompt. Note this only fully applies once Stage 5
  lands; until then, edge removal is simply irreversible in the UI, which is
  acceptable for an early build.

Pulled out as anytime items (see below): LOD/edge-bundling at low zoom and
ancestry/descendant highlighting. Neither changes how the canvas is built —
they layer on top of a working canvas rather than shaping it. (Image
lightbox/preview was previously listed here too; moved back into this
stage's core list above.)

**Algorithm notes (research findings, kept here for implementer reference):**

- **DAG auto-layout**: evaluated dagre, d3-dag, and elkjs. **d3-dag chosen.**
  Reasoning: it ships a dagre-compatible API (near-zero cost to start simple)
  while offering a documented upgrade path — `sugiyama().decross(decrossOpt())`
  — to better edge-crossing minimization later without switching libraries.
  elkjs is more powerful but is explicitly flagged by both the React Flow and
  Svelte Flow docs as high-complexity/hard-to-support, and its ~500KB
  transpiled-Java bundle is unjustified overhead for hundreds of nodes with
  fairly simple DAG shape.
- **"Fit selection into existing interior gaps" (obstacle-avoiding packing)**:
  researched and **shelved for v1**, per above. This is a real, named class
  of problem in graph-drawing literature (see "gap-avoiding rectangle
  packing" research, and ELK's dedicated Rectangle Packing algorithm/mode),
  but none of it directly solves "insert a new cluster into an
  already-occupied layout without disturbing what's there" — that specific
  framing has no ready off-the-shelf library solution, only general
  techniques (e.g. first-fit-descending-style bin-packing heuristics) that
  would need custom implementation. Not worth the complexity for v1 given
  boards aren't reorganized especially often. If revisited later: the
  general shape would be treating unselected node bounding boxes as
  obstacles and running a first-fit search over open regions, or bringing in
  ELK specifically for its rectangle-packing mode without adopting elkjs for
  the main DAG layout.
- **v1 placement strategy** (bounding-box offset): lay out the selected
  cluster's internal shape via d3-dag in isolation, then place it just past
  the bounding box of all currently-placed board nodes (below or to the
  right, picked consistently). Deliberately simple over space-efficient.

### Stage 4 — Search, tags, list view, plugin boundary for conversion

Making a growing collection navigable, plus the format-conversion
architecture decision.

- **List/library view**: a second route alongside the canvas, sharing the
  same backend queries — table of thumbnail, prompt snippet, tags, board,
  date, archived/trashed state. Core: the "find" tool is what makes search
  usable at all. **Row context menu → "show on board/canvas"** (jump to and
  highlight this image on whichever board it's placed on, or prompt to pick
  one if it's on multiple) is core to this bullet, not an anytime add-on —
  it's the list-side half of the same cross-navigation pair introduced in
  Stage 3's canvas context menu (canvas → "find in list"), and the two
  should land together rather than one existing without the other.
- **Search**: targets prompt text, filename, tags, board. The underlying
  query/index is core; *where* it's surfaced (control panel vs. also a
  command palette) — command palette specifically is an anytime item, since
  the app is fully usable with panel-only search first.
- **Tags**: the schema and basic add/remove UI belong here (images
  reference tags elsewhere in this stage). Taxonomy style (free-form vs.
  managed/renameable) is an open question — see Open Questions — but
  whichever is picked, basic tagging needs to exist before search-by-tag
  does.
- **Batch operations**: multi-select on canvas or list, bulk
  archive/trash/tag/board-assign. Core-ish — pulled in because search/list
  view naturally produce multi-row selections that want a bulk action; a
  minimal version (select + one or two bulk actions) belongs here, richer
  bulk actions can expand later as an anytime item.
- **Format-conversion as a plugin boundary**: the app's core data model must
  not assume AVIF or any specific format anywhere structurally — format is a
  per-file attribute. Video files are explicitly in scope for the app to
  manage generally (not just images), with conversion remaining a strategy
  applied optionally, not a core assumption. This needs deciding *before*
  core CRUD hardcodes format assumptions, which is why it's flagged here
  rather than left fully open.

Pulled out as anytime items (see below): orphan view. It's a pure read-only
query over data this stage already has — no reason it needs to land in the
same pass as search/tags/batch-ops.

### Stage 5 — Undo/redo

Confirmed in scope (not deferred, per final decision — this reverses an
earlier "defer as nice-to-have" framing once its role as edge-removal's
safety net was established).

- Needs an operation log or command-pattern actions with defined inverses —
  architectural, not a bolt-on. Every mutating service method needs a
  corresponding inverse operation.
- Applies at minimum to: link/unlink relationship, archive/unarchive,
  trash/restore, tag add/remove, board add/remove, position change,
  layout-mode apply/auto-arrange.
- This is why edge removal (Stage 3) has no confirmation dialog — undo
  covers the mistake-recovery case more naturally than a prompt.
- **Undo is best-effort against hard-purge**: if an inverse operation's
  target was already hard-deleted (e.g. trash auto-purged after its retention
  period — Stage 2), the inverse **throws with the reason**, and undo
  **surfaces that reason to the user** ("Can't restore — file was purged from
  trash on <date>") rather than failing silently or corrupting the log.

---

## Anytime items

These don't gate, and aren't gated by, any specific stage above — each one
layers onto already-working functionality without changing its shape. Treat
this as a backlog to pull from whenever it's convenient (including "early,
because it's easy today"), rather than a phase to schedule. Grouped by what
they attach to, not by priority.

**Settings UI** (store + defaults already exist from Stage 1 — see above;
this is purely the screen/controls to change them):
- A settings screen that reads/writes the existing `settings` store —
  toggles, sliders, pickers for each value already living there with a
  default. No new data-model work implied by this item; it's UI-only.
- Thumbnail/conversion quality and size, made user-editable.
- Trash retention period.
- Theme, accent color (per-repo).
- Language (global).
- Control panel: default dock side, visible-by-default toggle,
  show/hide + reposition shortcut.
- LOD/edge-bundling on/off toggle and its zoom threshold (once LOD itself
  exists — see below).

**Canvas polish** (built on top of the working canvas from Stage 3):
- Level-of-detail rendering at low zoom — merged/bundled edges, stacked
  clusters. Custom cluster-detection + simplified-geometry logic; genuinely
  optional until the canvas is dense enough to need it.
- Ancestry/descendant highlighting on node select (recursive query, no
  schema change).
- Board notification batching (collapse multi-board-create into one
  notification) — works fine as one-notification-per-board until refined.

**Navigation/discovery polish** (built on top of Stage 4's list + search):
- Command palette as a second search surface alongside the panel.
- Orphan view (images with no relationships at all) — pure read-only query,
  no new writes.
- Richer batch actions beyond the minimal set shipped in Stage 4.

**File management niceties** (built on top of Stage 2's file lifecycle):
- Any additional manual-rescan UX polish (progress indicator, diff preview
  before committing relinks). (Reveal-in-file-explorer is core — see Stage 2
  / Stage 3 context menu.)

**Duplicate detection** (its own settings-gated function, separate from the
categories above since it's opt-in and self-contained):
- **Resolved as in-scope**, run as a distinct triggerable function from
  Settings rather than always-on background work.
- Must detect **similar**, not just identical, images — exact-hash matching
  (already present via `content_hash` from the manual rescan) is
  insufficient on its own and won't satisfy this. Needs a perceptual
  similarity method (e.g. perceptual/difference hashing such as pHash or
  dHash, comparing Hamming distance between hashes rather than requiring
  exact equality) computed per-image and compared pairwise or indexed for
  nearest-neighbor lookup.
- Because this needs its own computed value (a perceptual hash, distinct
  from `content_hash`) stored per image, it likely wants its own column or
  side table — worth deciding placement when this is actually built, but
  flagging now so it's not bolted on awkwardly later.

**Shortcuts** (mechanism-agnostic, can be added to any interaction as it's
built):
- Beyond the committed starting set in Stage 1 (copy/paste/select-all/
  delete/undo-redo), additional bindings (archive toggle, open preview,
  focus search, board switch, etc.) and user-remapping UI are anytime —
  add them as their owning actions get built.

### Stage 6 — Deferred / explicitly out of scope for now

Listed so they're known gaps, not silent omissions.

- **Prompt automation from generation tooling** (auto-populating prompt +
  relationships for images dropped in externally) — manual for now, revisit
  if it earns its place.
- **Writing metadata into files** (EXIF/XMP prompt embedding) — deferred,
  not abandoned; DB-only is the current design.
- **Export subgraph**: select a node + ancestry/descendants, export as a
  folder + manifest (JSON with paths, prompts, relationships) for sharing or
  portability. Concept agreed, exact manifest format not yet designed —
  revisit when there's bandwidth.
- **Board auto-suggestion/creation from folder structure**: pulled out of
  Stage 3 (was previously scoped in as core). Folder-based categorization
  doesn't fit the actual organizing model — boards are meant to be a
  deliberate, explicit tool, not a mirror of filesystem layout — so this
  needs a separate discussion about whether any automatic form makes sense
  at all before it's designed, rather than being built on the original
  assumption. Not committed to happening in any form.

---

## Open questions

Unresolved as of this spec — flag to the user before implementing the
affected area, don't assume:

1. **Export subgraph manifest format**: JSON shape, whether it's
   re-importable into another Loom repo, how file copies are structured.
2. **EXIF/XMP metadata writing**: explicitly deferred rather than decided
   against — worth periodically revisiting, especially if portability
   outside Loom becomes more important later.

### Resolved during design (kept here for traceability)

- **Tag taxonomy**: free-form, no central managed list — but each tag is
  its own row with a stable `id` (not a string blob on the join table), so
  rename/merge/delete-everywhere operations can be added later without a
  migration. See data model section.
- **Variant group + relationship interaction**: a relationship edge always
  attaches to a specific member image, never to the group as a whole. Groups
  have a user-chosen `cover_image_id` for collapsed display. Following an
  edge into a non-cover, currently-collapsed member auto-expands the group
  and focuses that member. See Stage 3 and data model section.
- **Duplicate detection**: in scope, as a distinct settings-gated function
  (not always-on background work), and must use perceptual similarity
  (e.g. pHash/dHash + Hamming distance), not exact-hash matching alone. See
  Anytime Items.
- **Prompt model**: dedup hash covers `text + negative` together (negative
  always included; empty hashed consistently). Prompts are a small managed
  library with an optional free-form `name`, picked by name (or text snippet
  when unnamed), still FindOrCreate-by-hash underneath. See data model +
  Stage 1.
- **Groups generalized**: `variant_groups` → `groups`, a generic image-set
  concept (variants, multi-angle turnarounds, sequences) with `name` + a
  `kind` display hint; identical mechanics, edges still attach to specific
  members. Creation and edge↔group rules in Stage 3. See data model.
- **Relationship acyclicity**: link creation rejects cycles (reachability
  check) so DAG layout can't break. See data model.
- **Undo vs. hard-purge**: inverse ops throw-with-reason when their target
  was already purged; undo reports it to the user. See Stage 5.
- **Multi-window**: different-repo only, single-window-per-repo enforced. See
  Repo model.
- **Clipboard paste**: raw bitmap saved as `Untitled.<ext>` at repo root,
  collision-suffixed. See Stage 1.
- **Video thumbnail**: midpoint frame via ffmpeg. See Stage 1.
- **File watcher**: `rjeczalik/notify` (native recursive), `.loom/` excluded
  from the watch. See Stack.

---

## Naming

App name: **Loom**. Repo-local hidden folder: `.loom/`.
