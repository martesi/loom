# Working-tree qualify audit

Scope: targeted canvas hardening from qualify-audit #4-canvas, #6, F4-chips, and Escape round 2. The separate Settings triage identified a second-Escape failure: a transitioning Settings dialog could retain keyboard ownership after closing. The route now handles Escape in capture phase and consumes it only after closing the active underlying layer.

## Must-fix, ordered by risk

1. ~~**Make grouped relationship writes and their undo record atomic.** A failure after the database commit leaves changed relationships without the corresponding history. Group undo/redo can also stop after applying only some links.~~ Addressed: grouped links and their history now share one transaction; grouped undo/redo replay is transactional. Failure-injection regressions cover log, undo, and redo failures (G2, C3).
2. **Resolved:** Appearance preferences now synchronize at application lifetime in `frontend/src/routes/root.tsx`; the dialog is an editor. Theme/density storage and select values use Zod validation. (F1, C3, T2)
3. **Fix invalid E2E accessible-name selectors.** Resolved in the focused E2E specs: dialog names use the rendered singular/plural counts, and the derived-asset locator includes the interpolated ID. (C6, F2)
4. **Resolved for drag boundaries:** both Canvas and folder drops use one Zod schema; JSON parsing is isolated at the throwing boundary. Unrelated exception capture remains out of scope (T3, T2).
5. **Validate external payloads with schemas.** Clipboard JSON remains manual validation and is out of scope for this change. (T2)
6. **Resolved:** Canvas Trash and folder moves retain per-asset rejection causes, reconcile after partial outcomes, then report safe asset context. (C3)
7. **Resolved:** library filter chips, clear, and select-all compose ghost/small Button while retaining chip styling and accessible removal names (F4).

## Per-file findings

Severity describes the proposed action, not whether a problem was introduced in full by this change. “Note” means no additional concrete standards issue was identified in the inspected change; it does not certify correctness.

