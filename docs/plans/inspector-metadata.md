# Inspector and metadata workflow enrichment

## Scope and contract

This is a plan, not an implementation. `r/ui.md` is the product contract.
Keep one repository, one Canvas, and one active selection owned by Assets or
Canvas. Inspector follows that selection. Editing a field must not create a
second selection or change its owner. All Assets and Folders share asset IDs.
Do not add a Detail route, metadata columns to compact Assets rows, or a second
metadata store. Filesystem state owns bytes, paths, and existence; repository
metadata owns stable identity, prompts, tags, lifecycle state, and relationships.

### Evidence and integration boundaries

- `frontend/src/components/canvas/detail-panel.tsx` already renders single-asset
  preview/path, common tags, common-or-mixed prompts, archive/unarchive, restore,
  Sources/Derived, and separate set/relationship contexts.
- `frontend/src/routes/canvas.tsx` wires `DetailPanel` into Inspector.
  `submitInspectorField` rejects mismatched selected IDs, moves one file, and
  adds tags or attaches prompts with per-asset calls followed by reload.
  Command requests open Inspector and focus an editor after data loads.
- Current mixed prompts use an empty editor with a placeholder. Common tags
  are an intersection, not a complete summary of tag distribution. Bulk writes
  use `Promise.all`; an error does not prove that no assets changed.
- Lifecycle actions already exist in the route action catalog. Archive and
  unarchive set an explicit boolean; restore targets trashed records.
- `docs/product-patterns-and-test-audit.md` records partial Lingui coverage and
  existing selection, lifecycle, and relationship E2E coverage. Build on those
  tests rather than replacing the harness.

The route has concurrent work in progress. At implementation time, re-read its
current code and coordinate shared action, focus, and lifecycle changes. This
plan does not freeze line numbers, message counts, or runtime configuration.

## Selection summaries

| Context | Inspector content | Editing rules |
| --- | --- | --- |
| Empty | Short selection guidance | No asset actions |
| Single asset | Preview, filename, dimensions, repo-relative path, independent missing/placement/archive/trash indicators | Asset metadata and eligible physical/lifecycle actions |
| Multiple assets | Pluralized count; common values and mixed-state summaries; placed/unplaced, archived, trashed, and missing counts | Explicit bulk operations; no duplicate selected-item list |
| Set | Name, optional kind, member count, comparison/cover context | Set metadata only; asset bulk editing needs an explicit member-selection action |
| Relationship | Source and derived endpoint identity and navigation | Unlink only; no endpoint reconnection or asset editor |

Show archive, trash, missing, and placement independently. One status must not
hide another. Loading, load failure, and genuinely empty selection are distinct
states. Report unavailable selected records; do not silently reduce the count
and apply a bulk edit to a smaller selection.

For bulk fields, distinguish **same value**, **mixed values**, and **empty for
all**. Show a concise scope such as “Apply to 3 assets.” Never copy one asset's
value over the others just because it loaded first. Summaries must stay compact
at large selection sizes and narrow panel widths.

## Metadata and file workflows

### Tags

1. Show tag chips for a single asset. For multiple assets, separate tags on all
   assets from tags on some assets; show partial counts without listing assets.
2. Add a tag to all eligible selected assets. Trim leading/trailing whitespace,
   reject blank input, and use backend tag identity/normalization rules rather
   than inventing client-only case or Unicode rules.
3. Adding an existing tag is idempotent. Clear input only after confirmed
   success. Offer existing-name suggestions with a keyboard-accessible control.
4. Add explicit remove-tag support as a catalog delta. For a partial tag, state
   how many selected assets will lose it. Do not interpret removal as replacing
   the complete tag set. Use an undo path only if the service can restore the
   exact prior membership; otherwise use a scoped confirmation for bulk removal.
5. Reload tag filters and Inspector summaries after success. Preserve unrelated
   tags, selection identity, placement, and relationships.

### Prompts

