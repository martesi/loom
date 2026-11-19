# Settings domain

**Status:** Proposed; planning only. No implementation or test validation is claimed.
**Scope:** Add repository and device preferences without changing the Assets / Canvas / Inspector model.

## Contract and current evidence

Preserve [the product contract](../../r/ui.md) and [the UI experiment](../ui-experiment-plan.md): one repository Canvas, one active selection surface, overlay chrome, and distinct unplace / trash / purge actions. Settings is a utility domain, not a fourth selection surface or a new board model.

Relevant tracked sources:

- `frontend/src/routes/canvas.tsx` owns the action catalog and dispatch. `show-shortcuts` currently opens the palette in shortcut-only mode; there is no Settings entry.
- `frontend/src/lib/action-catalog.ts` defines stable IDs, localized search fields, shortcuts, eligibility, disabled reasons, and execution callbacks.
- `frontend/src/routes/ui-mocks.tsx` contains Studio, Night, and Contact visual concepts. These are comparison mocks, not implemented themes or separate product shells.
- `internal/service/settings_service.go` already exposes repository-scoped string `Get` / `Set` over `internal/store/settings.go`. An unset key returns an empty string. This is infrastructure, not a complete typed preferences API.
- `internal/service/canvas_service.go` implements `ImageService.GetViewport` / `SetViewport` using the existing `canvas_viewport` setting. Do not duplicate this state.
- `internal/store/repo.go` derives the repository name from the folder basename. `internal/service/repo_service.go` uses that name in recent and opened repository summaries.
- `internal/service/media_service.go` implements import through `ImageService` and defines the 30-day trash retention policy. `internal/service/image_service.go` invokes expired-trash cleanup during loading. Settings must describe the actual cleanup boundary, not promise a continuous background scheduler.
- `internal/repoconfig/config.go` owns global recent-repository configuration. Discover its location through the existing loader; do not embed a machine-specific path.
- `frontend/src/i18n.ts` activates English. `frontend/lingui.config.ts` is the source of truth for supported catalogs. A language picker must not advertise catalogs that are not shipped.
- Existing Playwright suites cover palette, shelves, canvas view, import, and lifecycle behavior. No Settings-specific suite exists in the reviewed inventory.

## 1. Entry points and presentation

Use a single accessible Settings dialog with section navigation and a content page. Take Figma's settings/modal pattern as design inspiration: clear headings, grouped controls, scope labels, and predictable dismissal. Take t3code-style web preferences as inspiration for compact navigation and immediate feedback. These are proposed adaptations, not claims about a checked version of either reference. Review the actual reference UI before visual implementation.

| Entry | Proposed behavior |
| --- | --- |
| Top island | Add **Settings…** to the existing repository/actions menu. This keeps idle chrome compact; a separate permanent gear is not required. |
| Command palette | **Open Settings** plus section-specific commands. Close the palette before transferring focus to Settings. |
| Shortcut | `Mod+,` opens Settings. Add comma-key coverage to the existing shortcut normalizer. Handle it only in the application workspace, outside editable fields; do not override native text editing or another modal editor. |
| Rail | Use a labeled section rail **inside Settings**, not new Canvas edge tabs. If a later shell adopts a persistent rail, its Settings item must dispatch the same action; that shell change is not part of this plan. |
| Keyboard reference | Preserve `show-shortcuts` and `?`, but route them to Settings → Keyboard. Do not retain two independent shortcut inventories. |

Sections: **Repository**, **Appearance**, **Canvas**, **Language & locale**, **Keyboard**. Show **This repository** or **This device** beside relevant groups. Repository sections identify the target repository; global sections remain available without one.

