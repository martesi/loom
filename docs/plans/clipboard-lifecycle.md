# Clipboard, import, and asset lifecycle plan

## Outcome and scope

Make media transfer and deletion follow one clear contract across Assets,
Canvas, desktop clipboards, and the browser fallback. This is a plan only.
Do not change application code, bindings, or tests as part of this document.

The product contract is `r/ui.md`, especially **Clipboard and import** and
the unplace/trash/purge rules. Keep the existing React Flow workspace and
Playwright test foundation. Do not add boards or a second selection context.

## Current evidence and gaps

- `frontend/src/lib/clipboard.ts` reads and writes a versioned Loom payload in
  browser mode. It supports custom MIME when available, a JSON text fallback,
  and image Blob/File input. It does not interpret arbitrary text as a path.
  Keep `frontend/src/lib/clipboard-payload.ts` as the pure normalization
  boundary identified in `docs/product-patterns-and-test-audit.md`.
- `frontend/src/routes/canvas.tsx` routes paste through `ImageService.ImportMedia`
  with surface-specific placement. Its Assets import control currently reuses
  paste; the Canvas file-drop path also reuses paste with placement enabled.
  Separate explicit import/register intent from Canvas paste intent.
- `internal/service/media_service.go` creates fresh root files with collision-safe
  names and fresh IDs. `CopyMedia(converted=true)` currently transcodes to AVIF
  through `media.Processor`. This is not evidence that the required plugin
  `convert.Converter` boundary is in use.
- `internal/service/clipboard_desktop.go` stages files for native adapters and
  keeps them alive beyond the RPC. Inspect Windows, macOS, and Linux adapters
  before changing transport. Define clipboard ownership and staging cleanup.
- `CompressionDialog` is a separate compression workflow with copy/replace
  modes. Do not turn converted clipboard copy into representation replacement.
- `TrashImage` and `RestoreImage` record reversible state changes.
  `PurgeImages` deletes media, thumbnails, replacement stashes, and records.
  `LoadCanvas` calls `purgeExpiredTrash` before scanning. The existing cutoff
  is 30 days; load-triggered cleanup alone does not cover a repository that
  remains open for more than 30 days.
- The audit records existing browser round-trip, import, and deletion tests.
  Extend those tests with lifecycle chains and failure cases; do not replace
  them with component mocks or claim desktop coverage from browser CI.

## Transfer contract

### Original and converted copy

1. Copy operates on the active surface's selected asset IDs. Expand selected
   sets to their current asset members and deduplicate before transport.
2. Ctrl/Cmd+C copies original bytes/files, not previews, thumbnails, IDs,
   filesystem path text, or converted output. Preserve encoding and filenames.
3. Ctrl/Cmd+Shift+C requests plugin output through `convert.Converter`.
   Locate the tracked converter contract and registration mechanism first.
   If it is absent, define that boundary explicitly in the implementation
   proposal rather than silently treating FFmpeg as the plugin converter.
4. Discover converter availability at runtime. With no converter, show
   **“Converted copy is unavailable. No converter is installed.”** Leave the
   clipboard, source files, selection, and repository unchanged.
5. Validate all selected converted outputs before publishing a batch. A failed
   conversion must not silently publish originals or an incomplete selection.
   Report the failure and leave the previous clipboard intact where the
   platform permits. Do not expose a success message after a write failure.
6. Keep compression settings and copy/replace behavior in `CompressionDialog`
   separate. Converted copy does not register, place, or replace an asset.

### Loom payload, native adapters, and browser fallback

- Use a versioned Loom multi-image payload containing names and encoded bytes.
  Do not include relationships, set membership, tags, prompts, provenance,
  placement, archive/trash state, or source asset IDs.
- Validate version, shape, supported media names, encoding, and batch limits at
  normalization and service boundaries. Treat clipboard contents as untrusted.
  Keep ordering stable and reject invalid batches before writing repo files.