| File | Finding | Rule ID | Severity | Suggested fix location |
| --- | --- | --- | --- | --- |
| `frontend/src/routes/canvas.tsx` | 3,219 lines, already over the limit before this change; 761 added diff lines increase the debt. | C5 | note | Split along feature boundaries: lifecycle/confirmation, selection and drag orchestration, action catalog, and canvas presentation; preserve route ownership. |
| `frontend/src/routes/canvas.tsx` | Resolved for Canvas drag: shared Zod validation with narrowly isolated JSON parse. Inspector submission exception handling is unchanged. | T3, T2 | fixed / note | — |
| `frontend/src/routes/canvas.tsx` | Resolved: `finishTrash` retains rejected causes, dismisses stale dialog state, reloads after partial outcomes, then reports context. | C3 | fixed | — |
| `frontend/src/routes/canvas.tsx` | Replacing the palette help action with conditionally mounted settings makes preferences and the system-theme listener dialog-lifetime only. | F1, C3 | must-fix | Mount preference synchronization at application lifetime, with dialog as editor. |
| `frontend/src/components/settings-dialog.tsx` | Resolved: storage failures preserve their causes in a warning; invalid data falls back without claiming writes will fail. | T3, C3 | fixed | — |
| `frontend/src/components/settings-dialog.tsx` | Resolved: Zod schemas validate persisted preferences and narrow select values; invalid arrays and stringified non-string values are rejected. | T2 | fixed | — |
| `frontend/src/components/settings-dialog.tsx` | Resolved: dialog controls compose `ui/select`, `ui/button`, and `ui/kbd`, retaining labels and focus behavior. | F4, F3 | fixed | — |
| `frontend/src/components/canvas/library-panel.tsx` | Resolved: folder drop shares the Zod schema; move failures retain causes and refresh before reporting. | T3, T2, C3 | fixed | — |
| `frontend/src/components/canvas/library-panel.tsx` | Resolved: filter chips, clear, and select-all use ghost/small Button and preserve accessible removal names. | F4 | fixed | — |
| `frontend/src/components/canvas/library-panel.tsx` | Now 534 lines (445 at HEAD), crossing the 500-line limit. | C5 | should-fix | Extract filter controls or drag/move workflow around a coherent responsibility. |
| `frontend/src/components/canvas/asset-gallery.tsx` | Resolved: generated `LibraryRow` binding exposes Go `width`/`height`; omit zero/unavailable dimensions from overlay and accessible label. | T2, F2 | fixed | — |
| `frontend/src/components/canvas/asset-gallery.tsx` | New drag preview duplicates the list implementation; the gallery card is a specialized selectable option, not an exact ordinary Button match. | C1 | should-fix | Share the drag-preview/payload logic with `asset-list.tsx` only at their real common boundary; preserve option semantics. |
| `frontend/src/components/canvas/asset-list.tsx` | New drag preview duplicates gallery code; row buttons serve specialized listbox-option semantics, so raw buttons are not automatically a component violation. | C1 | should-fix | Drag start around 94-120; coordinate with gallery. |
| `frontend/src/components/canvas/asset-list.tsx` | Resolved: load failure clears stale rows and shows an actionable retry independent of row count. | C3 | fixed | — |
| `frontend/src/components/canvas/command-palette.tsx` | Resolved: retry composes `ui/Button`; option semantics, `ShortcutKeys`, and `Kbd` remain unchanged. | F4 | fixed | — |
| `frontend/src/components/canvas/detail-panel.tsx` | 729 lines, already 599 at HEAD; this change increases existing file-size debt. Submit buttons already compose `Button` via `render`, not standalone replacements. | C5 | should-fix | Split inspector metadata editing and relationship sections into feature-local components. |
| `frontend/src/components/canvas/detail-panel.tsx` | Resolved: edge-row removal now opens the shared confirmation dialog; removed the unreachable duplicate. | C4, F2 | fixed | — |
| `frontend/src/lib/clipboard-payload.ts` | External clipboard JSON is manually validated rather than using Zod; its base64 check permits an empty string while Go rejects empty media. | T2 | fixed | Zod schema and refinements enforce nonempty canonical base64, Go's supported extension set, and item, batch, and count limits. A giant repeated-group regex rejected a valid just-under-50-MiB base64 value; the bounded-format check now validates alphabet, padding, and canonical trailing bits without matching the full payload as repeated groups. |
| `frontend/src/lib/clipboard-payload.test.js` | Adds invalid-input coverage, but no empty-data case to detect the frontend/backend mismatch. | C6 | fixed | Empty, encoding, and item-size just-under/at/just-over, count, and extension regressions added. |
| `frontend/e2e/board-behaviors.spec.ts` | 524 lines, already above the limit at HEAD. No additional issue identified in the changed assertions. | C5 | note | Split by board behavior when addressing existing debt. |
| `frontend/e2e/canvas-workflows.spec.ts` | Viewport persistence waits on a hard-coded runtime method ID, coupling the test to an implementation detail that can change independently of user behavior. | C1, C6 | should-fix | `waitForViewportSave` around 87-91; use a stable project test seam or observable persisted result. |
| `frontend/e2e/canvas.spec.ts` | Resolved: dialog selectors assert rendered counts; derived-asset selector includes the interpolated ID. | C6, F2 | fixed | — |
| `frontend/e2e/command-palette.spec.ts` | Trash dialog selectors now assert rendered counts. File is 612 lines and already exceeded 500 at HEAD. | C6, C5 | fixed / should-fix | Split tests by palette responsibility separately. |
| `frontend/e2e/library.spec.ts` | Resolved: trash dialog selector asserts the rendered count. | C6 | fixed | — |
| `frontend/e2e/lifecycle-guards.spec.ts` | Resolved: trash and purge dialog selectors assert rendered counts. | C6 | fixed | — |
| `frontend/e2e/shelves.spec.ts` | Resolved: purge dialog selector asserts the rendered count. | C6 | fixed | — |
| `frontend/e2e/settings.spec.ts` | Prior test covers the full Escape sequence: first closes Settings, second closes Assets. Runtime browser tests were not run in this scoped change. | C6 | noted | — |
| `frontend/e2e/surface-workflows.spec.ts` | No additional concrete standards finding identified in the inspected change. | C6 | note | None. |
| `frontend/src/locales/en.po` | Locale changes were included in scope; no separate concrete standards finding identified in static review. | C6 | note | Verify catalog generation with the project's normal focused check when authorized. |
| `internal/service/image_service.go` | Addressed: grouped relationship and operation-log writes commit atomically. New DB errors have operation context and row close/iteration errors are handled. | G2, C3 | addressed | `LinkSourceToGroup` and `relationshipReachable`. |
| `internal/service/image_service.go` | The clock seam is now private (`now`); the same-package regression test still uses it. No new goroutine was found in the inspected fan-out path. | C5, C2, G2 | note | None. |
| `internal/service/undo_service.go` | Addressed: batch link/unlink replay uses a transaction, so partial failures roll back and leave the undo cursor unchanged. | G2, C3 | addressed | `applyStep` batch cases. |
| `internal/service/undo_service.go` | 559 lines, already 528 at HEAD; this change increases existing debt. | C5 | should-fix | Separate step application by domain while keeping the history boundary clear. |
| `internal/service/media_service.go` | Clipboard validation fully decodes each item before checking the size limit, then import decodes it again; large external inputs can allocate beyond the intended limit. Decode error is discarded in favor of a generic error. | G2, C3 | should-fix | `validateClipboardMedia`; bound encoded length before decoding, retain `%w` cause where safe, and avoid duplicate decoding where practical. |
| `internal/store/library.go` | Parenthesizing the unplaced predicate correctly limits its interaction with other filters; no additional concrete standards finding. | G1 | note | None. |
| `internal/service/canvas_service_test.go` | No additional concrete standards finding identified in the inspected change. | G1 | note | None. |
| `internal/service/image_fanout_test.go` | Addressed: added operation-log failure rollback and partial undo/redo replay failure regressions. | G1, C6 | addressed | Transaction/history boundary tests. |
| `internal/service/image_service_test.go` | No additional concrete standards finding identified in the inspected change. | G1 | note | None. |
| `internal/service/media_processor_test.go` | No additional concrete standards finding identified in the inspected change. | G1 | note | None. |