- Desktop: bounded dialog, section rail on the left, scrollable content on the right, persistent title and Close control. Narrow screens: viewport-sized dialog with an accessible section selector and one content page at a time.
- Trap focus; label the dialog and section navigation. Escape closes Settings before drawer or selection handlers. Underlying Canvas, menus, and drawers must be inert while it is open.
- Opening and closing must preserve Canvas host bounds, viewport, active selection, drawer visibility, and pin state. Settings does not become an active selection owner.
- Restore focus to the visible opener. If that opener is hidden or removed, use the Canvas host. Palette-to-Settings handoff must not race palette focus restoration.
- Focus Canvas still permits Settings through the palette and shortcut. Closing Settings returns to Focus Canvas; it does not reveal hidden chrome.
- Settings pages share one behavior across concepts: Studio uses warm surfaces, soft corners, and blue emphasis; Night uses dark surfaces, restrained borders, and lime emphasis; Contact uses cream surfaces, strong rules, square forms, and orange emphasis. Keep readable contrast, visible focus, and generous control targets in every treatment. Density must not reduce accessible hit areas.
- Do not equate Studio / Night / Contact with light / dark theme values. They are design languages; shipping alternate skins is a separate approval.

## 2. Settings by scope

| Section | Controls and initial contract | Scope |
| --- | --- | --- |
| Repository | Editable display name; read-only location; fixed trash-policy explanation; import defaults | Repository |
| Appearance | Theme: System / Light / Dark; density: Comfortable / Compact | Device |
| Canvas | Saved-viewport explanation; first-open fallback defaults; explicit reset of saved viewport | Repository |
| Language & locale | System language or supported catalog; date/number locale follows the resolved language initially | Device |
| Keyboard | Searchable, grouped reference generated from action definitions and gesture documentation; platform-specific hints | Reference only |

### Repository

- Add an optional display name with folder-basename fallback. Rename changes identity presentation only, not the folder path, recent-repository key, asset paths, or window ownership. Validate trimmed nonempty input and a documented length limit on the backend; update selector, window title where supported, and recent summaries after success. Clearing an override is a separate explicit **Use folder name** operation.
- Show **Trashed assets are retained for 30 days, then removed automatically during repository cleanup.** Explain the difference from Canvas unplace and confirmed permanent purge. Retention is a product policy, not a slider. Do not add empty-trash, restore-all, or retention overrides.
- Initial import default: destination folder for explicit file import, defaulting to repository root. Use the existing directory browser. Store a repository-relative directory, exclude `.loom`, and reject traversal, symlink escape, or a destination that is no longer usable. Show an actionable failure rather than silently importing elsewhere.
- Explicit import registers assets unplaced, as required by `r/ui.md`. This behavior is explanatory, not configurable. Clipboard paste continues to create copies at repository root and place them only when Canvas owns focus. Import defaults must not alter clipboard semantics.
- Keep existing fresh-copy naming and metadata behavior. Do not offer move-original, overwrite, auto-place, automatic tagging, or conversion defaults without a separate product decision and backend support.

### Appearance

- System follows the platform color preference. Explicit Light / Dark takes precedence. Apply theme and density to chrome, forms, menus, and Settings; do not resize persisted Canvas nodes, move nodes, or refit the viewport.
- Theme changes use the shared root token layer. Restore saved theme and density at application startup, before route-specific UI is available, and keep observing system-theme changes for the application lifetime.
- Preview changes immediately, but show persistence failures. System theme changes while Settings is closed must still update the resolved theme.

### Canvas

- Saved `{x, y, zoom}` remains authoritative. The initial behavior remains restore saved viewport, otherwise fit placed nodes once. Fit all / Fit selection persist through `ImageService`; Reset 100% retains the current center.
- Proposed fallback preference: **Fit placed assets** (default) or **Centered at 100%** when there is no saved viewport. Treat this as a deliberate extension to the current first-open contract, requiring approval before implementation. An empty Canvas uses a defined center and zoom of 1 rather than a failed fit.
- Changing the fallback does not erase or overwrite the saved viewport and does not immediately move the Canvas. Clearly label it **When no view is saved**.
- **Reset saved view** explicitly clears the saved viewport through a typed backend operation, then applies the chosen fallback once. It changes only view state, not placement, dimensions, relationships, or sets. Do not clear storage by writing malformed JSON or invent a second viewport key.