- Single selection starts with its current prompt. Multi-selection shows a
  common prompt only when all values match; mixed state remains explicitly
  marked even after the editor receives focus.
- Use explicit Save, not blur-save. Track dirty state separately from an empty
  value. A pristine mixed editor cannot submit an implicit clear-all operation.
- Preserve meaningful whitespace and line breaks. Define any size limits from
  the service contract, then expose matching help and field errors.
- Confirm replacement when multiple distinct prompts will be overwritten. The
  dialog gives the final eligible count and explains replacement, not append.
  Clearing a nonempty prompt must be intentional; bulk clear is confirmed.
- Do not promise reversible prompt history without verifying the prompt service.
  Inspect attach/create semantics before adding Undo or retry: repeated prompt
  attachment must not create unintended duplicate history after uncertain errors.
- Prompt filter/search results, Inspector, and Canvas representations refresh
  together. Compact Assets rows remain filename and thumbnail only.

### File path, move, rename, and reveal

- Keep move/rename single-asset only in this pass. Display the current
  repo-relative path and label the destination “New repository-relative path.”
  Use “Move or rename” rather than a vague “Move” submit label.
- Explain whether the initial value is the full relative path or filename.
  Prefer the full relative path so a rename in a nested folder does not appear
  to move the file to the root. Do not silently interpret a basename differently
  in Inspector and Folders.
- Validate blank/no-change input and give inline errors. Backend validation is
  authoritative for traversal, paths outside the repository, protected `.loom`
  content, invalid names, collisions, permissions, missing source files, and
  platform-specific path rules. Check current `MoveFile` behavior before coding.
- Never overwrite a destination silently. Show the old and new paths in a
  review step for directory moves; a simple valid rename can submit directly.
  Any supported overwrite needs its own explicit destructive policy, not this
  plan's default.
- Disable physical edits for missing or trashed files with a reason. Metadata
  may remain editable when its service supports it. Show in Folders reveals the
  physical location; unavailable paths receive a clear explanation.
- After success, retain the stable asset ID, Canvas node, metadata, and links.
  Reveal the new location in Folders, invalidate the old location, and refresh
  filename/path everywhere. Do not move Canvas coordinates as a side effect.

## Archive, trash, restore, and confirmation

Archive is metadata filtering, not file deletion or Canvas unplacement. Offer
explicit Archive and Unarchive for a mixed selection, with eligible counts.
Do not use an ambiguous toggle that inverts each asset. Apply only to records
whose state changes; explain hidden results if an active filter removes them.

Trash is a separate, explicitly dangerous action. Preserve the surface contract:
Delete/Backspace in Assets trashes, while Canvas Delete/Backspace unplaces.
An explicit Inspector trash command may act on Canvas-owned assets, but must
say “Move to trash” and must not reuse the unplace label. Reuse the lifecycle
track's confirmation and executor rather than introducing a second dialog.

Trash confirmation shows the final deduplicated asset count, affected file
scope, and the contract's 30-day retention followed by automatic permanent
purge. Permanent purge stays a separate irreversible action with one final-count
confirmation. Missing files, set expansion, and relationship selections must
not produce a misleading count.

Restore targets trashed assets only. Show the eligible count in mixed selection.
Verify original-path recovery and destination-conflict behavior in the service;
never silently replace another file. Explain unresolved conflicts and preserve
selection of the restored IDs. Restore is not Unarchive. Do not claim that it
restores placement, set membership, or relationships until backend semantics
are verified and reflected in tests and user-facing text.

If a filter hides assets after an operation, show the result and a way to reveal
the affected IDs. Do not silently select unrelated rows to fill the gap. Missing
or purge-expired assets cannot be “restored” by an enabled button.

## Sources and Derived context

- Keep incoming Sources and outgoing Derived distinct for a single asset.
  Include endpoint filename, direction, and relevant placed/unplaced or
  unavailable state. Localize fallback endpoint labels such as “Asset {id}.”