- Desktop adapters should publish the Loom payload where supported and native
  file clipboard formats for external applications: Windows file lists,
  macOS file URLs, and Linux local file URI lists for Wayland/X11.
  Read typed file clipboard formats only; reject non-local URIs.
- Native staging files must survive delayed paste into another application.
  Track ownership and retire staging only when safe. Do not delete files at
  RPC return, purge source files to clean staging, or accumulate staging forever.
- In browser mode, prefer the custom Loom MIME payload when supported. Use
  the existing recognized JSON text envelope for internal fallback and
  Blob/File media data for external image input. Offer image MIME output where
  supported; state when a browser cannot expose a whole multi-image batch to
  an external application. Never silently drop all but one image.
- Arbitrary text, including absolute paths, relative paths, and `file:` strings
  in text/plain, is never opened as a local file. Recognized JSON transports
  bytes; it is not permission to resolve paths.
- Permission denial, insecure context, unsupported APIs, empty clipboard,
  unsupported media, and unavailable native tools get actionable errors.
  A denied operation must not mutate the repo. Do not assume an OS, display
  server, executable location, or browser capability from static config.

### Paste and import are different intents

| Intent | Stored media | Placement | Selection after success |
| --- | --- | --- | --- |
| Paste with Canvas active | Fresh copies at repo root | Viewport center in Canvas coordinates | New Canvas nodes |
| Paste with Assets active | Fresh copies at repo root | Unplaced | New items in All Assets |
| Import files | Fresh copies at repo root | Unplaced, regardless of prior focus | New items in All Assets |
| Register/Rescan repo files | Existing repo files, no extra byte copy | New assets unplaced | Preserve valid active selection |

Paste creates new IDs even when the bytes match an existing asset or when the
source is the same repository. Use collision-safe root filenames, including
duplicate names within one batch. Never overwrite source files. Capture the
target surface and repo before awaiting clipboard input so focus or repo changes
cannot redirect a pending paste. Cancel or safely discard stale completion.

Place a Canvas batch as a deterministic cluster at the viewport center, with
coordinates transformed for pan and zoom. Do not inherit copied node positions
or place at the raw screen origin. Clear old surface selection after success.
Assets paste/import reveals All Assets even if Folders or a filter was active.
Do not copy Loom metadata, sets, or relationships. Failed imports must clean up
newly created files and rows without touching existing assets.

Import/register must not auto-place. Define explicit Canvas drops as placement
gestures separately from import controls; do not change Assets-to-Canvas drag.
Rescan discovers supported files, keeps existing identity and metadata, excludes
`.loom`, and leaves newly discovered assets unplaced. Repeat scans must not
duplicate records or resurrect trash. Missing files remain a distinct missing
state, not a request to purge their metadata.

## Lifecycle contract

```text
unplaced <-> placed --Assets Delete--> trash --Restore--> prior active state
active or trash --confirmed Shift+Delete--> purged
trash --30-day expiry--> purged
```

- Canvas Delete/Backspace only unplaces assets. Files, metadata, relationships,
  and set membership remain. Assets Delete/Backspace trashes selected assets.
- Trash retains bytes and identity for 30 elapsed days from the successful trash
  action. Show trash state, restore action, and retention information in the
  existing Assets/Inspector workflow. Keep `.loom/trash` out of Folders.
- Restore keeps identity and metadata, clears the expiry timestamp, and returns
  bytes to a safe repo location. Specify collision handling without overwrite.
  Preserve prior placement where the current store contract supports it;
  verify this directly before changing restore behavior.
- Re-trashing a restored asset starts a new 30-day window. Repeating trash on an
  already trashed asset must not extend retention accidentally.
- Give pre-policy trash a fresh 30-day window once during migration. Do not
  reset that window on reload or every migration check.
- Purge expired trash on open/load and during a long-running open session.
  Reuse one backend expiry operation with a testable clock. A closed repository
  is cleaned at its next open; do not promise deletion while Loom is not running.
  Serialize cleanup with import, restore, and manual purge and recheck eligibility
  before deletion so a restored asset cannot be purged by stale work.