### Language and keyboard

- Derive selectable languages from shipped catalogs. A single available catalog is a valid initial state; show it without fake alternatives. Resolve System against supported catalogs, with source-language fallback for unsupported language or stale saved values.
- Load the target catalog before activation. On failure, retain the working language and show Retry. Update labels, validation, status messages, palette search fields, and shortcut descriptions after activation without reload or selection loss.
- Use Lingui for messages and plural forms; use `Intl` for dates and numbers with the resolved locale. Do not translate stable IDs, storage keys, paths, or actual key bindings. Separate number/date locale overrides are deferred until a concrete need exists.
- Keyboard is read-only in this pass. Generate command rows from the shared catalog, including applicable context and disabled reasons. Include gesture-only entries for pan and relationship creation from one shared reference source. Preserve native `Mod+A/C/V/Z` in Settings fields. Key remapping and conflict resolution are out of scope.

## 3. Storage and backend boundaries

| Data | Authority | Why |
| --- | --- | --- |
| Display-name override, explicit-import destination, first-open fallback | Repository SQLite settings, accessed through Go | Travels with the repository and is independent of browser origin |
| Actual saved viewport | Existing `canvas_viewport` via `ImageService` | One viewport owner; existing validation and view contract |
| Trash retention | Backend policy constant and lifecycle implementation | Safety policy, not a user preference |
| Theme, density, language preference | Versioned, namespaced localStorage preferences | Device/browser-origin preferences; available when the backend is offline |
| Recent repositories and native app configuration | Existing Go app-config loader | Preserve current configuration ownership; do not turn repo settings into global settings |
| Open dialog/section, draft form, saving/error state | React state | Temporary interaction state, not repository data |

Use the existing `SettingsService` / `Repo` bootstrap-close pattern behind typed read/update operations. Avoid arbitrary frontend writes to internal keys. Define defaults, schema version, validation, and allowed enum values centrally. Repository name changes must also be resolved through `RepoService`, not only patched into the open dialog. Import destination enforcement belongs in `ImageService.ImportMedia` or its explicit-import boundary, not solely in a picker.

Use dedicated preference DTOs with partial updates rather than a generic Settings blob that can overwrite unrelated viewport or panel keys. Serialize concurrent writes for the same repository through the established operation boundary where needed. Pin requests to repository identity and discard late responses after a switch. Do not bootstrap an arbitrary folder merely to inspect Settings without a valid open-repository context.

localStorage is deliberately not shared across native windows with different origins or across web devices. Document that boundary in UI help. Validate preference data with a schema; reject malformed JSON, invalid enums, arrays, and unsupported schema versions. Handle denied storage access and cross-tab `storage` events. Invalid data falls back to defaults in memory. Announce **Changes will not be saved on this device** only when storage access or persistence fails. Do not add a backend copy of the same preferences. If native cross-window preference sharing later becomes required, migrate global preferences to the app-config owner with explicit precedence and migration tests.

### Save, failure, and outage recovery

- Enum controls save on change; repository name and destination use explicit Save / Cancel. A pending or failed draft remains visible until saved or discarded. Closing with a dirty draft requires a small discard decision; clean Settings closes directly.
- Distinguish loading, loaded, saving, saved, invalid, and failed states. Disable duplicate submission. Announce success only after the authoritative write succeeds.
- If repository loading fails, retain access to device settings and Keyboard; show a repository error with Retry. Never replace failed reads with defaults and write those defaults back.
- A failed write preserves the draft and last confirmed value. Retry repeats that exact validated update after rechecking repository identity. Do not automatically replay repository writes after a reconnect or silently apply them to a different repository.
- Navigating to another repository with a pending draft must offer discard/cancel. Late reads or saves cannot overwrite the new repository's Settings page.

## 4. Action catalog additions

Follow existing kebab-case IDs. Every entry includes localized label, description, category, aliases, context, eligibility, and execution. Section commands navigate and focus controls; they do not submit hidden forms.