- Resolve endpoints that are not in the currently rendered Canvas data. Loading
  and missing endpoint information must not look like an empty relationship list.
- Go to a placed endpoint selects it and centers Canvas. Go to an unplaced
  endpoint reveals/selects it in All Assets. Physical reveal uses Folders.
  Respect filters so navigation is visible rather than selecting a hidden item.
- Remove relationship deletes only the edge, not either file, metadata, set
  membership, or placement. Make repeated button names endpoint-specific.
- Multi-selection may show aggregate incoming/outgoing counts, but does not
  flatten endpoint lists or imply that all assets share provenance. Defer bulk
  unlink until a precise scope and confirmation design exists.
- Preserve set fan-out semantics: links describe actual asset endpoints, not
  a live relationship to all future set members.

## Submission, validation, failure, and draft policy

Use the existing coordinator boundary for writes. Each request captures repo
identity, selection owner, sorted/deduplicated asset IDs, eligible IDs, and field
revision. Recheck eligibility at submit. A confirmation must not execute against
a newer selection merely because the active IDs changed while it was open.

Keep drafts keyed by repository and asset selection. Data reloads must not
remount an editor and discard a dirty draft. On selection change, offer Save /
Discard / Cancel for unsaved changes; Cancel keeps the prior selection context.
Coordinate this with shared selection code rather than adding Inspector-owned
selection. Closing Inspector preserves drafts or asks before discarding them.

Show pending state per operation, prevent duplicate submission, and retain
editor focus. Do not announce success until the write succeeds. If a write
succeeds but refresh fails, say so and offer Refresh instead of replaying the
write. If bulk writes are not atomic, collect per-ID results, reload actual state,
report success/failure counts, and retry only known failures. For uncertain
network/service errors, reconcile state before retrying a potentially
non-idempotent write. Never assume `Promise.all` implies rollback.

Prefer a service batch/transaction boundary for atomic metadata changes where
available. Any new API requires backend validation and tests; this plan does
not assume such an API exists. Avoid automatic retries for physical file moves.

## Action catalog deltas

Keep existing stable IDs and use one eligibility/execution definition for
Inspector, palette, shortcuts, and context menus. Localize labels, descriptions,
aliases, contexts, and disabled reasons. Asset actions work with either Assets
or Canvas ownership; opening Inspector does not transfer ownership.

| Existing ID | Required delta |
| --- | --- |
| `move-rename-file` | Focus the single-asset destination editor; require a present, writable, nontrashed source; explain invalid scope/state. Submit performs the write, not opening the command. |
| `add-tag` | Focus tag input; show eligible bulk count; use the shared normalization and duplicate policy. |
| `save-prompt` | Clarify description to “Edit prompt in Inspector”: the current action focuses rather than saves. The form explicitly saves and confirms mixed replacement. |
| `archive-selection` | Explicit set-to-archived intent, eligible count, consistent scope across both selection surfaces. |
| `unarchive-selection` | Explicit set-to-unarchived intent; offer alongside Archive for mixed states. |
| `restore-from-trash` | Eligible trashed records only; explain missing/purged/conflicting outcomes; shared result refresh. |
| `trash-selection` / `trash-canvas-selection` | Reuse current surface rules and lifecycle confirmation. Inspector chooses the explicit trash intent, never the Canvas unplace shortcut. |
| `show-in-folders` | Single physical-location reveal, including explanation for unavailable locations. |

Proposed additions: a scoped `remove-tag` editor/action and an intentional prompt
clear affordance. Add stable catalog IDs only when these become callable
commands; do not create aliases that bypass validation or confirmation.

## Accessibility, localization, and motion

### Accessibility and focus

- Give Inspector a named region and a logical heading hierarchy. Use visible
  labels bound to each input, not placeholders as labels. Group bulk controls
  with a fieldset/legend or equivalent accessible description of scope.
- Connect help/errors with `aria-describedby`; set `aria-invalid` on invalid
  fields. Use `aria-busy` during loads/writes and a polite status region for
  saved/loading/count results. Announce actionable errors without repeated spam.