- Shift+Delete/Backspace from either surface opens one irreversible-purge
  confirmation. Resolve selected sets to asset members, deduplicate, and show
  the final asset count with singular/plural text. Relationship-only selection
  must not produce an asset-purge dialog. Cancel is non-destructive.
- Freeze and validate the confirmed IDs. If eligibility changes before execution,
  refresh the count and require confirmation again rather than purge a different
  scope. Purge is never undoable, including automatic purge.
- Remove bytes, thumbnails, replacement stashes, metadata, incident relationships,
  and empty sets. Verify database cascade behavior and path containment. Purge
  must tolerate already-missing files without deleting outside-repo content.
  Surface partial filesystem/database failures and make retry safe; do not claim
  all-or-nothing deletion from a database transaction alone.

## Delivery sequence

1. Confirm converter registration, native capabilities, restore semantics,
   selection expansion, and existing tests against current tracked source.
2. Tighten transport validation and converted-copy capability/error handling.
   Keep normalization pure; preserve original-copy behavior.
3. Separate paste, explicit import, and rescan intents. Verify root naming,
   placement, selection transfer, stale completion, and failure cleanup.
4. Complete retention migration, long-session cleanup, restore, and final-count
   purge confirmation. Reuse service boundaries instead of duplicating deletion.
5. Extend browser E2E, Go lifecycle tests, and per-OS smoke checks below. Record
   actual results and platform limits; do not infer native success from mocks.

## Verification and acceptance

### Browser Playwright E2E

- Copy/paste one and multiple originals, same-repo and cross-repo. Assert fresh
  IDs, exact stored bytes, encoding, collision-safe root names, and stable count.
  Give sources metadata, a set, and relationships; assert none are copied.
- Paste with Canvas active after pan/zoom: assert center placement and new-node
  selection. Paste with Assets/Folders active: assert unplaced records, All Assets
  reveal, and no residual Canvas selection. Repeat paste to prove fresh copies.
- Exercise custom MIME and recognized JSON fallback separately, then external
  image Blob/File input. Invalid JSON, text paths, file-URL text, denied permission,
  and empty input must create no assets or files.
- Cover converted copy with an available test converter, unavailable capability,
  conversion error, and clipboard write failure. Assert originals remain unchanged
  and compression copy/replace commands are not invoked.
- Run the chain **import -> unplaced -> place -> Assets trash -> restore ->
  confirmed purge**. Reload between steps to verify persisted state and bytes.
  Include Canvas unplace before trash to prove it is not deletion.
- Add external repo files, invoke Rescan, place one, and rescan again. Assert
  stable IDs/placement, newly found files unplaced, and no trash resurrection.
- Test purge cancel, one asset, multiple assets, collapsed sets with overlapping
  selection, both surfaces, and count changes before execution. Confirm byte and
  record removal, relationship cleanup, and inability to undo purge.
- Use controlled backend time or aged fixture timestamps for an expiry chain.
  Assert survival just before 30 days, deletion at the cutoff, restored asset
  survival, new retention after re-trash, and long-session cleanup. Do not wait
  30 days or use browser time mocking as proof of backend expiry.

### Unit and service tests

Keep Bun tests limited to pure payload normalization, naming, and selection
helpers. Cover malformed versions/data, duplicate names, path-like names, and
batch limits. Use Go tests for original/converter bytes, transactional import
cleanup, rescan identity, retention migration, expiry boundaries, restore/purge
races, safe paths, cascading cleanup, and recoverable deletion failures.

### Per-OS native smoke checks

Run desktop round trips on Windows, macOS, Linux Wayland, and Linux X11 where
supported. Verify Loom-to-Loom multi-image original/converted copy, file-manager
to-Loom import by paste, and Loom-to-external-app paste. Check delayed paste after
the originating RPC, Unicode/spaced names, clipboard ownership changes, tool
absence, and rejected non-local URIs. Record OS/session, detected capabilities,
application version, and results at run time. Browser CI proves only the browser
fallback; native smoke results are a separate acceptance gate.

## Implementation appendix