| ID | Label / target | Eligibility or disabled reason |
| --- | --- | --- |
| `open-settings` | Open Settings (`Mod+,`) | Always; opens last section if available, otherwise Appearance |
| `open-repository-settings` | Repository settings | Valid open repository; **Open a repository first** |
| `open-appearance-settings` | Appearance settings | Always |
| `open-canvas-settings` | Canvas settings | Valid open repository; **Open a repository first** |
| `open-language-settings` | Language & locale settings | Always |
| `show-shortcuts` (reuse) | Show keyboard shortcuts (`?`) | Always; opens Keyboard instead of shortcut-only palette |
| `rename-repository` | Edit repository display name | Repository loaded and writable; **Repository settings are loading** / **Repository settings are unavailable** / **Repository is read-only**, as applicable |
| `edit-import-defaults` | Edit import defaults | Same repository guards; focuses destination, does not import files |
| `reset-saved-viewport` | Reset saved Canvas view | Repository loaded, writable, viewport known and saved; **No saved Canvas view** / **Canvas view is loading** / backend failure reason |

Use the Workspace category for entry/navigation and Settings for preference operations. Keep disabled entries visible and searchable; recheck eligibility at execution. Do not label a repository read-only unless the backend reports that capability or failure. Navigation to a repository error page can remain available even when mutation actions cannot run.

Translate all labels, descriptions, categories, curated aliases, scope text, validation, statuses, and disabled reasons with Lingui. Keep IDs and shortcut values locale-independent. `show-shortcuts` must remain stable for existing callers. Settings section buttons and menu entries dispatch through the catalog; Save / Cancel are form controls, not a second command catalog. Add comma-key and platform hint tests before enabling the shortcut.

## 5. Verification gaps and acceptance criteria

Add `frontend/e2e/settings.spec.ts` using the existing isolated repository fixtures. Extend current domain suites for effects; a Settings form value alone is not proof that a preference works.

| Domain | Required Playwright assertions |
| --- | --- |
| Entry and dismissal | Top-island menu, palette, `Mod+,`, and Keyboard entry reach the same dialog/section. Internal rail works by keyboard. Escape and Close restore focus. No graph shortcuts run under the modal; host bounds, selection, viewport, and drawer/pin state remain unchanged. |
| Repository | Display name survives reload and reopening, updates selector/recent summaries, and leaves folder identity and asset paths unchanged. A second repository retains its own values. Invalid names and failed writes do not claim success. |
| Lifecycle | Settings displays fixed 30-day retention and does not expose a retention editor. Keep existing trash/unplace/purge guards. Test cleanup timing and exact boundary with a backend-controlled clock, not a 30-day E2E wait. |
| Import / Assets | Explicit imports use the saved destination and remain unplaced. Invalid or missing destinations fail safely. Clipboard paste still uses root and respects active surface. New assets appear in Assets without metadata or relationship leakage. |
| Appearance | Explicit and System themes resolve correctly, persist after reload, and respond to emulated system changes. Density changes chrome only; graph geometry and selection remain unchanged. Storage-denied/corrupt cases stay usable. |
| Canvas | Saved view wins over fallback; changing fallback does not move the current view. Reset affects viewport only and survives reload. Empty Canvas and first-open behavior are defined. Existing fit/reset shortcuts still persist through the same service. |
| Inspector | Opening Settings and changing appearance/locale do not replace the active selection or lose pending Inspector edits. Closing returns to the same contextual content. |
| Language | Only shipped locales are offered. Activation updates dialog, palette, disabled reasons, and formatted values. Unsupported stored values fall back; failed catalog load retains the prior language. Full switch coverage requires a second shipped test catalog. |
| Keyboard / palette | Shared hints match real bindings on macOS and Windows/Linux, including comma. `?` opens Keyboard; editable fields retain native shortcuts. Disabled Settings actions cannot execute or become successful recents. |
| Outage and isolation | Read failure shows Retry without writing defaults; write failure retains draft; reconnect retry succeeds once. Switching repository rejects stale responses and prevents cross-repository writes. Device settings still work during backend failure. |
| Accessibility / visual | Dialog name, focus trap, navigation, error announcements, narrow layout, reduced motion, and hidden-control inertness. Review Studio/Night/Contact treatments separately; mock screenshots do not prove production theme behavior. |

