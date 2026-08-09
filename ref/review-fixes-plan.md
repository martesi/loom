# Review fixes and default-worktree rebase plan

Planning document only. None of the rebase, conflict resolution, implementation,
or verification commands below have been run as part of writing this plan.

## Goal

Rebase the `ex` workspace's change stack onto the separate Jujutsu workspace
revision `default@`, then fix the three review findings:

1. concurrent undo-logged mutations can race and leave committed mutations without
   matching operation-log entries;
2. grouping images that already belong to groups breaks group invariants and cannot
   be undone faithfully;
3. server-mode token authentication does not cover Wails' event WebSocket.

The implementation should preserve the canvas/explorer work already present in the
default workspace and the server/web-e2e work in `ex`.

## Current JJ topology

- Current workspace: `ex@` (`loovprom`). It was empty before this planning pass and
  should contain only this plan when implementation begins.
- Default workspace: `default@` (`lozmlosu`, currently an empty working-copy change)
  whose parent is `rylnvztn` (`fix canvas node actions and explorer refresh`).
- The two workspaces diverge after `xsrtxuxp` (`issue fix`).
- `ex` currently has three changes not in `default@`: the server-mode change, the
  web-e2e-shell change, and the empty working-copy change.
- `main` is not the requested destination. The rebase destination must be the
  workspace revision `default@`.

The physical checkout registered for the default workspace may be absent in managed
environments. Do not run `jj status` from that missing checkout: JJ can interpret the
absent files as deletions and snapshot them. Read `default@` through repository
revsets from the live `ex` workspace unless the default checkout is known to be
materialized.

## Stage 0 — Rebase `ex` onto the default JJ worktree

This stage must happen before implementing the fixes so conflict resolution starts
from the default workspace's latest canvas/explorer behavior.

### Preflight

From the `ex` workspace:

1. Inspect `jj status` and confirm the current workspace contains only this intended
   plan (or describe it as its own planning change before proceeding). Stop for any
   unrelated edits.
2. Record the current operation ID from `jj op log -n 1` as the recovery point.
3. Inspect, without mutating either workspace:
   - `jj workspace list`
   - `jj log -r 'default@ | default@- | @ | @- | roots(default@..@)'`
   - `jj diff --from default@ --to @ --stat`
4. Stop if `default@` is conflicted or unexpectedly moved. Do not substitute `main`.

### Rebase command

Run the branch rebase from `ex`:

```sh
jj rebase -b @ -o default@
```

Equivalent explicit-source form, useful for auditing the selected stack first:

```sh
jj rebase -s 'roots(default@..@)' -o default@
```

Use one form only. `-b @ -o default@` is preferred because it expresses the intent
directly: move the branch containing the current workspace onto the default workspace
revision.

### Conflict policy

List conflicts with `jj log -r 'conflicts() & (default@..@)'`. Resolve them in the
change where they originate (`jj edit <change-id>`), then return to the `ex`
working-copy change. Preserve both sides' behavior rather than accepting one side
wholesale.

Expected hotspots:

- `main.go` / `app.go`: retain the default tree's latest service/UI setup while
  preserving the `!server` desktop entrypoint and shared `appOptions` extraction.
- `main_server.go`: retain token-gated server startup, subject to the authentication
  redesign in Stage 3.
- `frontend/src/routes/board.tsx`, Explorer/Library refresh plumbing, and generated
  bindings: preserve the default tree's canvas-node fixes and server-mode capability
  handling.
- `frontend/vite.config.ts`: combine default-tree Vite settings with server-mode host
  handling.
- `flake.nix`, `.gitignore`, and `build/e2e/start-browser.sh`: preserve the default
  development environment and the additive `web-e2e` shell/browser helper.
- `frontend/package.json` and `frontend/bun.lock`: keep the default tree's dependency
  changes, then regenerate the lockfile with Bun instead of hand-merging lock entries.

### Rebase acceptance checks

- `jj log -r 'default@ | roots(default@..@) | @-'` shows the first `ex` change as a
  direct child of `default@`.
- `jj log -r 'conflicts() & (default@..@)'` is empty.
- `jj status` reports only intentional conflict-resolution changes, or clean if all
  resolutions were folded into their source changes.
- Review `jj diff --from default@ --to @ --stat` to ensure the default canvas/explorer
  change was not accidentally reverted.

Do not abandon the original stack or update the `default` workspace pointer as part
of this rebase. If the result is wrong, restore the recorded preflight operation with
`jj op restore <operation-id>` before doing more work.

