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

## Integration blockers

This branch is not a complete write-lifecycle implementation. It still has a
branch-local repository lane. The integration owner must consolidate it with
the shared coordinator. Do not add a second queue or treat this local lane as the
final coordinator.

The shared coordinator must track settlement per effect and per child of a
batch: confirmed success, confirmed rejection, or unknown. View cancels queued,
undispatched Edit effects. A dispatched effect must settle before the lane
advances, and its result must reconcile before later mode work consumes the
graph. Undo and Redo must use this same lifecycle. `allSettled` or a failed
transport must not hide an unknown child while other effects continue.

Matching snapshots do not establish that an unknown remote effect has stopped.
Do not clear an unknown state from successful reads or from owner replacement.
Without an authoritative per-operation status or backend barrier, keep the
repository fenced and show an actionable unknown-outcome message. Local UI intent
guards capture the latest monotonic selection revision from the current reference
at pointer and keyboard event boundaries. They cancel queued Ctrl-drag or D/S/R
gestures after an A→B→A selection change and suppress stale UI updates. They do
not resolve the coordinator, Undo/Redo, or batch-settlement requirements.

The integration audit must include `use-undo` dispatch and the
`Promise.allSettled` mutation batches in `use-canvas-asset-operations` and
`library-panel.tsx`. A batch must retain each started child's known-success,
known-rejection, or unknown state and must not advance until every dispatched
effect settles. A rejected transport is not a known rejection of the remote
mutation.

## Failure and owner lifetime

A successful write is followed by refresh and publication only by an active
owner. A disposed owner must not refresh or publish. If a replacement owner is
active when an older dispatched write settles, the repository lane asks the
replacement owner to reconcile. If no owner is active, the lane keeps the
reconciliation requirement for the next owner.

A failed refresh fences further mutations and mode transitions. An uncertain
transport failure also fences mutations. Successful reads do not prove that a
remote request has stopped. This branch therefore does not clear an uncertain
write fence from matching snapshots. It keeps the repository fenced across owner
replacement and displays an actionable unknown-outcome message. Only an
authoritative backend operation-status result or barrier can safely clear this
state. The current branch has no such backend contract.

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

Viewport operations also use a controller-local request lifecycle. Each request
captures its owner, repository, mode request revision, and owner activation epoch.
Only one XYFlow setter may be in flight. A newer owner, mode, or user-navigation
request supersedes queued work, then waits for an already-dispatched setter to
settle before applying its target. This ordering matters because XYFlow can apply
a viewport before its promise resolves and does not expose cancellation. Restore,
initial-fit, anchor, command, and user origins are kept separate so setter echoes
cannot be saved as user navigation. A false setter result is retried a bounded
number of times and then reported instead of leaving the restore pending forever.

This local viewport lifecycle does not settle remote mutation outcomes. The
shared coordinator, Undo/Redo settlement, and per-child batch outcome tracking
remain integration blockers described above.