Add Go tests for typed validation, per-repository isolation, name fallback, relative-path safety, concurrent partial updates, and saved-view reset. Add `bun:test` only for pure preference decoding/migration, locale resolution, action eligibility, and shortcut normalization. Use controlled network/service faults for outages and an independent read/reopen to verify persistence. Do not make arbitrary sleeps or direct localStorage seeding the sole proof of a user save.

## Delivery and approval boundary

1. Approve scope, `Mod+,`, device-origin persistence, display-name semantics, and the proposed first-open fallback extension.
2. Define typed repository preferences and validation; connect name resolution and explicit import behavior to existing Go owners.
3. Build one dialog, internal section rail, focus handoff, and catalog-backed entry points.
4. Add theme tokens, density, safe device persistence, Lingui locale loading, and the shared Keyboard reference.
5. Add failure/retry states and verify each domain with isolated E2E fixtures plus focused backend/unit tests.

Implementation must not introduce configurable trash retention, boards, a persistent Canvas rail, keyboard remapping, new clipboard destinations, or unapproved visual skins. This plan changes no implementation files and does not validate the in-flight working tree.

### Slice 1 implementation note

Added the reusable Settings dialog shell with Appearance (device theme and density) and Keyboard reference sections. Device preferences use the versioned `loom.preferences.v1` localStorage key, with safe in-memory defaults and a visible persistence warning. The shell provides dialog labeling, Escape handling, and focus trapping. Canvas menu, palette, and shortcut entry points remain to be wired by the workspace owner; this slice does not change viewport behavior.

### Slice 1 static review

**Verdict: not ready to integrate as a functional Settings dialog.** The shell is not mounted yet. This review is static; it does not claim runtime, build, or accessibility-test validation.

- **Modal behavior:** `role="dialog"`, `aria-modal`, the title, section navigation, and select labels provide useful names. However, `aria-modal` does not make the background inert. Pointer and programmatic focus can reach it; the Tab handler only wraps at the first and last matching elements and does not recover focus that has escaped. It also includes hidden or disabled matches. The dialog has no bounded height or scrolling for a short viewport. Prefer the existing Base UI Dialog primitive, with one owner for background inertness, focus containment, and dismissal.
- **Focus and Escape:** the document capture listener stops Escape before the route's window bubble listener when focus is inside the dialog, so the current route's drawer and selection handlers should not run in that case. This does not establish correct ordering for other capture listeners or a menu or popup opened above Settings: the handler closes Settings unconditionally. Restore focus only on actual close, not on every change of the `onClose` function identity; the current effect cleanup also restores focus on such changes. Check that the opener is visible and connected, fall back to the Canvas host, and coordinate the palette handoff with its Base UI dialog and the route's deferred focus logic. `aria-modal` alone does not block graph shortcuts if focus escapes.
- **Preferences:** the key has a version suffix, but there is no migration or explicit handling of future versions. Invalid JSON and invalid enum values fall back in memory; JSON `null` also falls back through the catch. A failed read is silently treated as defaults, so denied reads do not show the warning until a write fails. A subsequent write can overwrite malformed or unrecognized data; define and test a non-destructive migration and recovery policy before reuse. There is no `storage` event handling or device-origin scope help. Theme and density are saved but are not applied to the UI or kept active while the dialog is closed; these controls must not be presented as working preferences until connected to a shared owner.
- **Keyboard and Lingui:** the Keyboard page is a placeholder, not the shared action and gesture reference. Existing `show-shortcuts` still opens the palette. All user-facing strings in this component use Lingui macros, including the warning and navigation label; the new messages are not present in the checked-in English catalog. Extract and update the catalog through the project workflow before shipping. Translation and runtime rendering were not verified.