- Mixed text values need a readable “Mixed values” description. Use
  `aria-checked="mixed"` only for actual tri-state checkbox controls, not text
  inputs. Disabled controls have discoverable reasons outside hover tooltips.
- Keyboard users can add/remove tags, open suggestions, submit/cancel forms,
  navigate endpoints, and confirm/cancel without pointer gestures. Icon-only
  removal buttons name the tag or endpoint. Preserve visible focus rings.
- Palette commands focus the intended field only after its matching data loads.
  Cancel stale requests on repo/selection changes. Scope focus lookup to
  Inspector, not a global field name that could match another editor.
- Escape dismisses suggestions/dialogs before the panel. Restore focus to the
  trigger on dialog/panel close; if it no longer exists, use a stable control
  on the selection-owning surface. Desktop Inspector is not a focus trap; use
  modal focus rules only when narrow-screen chrome actually presents a modal.
- Text editing consumes native Delete, Backspace, Select all, copy, and paste.
  Global Canvas/Assets shortcuts must not trash, unplace, or change selection
  while an editable field has focus.

### Complete Lingui extraction for this workflow

1. Inventory Inspector subcomponents, route action definitions, confirmations,
   shared tag controls, relationship fallbacks, errors, and toast/status text.
2. Wrap rendered messages with `Trans`/`Plural` and non-rendered strings with
   Lingui macros. Include labels, alt/help text, placeholders, tooltips, ARIA
   names, loading/empty/mixed states, validation, pending and retry outcomes.
3. Use plural messages for selection, eligible, failed, restored, and relationship
   counts. Translate complete sentences with named values; do not concatenate
   fragments or translate user paths, tags, filenames, and prompt content.
4. Map service error categories to localized actionable text. Keep diagnostic
   details separate; arbitrary raw server errors are not the sole UI message.
5. Run the tracked frontend extraction/compile scripts, inspect catalog changes,
   and check for residual English literals, including `Asset ${id}` fallbacks.
   Do not remove unrelated obsolete entries as a side effect.
6. Test singular/plural, long strings, bidirectional text, and narrow panel
   layout. English remains the shipped locale unless a separate locale change
   is approved; extraction completeness does not imply translated locales.

### Reduced motion

Honor `prefers-reduced-motion` for panel transitions, preview changes, success
effects, and relationship navigation. Center/fit endpoints without animated
travel when reduction is requested. Preserve position, focus, and status
feedback without depending on motion. Avoid animated layout jumps on reload.

## Inspiration and limits

- **Figma properties panel:** borrow selection-driven sections, shared values,
  explicit mixed states, and consistent field focus. Do not copy layer/property
  abstractions or introduce Inspector-owned selection.
- **Lightroom metadata:** borrow common-versus-mixed metadata and explicit bulk
  scope. Keep semantic catalog filtering separate from physical folder moves;
  archive, trash, and unplace remain distinct. Do not add metadata presets or
  smart collections in this pass.
- **t3code web detail views:** use as a design-review reference for readable
  detail grouping, compact actions, and clear pending/error states. This plan
  does not claim a source-code review of t3code or require copying its routing,
  implementation, or styles. Verify the current relevant views before choosing
  a concrete pattern; review licenses before reusing code.