## Verification status

| Check | Result |
| --- | --- |
| `cd frontend && bun install --frozen-lockfile` | Passed; lockfile is consistent and unchanged. |
| `cd frontend && bunx tsc --noEmit` | Passed. |
| `cd frontend && bun run test:unit` | Passed: 14 tests, 59 assertions. |
| `nix develop -c bash -lc 'go test ./...'` | Passed. |
| `nix develop .#e2e --command bash -lc 'cd frontend && bunx playwright test e2e/settings.spec.ts --workers=1'` | Passed: 5 tests, 1 worker. `bunx tsc --noEmit` passed. `SettingsDialog.update()` writes localStorage synchronously; root startup restores from storage, and same-tab updates use the custom event (`storage` is cross-tab only). The persistence timeout was a test interaction bug: the Base UI select popup is inside a modal dialog, so Playwright pointer clicks on its portaled options are blocked by the dialog. Keyboard interaction with the option fixed it. The trigger displays lowercase enum IDs, not labels. Invalid JSON falls back without a storage-failure warning by design; the warning applies to denied/failed storage access or writes. |

Other audit findings remain outside this scoped fix. The full E2E suite was not run.

## Scoped Go fix appendix

- The operation-log insert, redo-tail removal, cursor update, and grouped relationship writes now use the same SQL transaction through `Repo.RecordOperationInTx`.
- Batch link and unlink replay now use transactions. Tests inject failures on a later relationship and verify that the full batch and cursor remain unchanged.
- The grouped relationship regression injects an operation-log insert failure and verifies both links and history roll back.
- Privatized the clock seam as `ImageService.now`; same-package tests retain access without adding a binding-facing exported field.