### Slice 2 implementation note

Mounted Settings in the Canvas route. The repository-actions menu and action catalog now expose Settings; `Mod+,` opens Appearance, and `show-shortcuts` opens Keyboard. Palette actions close before transferring focus to Settings. The Keyboard section lists shortcut-bearing actions from the same action catalog used by the palette and includes a brief Canvas gesture note. Repository settings and Canvas viewport fallback/reset remain deferred. This implementation has static TypeScript validation only; no Playwright or runtime accessibility validation was run.

### Proposed slice 2

Coordinate all `canvas.tsx` changes with its current owner. First repair the modal and preference issues above, or keep the unfinished controls unavailable. Use the existing dialog primitive and shared preference owner rather than adding another overlay or persistence authority.

1. Wire `open-settings`, `open-appearance-settings`, and the existing `show-shortcuts` ID through the action catalog. Add only section actions for pages that exist; do not advertise Repository, Canvas, or Language pages before they work. Route `show-shortcuts` and `?` to a catalog-backed Keyboard page, retaining one shortcut inventory and adding the shared gesture reference.
2. Add **Settings…** to the existing top-island repository/actions menu, dispatching `open-settings`. Close the menu first. Add `Mod+,` outside editable fields and other modal editors; cover comma normalization and platform hints with focused unit tests. Preserve native editing and the existing Escape priority. Close the palette before opening Settings and prevent its deferred focus handling from stealing focus; restore to the visible original opener or Canvas host on close.
3. Choose **Repository** as the next section, starting with a read-only repository identity and accurate trash-policy explanation, followed by typed display-name and import-default operations with backend validation and repository-switch protection. Do not add placeholder mutation actions or claim a save before backend support exists. Keep device pages usable when repository loading fails.
4. Defer the Canvas viewport section's new fallback choice and reset operation. The first-open fallback extension needs explicit approval; do not change the existing saved-viewport authority or fit behavior without it. Any later reset needs a typed backend operation.

Before release, verify modal layering, focus restoration, editable-field shortcuts, persistence failures and migration, cross-tab changes, and real theme effects. Run the planned focused tests and accessibility/E2E checks separately; none were run for this static review.

### Repository section implementation note

Added a Lingui-backed Repository page with the fixed 30-day cleanup policy, lifecycle distinction, and current import behavior. Rename and import-destination controls remain unavailable because the route does not provide repository identity to the dialog and typed backend operations do not exist. The page states this limitation and does not claim these settings can be changed. Read-only repository name and location display remain deferred until the dialog receives the active repository summary. No Go backend changes were needed.

### Settings E2E coverage

`frontend/e2e/settings.spec.ts` covers the implemented Settings entry points (top-island menu, command palette, and `Mod+,`), appearance and density persistence across reload through the versioned `loom.preferences.v1` key, corrupt-storage fallback and warning, Escape dismissal before an open drawer, and the Keyboard shortcut reference. This suite does not validate deferred repository mutations, Canvas settings, or other gaps in the verification table.

The Appearance select trigger displays the persisted enum IDs (`system`, `light`, `dark`; `comfortable`, `compact`) through Base UI `SelectValue`. E2E assertions must check those values, not the translated option labels. Invalid JSON falls back in memory without a persistence warning; the warning is for storage access or write failures. Select options are tested with keyboard input because the modal dialog blocks pointer interaction with the portaled popup.

**Triage:** All five focused Settings E2E tests pass. One issue found during validation: after Escape closes Settings while the Assets drawer is open, a subsequent Escape did not close the drawer in the tested server-mode workspace. This is recorded as an app-level Escape/drawer behavior gap; the focused test asserts the required first Escape closes only Settings and leaves the drawer open.

### Escape layering fix

The Canvas Escape handler now treats the Settings section state as the active modal layer. It does not let a still-mounted dialog during its close transition block a later Escape. The Settings E2E test verifies the full sequence: first Escape closes Settings and leaves Assets open; second Escape closes Assets.
