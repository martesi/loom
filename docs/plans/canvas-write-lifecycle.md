# Canvas write lifecycle contract

This contract applies to the View/Edit route. It is intentionally local to this
worktree. It does not modify the separate repository coordinator or import
worktrees.

## Admission and ordering

Each intent captures its owner identity and activation epoch, repository path,
mode-request revision, capability, and user-intent revision. User intent changes
when selection or the active connection tool changes. These revisions are
monotonic. A selection that changes from A to B and back to A is not the same
intent.

`queued` is admission to the local repository lane. It is not dispatch. A queued
Edit-only intent is canceled when a later View request arrives, even if another
request quickly selects Edit again. The new request does not revive the old
intent. The lane checks every token immediately before dispatch.

Dispatch is the write-ordering boundary. A write that reaches `dispatched` cannot
be canceled by Escape, a selection change, a tool exit, or a mode request. It
must settle. Then an authoritative refresh must be accepted before a later
repository-lane operation or mode transition can consume the graph. A stale
intent may not select, reveal, or focus anything after dispatch, but it must not
suppress this refresh.

## Coordinator integration decision

The earlier coordinator design preserved FIFO for every write admitted before a
View request. That rule conflicts with View canceling queued, undispatched Edit
intents. The resolution is to define coordinator admission as `queued`, not
`dispatched`: preserve FIFO among dispatched writes, but allow a newer View
request to cancel older queued Edit intents. Do not translate a queued intent
into an irreversible coordinator write before the local dispatch check.

The coordinator/import integration owner must preserve this distinction when
integrating the separate work. This branch uses a local per-repository lane and
does not claim that the coordinator or import worktree has adopted this
contract.

## Failure and owner lifetime

A successful write is followed by refresh and publication only by an active
owner. A disposed owner must not refresh or publish. If a replacement owner is
active when an older dispatched write settles, the repository lane asks the
replacement owner to reconcile. If no owner is active, the lane keeps the
reconciliation requirement for the next owner.

A failed refresh fences further mutations and mode transitions. An uncertain
transport failure also fences mutations. One read does not prove that a remote
request has stopped. Retry therefore requires the user to wait until the prior
request has stopped. The retry reads two snapshots and requires the same
revision before clearing the fence. Equal snapshots are evidence for retry, not
proof that a remote request cannot still run.

## Layout and viewport writes

Edit arrangement uses the current displayed graph and displayed node dimensions
to calculate positions. For selected-subgraph arrangement, unselected displayed
nodes are fixed obstacles. The write contains only changed positions and retains
the exact stored width and height values, including `null` dimensions. The
accepted layout snapshot revision is checked by the service. The write and its
before/after geometry belong to one undo step. A stale revision rejects the
whole operation; the caller must refresh before retrying.

View and Edit keep independent viewports. They are persisted separately per
repository. On first use, the existing repository viewport is the fallback for
both modes. Once a mode-specific viewport exists, it takes precedence. Repository
readiness gates viewport restoration and saves so an initial default viewport
cannot replace a saved viewport.