- This slice exposes converted-copy absence because no tracked
  `convert.Converter` contract or registration exists in the repository. It
  does not invent a plugin API or use the compression processor as a substitute.
- Clipboard normalization accepts a bounded batch of named image/video media,
  strict base64, and reduces path-like names to safe basenames. Limits are
  100 items, 50 MiB per item, and 200 MiB per batch; these are defensive
  browser transport limits, not a promise about native adapters.
- The explicit file-picker import and Canvas file-drop gesture have different
  intents: picker imports unplaced, while dropping files onto Canvas places.
- Periodic expiry reuses the existing backend purge operation, with a one-hour
  frontend cadence while the Canvas is open. This is best-effort scheduling;
  backend load-time expiry remains authoritative. The current service still
  uses the system clock and does not provide a test clock or transactional
  recheck protocol for the broader restore/purge race contract.
- Restore and trash retain their existing backend implementation. Final-count
  confirmation uses the deduplicated selected asset IDs; eligibility refresh
  and reconfirmation after a concurrent selection change remain follow-up work.

## Review verdict and next slice

**Verdict: partial; not ready for full acceptance.** The picker passes `place`
as false, while an external Canvas drop uses the placed Canvas paste path.
This matches the import rule and the plan's separate drop gesture. The drop
uses the viewport center, not the pointer location. Browser behavior has not
been verified with Playwright.

- The three pure payload tests pass. They cover a normal item, malformed
  envelope or item, one path-like name, unsupported extension, empty batch,
  and malformed base64. They do not test the 100-item or byte boundaries,
  Windows paths, duplicate names, or supported-extension parity. The frontend
  rejects `.tif`, `.tiff`, `.mkv`, and `.avi`, although the store accepts
  them. It also accepts an empty data string and a name such as `png` without
  a dot; the service rejects the latter. Base64 padding bits are not checked
  for canonical encoding. File/Blob and native paths bypass this normalizer,
  and the import service does not enforce these batch or byte limits. Add
  boundary and parity tests and decide the intended validation policy.
- Converted `CopyMedia` now intentionally returns the unavailable error rather
  than processor output, including when an image processor is injected. This is
  a behavior change for callers expecting converted AVIF, not just a message
  change. Native copy propagates the error before staging or writing; browser
  copy propagates it before clipboard writing. Original copy and the separate
  `MediaService.Transcode` compression path remain in place. The worker reports
  Go tests passing; this review could not rerun them because `go` was not on
  the current PATH.
- Biome reports a formatting error in `canvas.tsx` and two lint warnings. The
  parent revision also fails formatting. The changed picker `.then(importMedia)`
  chain adds a formatting difference in this slice; other reported differences
  overlap other working-copy changes, so they cannot all be assigned to this
  pass. No formatting was changed in this review.
- The worker reports typecheck and unit tests passing. This review reran the
  payload tests only. No Playwright or native smoke test was run here.

**Next slice:** serialize expiry, restore, and manual purge through the backend
operation coordinator; recheck expiry eligibility under that lock immediately
before deletion. Add an injectable backend clock and tests for the exact cutoff,
restore/purge races, re-trash, and long-session cleanup. Freeze confirmed purge
IDs, revalidate the final eligible scope, and require a new confirmation when it
changes. Then run the lifecycle browser chain and address the payload gaps above.

## Backend follow-up notes

- Load-time expiry now runs under the repository operation coordinator. Restore,
  manual purge, import, and expiry use the same lock, so expiry checks and
  deletion cannot race a restore. Manual purge rejects a frozen ID that no
  longer exists with a reconfirmation error.
- `ImageService.Now` provides a backend clock seam. The retention test uses a
  fixed time and checks the exact 30-day cutoff. Long-session scheduling and
  browser lifecycle verification remain separate work.
- The import service now rejects empty batches and items, more than 100 items,
  items over 50 MiB, batch data over 200 MiB, non-canonical base64, and
  unsupported extensions. Its accepted extensions come from the store media
  registry, including TIFF and video formats.