## Stage 1 — Serialize undo-aware mutations per repository

### Problem

Frontend bulk flows issue multiple mutating RPCs with `Promise.all`. Each RPC opens a
separate SQLite connection. `RecordOperation` reads `undo_cursor`, calculates
`cursor + 1`, and only later inserts that sequence number. Two calls can choose the
same value; one mutation is already committed when its operation-log insert fails.
Undo and redo also perform a non-atomic peek/apply/cursor sequence and can race with
new mutations or each other.

### Backend design

1. Add a process-local, per-repo operation coordinator in `internal/store` or
   `internal/service`:
   - key it by a canonical absolute repo path;
   - store locks in a `sync.Map` (or a mutex-guarded map);
   - expose a scoped lock helper whose unlock is always deferred.
2. Acquire that lock at the beginning of every undo-aware mutating service method and
   hold it across:
   - reading prior state;
   - applying the mutation;
   - appending the operation-log entry.
3. Use the same lock across the full `Undo` and `Redo` sequence: peek, apply, and mark
   the cursor. `State` may use the lock for a coherent two-peek snapshot.
4. Cover all services that call `recordOp`: image, board membership, group, tag,
   prompt, and undo/redo. Keep non-undo settings reads/writes outside this coordinator.
5. Keep `RecordOperation`'s cursor read, redo-tail deletion, log insert, and cursor
   update together. With the service-level coordinator providing process ordering,
   document that the SQLite transaction provides database atomicity for the log
   itself.
6. Prevent a successful mutation from being reported as a clean failure with no undo
   entry. Preferred bounded approach:
   - introduce a `mutateAndRecord` helper that holds the coordinator;
   - if log append fails, apply the already-built inverse step before releasing the
     lock;
   - return a combined error if both logging and compensating rollback fail.
   Filesystem mutations such as trash/move must retain their existing disk/DB rollback
   behavior and be tested separately.
7. Keep frontend bulk calls functionally unchanged initially; backend correctness
   must not depend on callers avoiding concurrency. As a follow-up optimization,
   replace per-image RPC fan-out with batch service methods so a bulk user action can
   become one undo entry, but do not make that refactor a prerequisite for fixing the
   race.

### Tests

- Start two goroutines that mutate different images in the same repo; force them to
  overlap and assert both return success, the log has dense unique sequence numbers,
  and two undos restore both images.
- Run concurrent record/undo and concurrent double-undo tests; assert each operation
  is applied at most once and the cursor remains valid.
- Repeat with archive, board membership, link removal, and trash/restore (including
  on-disk file locations).
- Add a record-failure test and assert either the inverse restores the mutation or a
  combined rollback error is surfaced—never a silent unlogged mutation.
- Run these tests under `go test -race`.

## Stage 2 — Enforce group membership invariants and faithful undo

### Policy

An image may belong to at most one group. “Group as set” accepts only distinct,
currently ungrouped images. Regrouping is rejected rather than silently moving images
between groups; an explicit move-between-groups workflow can be designed later with a
compound undo payload.

### Store/service changes

1. Add transaction-scoped helpers to load and validate the current `group_id` for a
   set of image IDs.
2. `CreateGroup`:
   - deduplicate IDs before applying the minimum-two-members rule;
   - verify every image exists and has `group_id IS NULL`;
   - reject the whole request before insertion if any image is already grouped;
   - check affected-row counts when assigning members.
3. `AddGroupMember`:
   - verify the destination group exists;
   - treat membership in the same group as an explicit no-op with no undo entry;
   - reject membership in a different group;
   - only log when one row actually changes.
4. `RemoveGroupMember`:
   - update with `WHERE id = ? AND group_id = ?`;
   - require exactly one affected row before counting remaining members;
   - never detach an image from an unrelated group;
   - keep the existing dissolve-under-two behavior and full group-existence undo
     payload when dissolution occurs.
5. `SetGroupCover` must verify that the proposed cover is a current member of the
   target group. A same-cover call is a no-op with no log entry.
6. Apply equivalent defensive checks in undo replay (`RecreateGroup`, member add, and
   cover steps). If out-of-band state prevents a faithful replay, return a specific
   error without advancing the undo cursor.
7. Keep all validation and mutation for one action in a single SQLite transaction.

### Frontend changes

1. Propagate whether the active Library/Explorer/canvas selection is entirely
   ungrouped.
2. Disable toolbar, context-menu, and Ctrl/Cmd+G grouping when the selection contains
   grouped images or fewer than two distinct images.