Reference entry points: [Figma help](https://help.figma.com/),
[Lightroom metadata](https://helpx.adobe.com/lightroom-classic/help/metadata-basics-actions.html),
and [t3code](https://github.com/pingdotgg/t3code). These are inspiration, not Loom
behavior specifications.

## E2E verification: cross-control sequences

Use the existing isolated production-server Playwright harness and current
fixture helpers. Discover commands, ports, and fixture locations from tracked
configuration at execution time. Use accessible roles/names where possible;
assert stable asset identity and actual persisted state, not only a toast.

| Sequence | Required assertions |
| --- | --- |
| Select nested asset in All Assets → open path command → rename/move in Inspector → Show in Folders → select Canvas node → reload | New location/filename visible; old location gone; bytes unchanged; same ID, one node, coordinates, tags, prompt, and links preserved. |
| Assets range/toggle selection → add tag in Inspector → filter All Assets → switch Folders → inspect placed nodes on Canvas | Every eligible asset gets the tag once; unrelated assets/tags unchanged; summary is common; switching mode preserves representable IDs; Canvas interaction transfers ownership. |
| Select assets with different tags → remove partial/common tag → verify filters and Inspector | Correct eligible count; cancel changes nothing; only specified tag memberships removed. |
| Select mixed prompts in Assets → focus prompt command → Save untouched → enter replacement → cancel/confirm → verify through Folders/Canvas and reload | Untouched mixed field cannot clear prompts; cancel preserves values; confirmed replacement reaches only captured eligible IDs; line breaks persist. |
| Edit single prompt → change selection / close panel / refresh data | Save/Discard/Cancel behavior is explicit; dirty draft survives refresh; no stale editor writes to the next asset or repository. |
| Select mixed archive states → Archive / Unarchive → change filters → reveal in Folders/Canvas | Only eligible states change; files and placement remain intact; counts and filtered-out feedback are correct. |
| Select in Assets → trash via Inspector → view trash filter → restore → verify Folders/Canvas | One final-count confirmation; retention text; restored IDs and metadata; observed placement/set/link behavior matches verified service semantics. |
| Select Canvas node → Delete; select asset → Delete; Shift+Delete from either surface | Canvas unplaces only; Assets trashes; purge is separately confirmed and irreversible; field-focused Delete never invokes lifecycle commands. |
| Select asset → Sources/Derived Go to placed/unplaced endpoint → physical reveal → unlink | Correct direction, owner, centering/reveal and endpoint label; only edge removed; endpoint asset remains. |
| Start bulk save → change selection or inject partial failure → reconcile/retry | No write against new selection; duplicate submission blocked; actual successes reflected; only safe failed writes retried; refresh failure never replays a successful write. |
| Invalid move / missing file / trash restore collision / unavailable selection load | Inline localized errors, draft retained, no overwrite, truthful eligible count, and recoverable focus. |
| Keyboard-only editing → confirmation cancel/accept → close Inspector | Labels, Tab order, field focus, native editing shortcuts, status announcements, and return focus work. |
| Reduced-motion + narrow panel + long localized strings | No animated navigation with reduced motion; controls remain readable, reachable, and correctly labeled. |

Extend existing lifecycle and relationship cases for shared behavior rather than
adding conflicting fixtures. Add pure helper tests only for normalization,
mixed-value summaries, eligibility, and result aggregation; keep real focus,
selection transfer, validation UI, and confirmations in Playwright. Add service
tests for any new batch, path-validation, or restore-conflict boundary.

## Delivery order and acceptance

1. Verify current move/restore/prompt service semantics and agree on shared
   action/selection/lifecycle integration boundaries.
2. Define pure selection summaries, eligible counts, captured submission scope,
   dirty/mixed state, and partial-result handling.
3. Enrich Inspector forms and summaries through the existing route coordinator;
   add validation, draft protection, and shared confirmation behavior.
4. Complete this workflow's Lingui extraction, accessibility, and reduced-motion
   treatment in the same change, not as a later cosmetic pass.
5. Add cross-control tests, then run tracked frontend checks, service tests,
   extraction/build, and isolated E2E verification.

Accept when edits persist across All Assets, Folders, Canvas, and reload; bulk
scope is explicit; failures do not misreport rollback; physical changes retain
identity; lifecycle intents remain distinct; Sources/Derived navigation is
correct; and every new control works with keyboard, labels, and reduced motion.
Do not implement a new page, bulk filesystem rename, metadata presets, bulk
provenance editing, or speculative undo/history in this scope.

### Slice 1 implementation notes

- `DetailPanel` now presents selected asset count, per-tag coverage, explicit
  bulk scope, mixed-prompt state, and blocks bulk field submission when any
  selected record is unavailable.
- Tag entry trims and rejects blank names, with inline accessible validation.
  Prompt drafts remain panel-local and are not reset by metadata refreshes;
  mixed prompt drafts start empty and cannot save until edited. Bulk prompt
  replacement and clearing use confirmation.
- This slice does not change selection ownership or route submit coordination.

### Slice 1 static review

**Verdict: changes required before acceptance.** This review did not run a
build or UI tests. The reported type check and diff check were not rerun.

- Mixed prompts start blank and an untouched mixed draft cannot submit. Common
  values display when equal. However, dirty state is inferred from the current
  baseline, not tracked as an edit: after a refresh changes that baseline, a
  saved or stale draft can become dirty and overwrite newer values. Drafts are
  keyed only by the ordered IDs, not repository, and are never cleared after a
  successful save. Preserve dirty drafts across refresh, but reconcile clean
  drafts after success and scope them to repository and canonical selection.
- A mixed draft edited back to blank is treated as pristine, so intentional bulk
  clear is not possible. The common-prompt clear path calls
  `CreateAndAttachPrompt` with empty text, rather than `DetachPrompt`; verify
  and implement actual clear semantics before presenting it as a clear.
- Tag coverage uses the previous `tagLists` until the new request completes.
  Equal-sized selections can therefore show the prior selection's tags as
  current; failed loads also leave stale summaries. Bind results to repository
  and selection and distinguish loading/error from an empty summary.
- When some records are unavailable, the tag input is disabled but its submit
  button remains enabled and the submit handler does not guard unavailable
  scope. The route currently rejects mismatched IDs silently, after which the
  form clears the input as if successful. When all records fail to load, the
  panel reports “No Selection” instead of an unavailable selection.
- Prompt confirmation uses `window.confirm`, not the existing Base UI dialog
  pattern in `canvas.tsx`. Use that pattern with captured scope, localized
  plural text, explicit actions, and focus restoration. Both prompt and tag
  inputs have localized accessible names; the blank-tag error is localized and
  connected with `aria-describedby` and `aria-invalid`. Visible labels and
  complete scope descriptions remain open accessibility work.
- The slice adds no selection state or ownership transfer to Inspector;
  selection remains an input from the route. Navigation continues through
  existing callbacks. This is consistent with `r/ui.md`.

### Slice 1 review follow-up

- Prompt drafts now track explicit edits and are scoped by repository path and
  canonical selected IDs. Successful saves clear only the matching draft.
- Tag summaries are bound to their repository and selection scope. Unavailable
  selections have a distinct message, and tag submission is guarded while data
  is loading or any selected record is unavailable.
- Prompt replacement and clearing use the existing Base UI dialog pattern.
  Confirmation captures the original IDs and refuses to submit after scope or
  availability changes.

### Slice 2 proposal

1. Fix the slice 1 blockers first, with focused regression coverage for refresh,
   selection/repository changes, blank mixed drafts, unavailable records, and
   stale tag loads.
2. Improve Sources/Derived endpoint resolution and accessible, localized
   navigation/unlink labels. Keep navigation on the existing selection owner
   paths and distinguish missing or loading endpoints from no relationships.
3. Integrate explicit eligible counts for archive, trash, and restore. Reuse
   the lifecycle action executor and confirmation; preserve the distinct
   archive, trash, restore, and Canvas unplace intents.
4. Harden route submission: capture repository, owner, IDs and field revision;
   recheck scope and eligibility; track pending work; reconcile partial writes
   and refresh failures without claiming rollback or replaying successful work.
   Coordinate draft transitions with shared selection code, not a second
   Inspector-owned selection.

`frontend/src/routes/canvas.tsx` is under concurrent work. Coordinate ownership
before editing it, and re-read its current action, dialog, and submit paths
before integration. Add cross-control UI tests after the shared paths settle.

### Slice 2 implementation notes

- Inspector submissions now reject stale selection scopes, reload selected
  records before writing, block unavailable or non-movable files, and report
  partial tag/prompt failures after refreshing actual state.
- Move/rename starts from the full repository-relative path. Sources/Derived
  endpoint controls have directional names, localized fallback labels, Folders
  reveal, and endpoint-specific relationship removal.
- Inspector trash uses the existing surface-specific lifecycle action and shared
  confirmation. Archive and restore remain connected to the existing action
  executors.
- TypeScript check passed from `frontend`. UI/E2E verification was not run.

### Slice 2 static review

**Verdict: changes required.** This review used source inspection only. It did
not run builds, checks, or Playwright; the worker's reported checks were not
rerun.

- The post-load ID and surface check blocks a selection change during the
  `GetImage` calls. It does not fully protect confirmation scope: the dialog
  captures path and IDs, but not the selection owner or a selection revision.
  Changing owner with the same IDs, or changing away and back, can still submit
  the old confirmation. The route captures owner only when submit starts.
  Its `repo.path !== repository` comparison uses the same render closure on
  both sides and cannot detect a later repository change. Group membership is
  also read from that closure's `data`, not live state. A service-side atomic
  eligibility check would still be needed to close the race after the recheck.
- Bulk results count rejected calls but do not identify failed IDs. A rejected
  call can also have changed state before reporting an error, so reconcile
  before offering a retry. If reload fails, the result counts are lost even
  though writes may have succeeded. There is no pending guard against duplicate
  field submissions. Empty prompt saves attach an empty prompt instead of
  calling `DetachPrompt`; the advertised clear does not remove the attachment.
- Prompt replacement and bulk clear have a Base UI confirmation; Inspector
  trash reaches the shared confirmation. That trash dialog does not state the
  30-day retention and automatic purge. Relationship removal has no
  confirmation; confirm the intended destructive-action policy. Directory
  moves have no review step. The move no-change comparison uses the basename,
  not the current relative path, and blank/no-change cases return silently.
- Sources use incoming edges and Derived uses outgoing edges. Their buttons
  call the same `go` function as relationship actions: placed endpoints select
  and center Canvas; unplaced endpoints select and reveal All Assets; physical
  reveal requests Folders. The library clears search/status/placement/tag
  filters on reveal, but retains the current view filter, which can hide the
  target and reconcile it out of selection. Endpoint resolution and unavailable
  state remain incomplete. Multiple selected relationship cards also call the
  shared action for the first edge, rather than their own edge.
- Endpoint fallback text is localized visually, but the remove button's fallback
  `asset ${endpointId}` and the conditional `source`/`derived` fragments in
  the Go-to message are English literals. Use complete localized messages and
  endpoint-specific accessible names for repeated navigation buttons. Visible
  field labels, pending/status announcements, localized service errors, and
  focus behavior remain open; no keyboard or catalog extraction check was run.
- Archive and restore still use shared actions, but eligible counts and mixed
  archive choices are absent. Unavailable selections can leave Archive enabled
  in the panel even when the catalog action is disabled. Partial lifecycle
  failures and refresh failures still need reconciliation.

### Slice 2 review follow-up

- Inspector field writes now use a duplicate-submit guard and compare a live
  repository/owner/selection revision after selected records load. Prompt
  confirmations capture the owner and revision and reject stale submissions.
- Bulk tag and prompt errors list failed asset IDs. Prompt clearing detaches the
  prompt instead of attaching an empty prompt. Refresh failures still need a
  dedicated reconciliation outcome and retry UX.
- Trash confirmation states the 30-day retention and automatic purge.
  Relationship removal now requires confirmation and explains that it removes
  only the edge.
- Asset reveal clears the active saved-view selection and the existing filters
  so the revealed asset remains visible.
- Directory-move review, lifecycle eligible counts/mixed archive choices,
  localized lifecycle and endpoint error coverage, and full UI verification
  remain open.