3. Still surface backend validation failures through the existing toast path; frontend
   disabling is guidance, not the integrity boundary.

### Tests

- Creating a group from an already-grouped image fails without changing either group
  or appending an operation.
- Duplicate IDs cannot satisfy the two-member rule.
- Removing a member with the wrong group ID changes nothing.
- Adding a member from another group changes nothing.
- Setting a non-member as cover fails.
- Create/undo/redo, add/undo/redo, remove-with-dissolve/undo/redo, and cover changes
  preserve exact group IDs, memberships, and cover IDs.

## Stage 3 — Put the server token gate around every sensitive route

### Problem

`application.AssetOptions.Middleware` only wraps Wails' asset/RPC handler. In the
pinned Wails beta, server mode registers `/wails/events` directly on an outer mux
before the asset handler, and the WebSocket accepts any origin. The current gate
therefore cannot protect event broadcasts.

### Dependency/API decision

1. Check whether a newer compatible Wails v3 release exposes outer server middleware
   (for example, a `ServerOptions.Middleware` or handler hook). Prefer a supported
   upstream API and upgrade if the migration is bounded.
2. If the pinned API still has no hook, pin a narrowly patched Wails commit/fork that:
   - adds outer HTTP middleware to `application.ServerOptions`;
   - wraps the complete handler returned by server mode's `createHandler`;
   - includes tests covering assets, RPC transport, custom JS, and the event
     WebSocket;
   - makes no unrelated framework changes.
3. Do not claim that asset middleware protects the WebSocket, and do not rely on the
   WebSocket's `clientId` as authentication.

### Application wiring

1. Configure the token gate as outer server middleware in `main_server.go` so it sees
   `/wails/events` and all RPC/asset routes.
2. Keep thumbnail/full-image routing inside the authenticated handler.
3. Decide and document `/health` explicitly. Recommended: leave only `/health`
   unauthenticated for orchestration, and gate every other route.
4. Preserve the token-query bootstrap flow: validate `?token=`, set the HttpOnly
   SameSite cookie, strip the token with a redirect, then allow the browser's
   WebSocket handshake using that cookie.
5. Add origin validation for the WebSocket if Wails exposes it. Token validation is
   mandatory even if origin validation is unavailable.

### Tests

- Without token/cookie: `/`, static assets, RPC transport, thumbnails, full images,
  and `/wails/events` are rejected; `/health` follows the documented exception.
- A valid token URL redirects without retaining the token and sets the session cookie.
- With the cookie: assets, RPC calls, images, and the WebSocket work.
- A cross-origin WebSocket without the cookie is rejected.
- Broadcast a test event and prove only authenticated clients receive it.
- Verify desktop (`!server`) mode remains unaffected.

## Stage 4 — Integrated verification and handoff

1. Backend formatting/static checks:
   - `gofmt` on touched Go files;
   - `nix develop 'path:.' -c go vet ./...`;
   - `nix develop 'path:.' -c go test ./...`;
   - `nix develop 'path:.' -c go test -race ./internal/...`.
2. Frontend checks:
   - regenerate Wails bindings if any service API changes;
   - `cd frontend && bun install` only when dependency/lock changes require it;
   - `bun run check`;
   - `bun run build`.
3. Server-mode integration:
   - build with the `server` tag;
   - use the `web-e2e` shell to test login, RPC, image serving, and WebSocket auth;
   - exercise bulk archive/trash/restore and verify undo order and filesystem state.
4. Group regression pass in both canvas and panel selections, including attempted
   regrouping and every undo/redo direction.
5. Final JJ audit:
   - `jj status` is clean or contains only intended implementation changes;
   - `jj log -r 'conflicts() & (default@..@)'` is empty;
   - the first `ex` change remains based on `default@`;
   - `jj diff --from default@ --to @ --stat` contains both the preserved default-tree
     canvas/explorer work and the intended server/review fixes.

## Suggested change structure

Keep reviewable changes separate after the rebase:

1. resolve the server/web-e2e stack onto `default@`;
2. serialize undo-aware mutations and add concurrency tests;
3. enforce group invariants and add undo regression tests;
4. gate the complete server handler/WebSocket, including any focused Wails dependency
   update;
5. regenerate bindings/lockfiles and add integration verification adjustments only
   where required.

Do not combine the default-worktree rebase with semantic fixes in one opaque conflict-
resolution change. The graph should make it possible to review the preserved default
work, the re-applied server work, and each correctness fix independently.
