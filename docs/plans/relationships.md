# Relationships graph interaction plan

## Goal and boundaries

Make relationships discoverable and understandable across Canvas and Inspector
without adding permanent connection handles. Keep the directed acyclic graph,
one Canvas placement per asset, and the selection rules in `r/ui.md`. This
is a plan, not an implementation. It does not add edge reconnection, set
sources, or a new relationship type.

## Interaction contract

### Create by gesture

- Show a concise, platform-aware hint in the Canvas action catalog and on an
  image's contextual actions: **Ctrl/Cmd-drag an image to another image**.
  Normal drag continues to move nodes. The image under pointer-down is the
  source, even when other images are selected. A collapsed set is not a source.
- After the existing drag threshold, mark the source and draw a temporary,
  directional line to the pointer. Use a neutral line over empty space, a
  distinct valid line and target highlight over a valid image or collapsed
  set, and a distinct rejected line and target highlight over an invalid
  target. Do not rely on color alone: add a short status label or icon and
  expose the reason to assistive technology.
- Reject self-links and cycle-producing links with specific feedback while
  hovering and after an attempted drop. Releasing on empty space or pressing
  Escape cancels without a mutation. Clear all preview state on pointer
  cancellation, lost capture, repository change, and completion.
- A collapsed set target means a one-time fan-out from the grabbed source to
  the set's current members, not a persistent link to the set. Preview the
  member count and explain the one-time behavior. Validate the entire target:
  if any member is the source or would create a cycle, reject the whole drop
  and identify the reason. Later membership changes do not change existing
  relationships. Existing source/member edges must not produce duplicates;
  report an all-existing drop as a no-op and a mixed drop by its actual result.
- Treat client validation as feedback, not authority. Revalidate at commit
  against current membership and graph state. Define the fan-out as one
  all-or-nothing operation, including concurrent changes and failures; do not
  report success for a partial result. Show a useful error and refresh stale
  graph state on rejection. Preserve the existing undo model for successful
  mutations; a fan-out should undo as one user action.

### Select, navigate, and remove

- Make an edge's direction and selected state visible and give its hit area
  enough room to select without changing its appearance. Selecting an edge
  makes Canvas the active selection context. Edges support selection,
  navigation to either endpoint, and deletion only; they cannot reconnect.
- Inspector for one selected relationship identifies source and derived asset,
  offers **Go to source**, **Go to derived**, and **Remove relationship**.
  Delete/Backspace on Canvas removes selected relationships; it must not
  delete endpoint assets. For mixed node/edge selections, retain the existing
  surface-scoped behavior and clearly state the separate asset and relationship
  counts before a destructive action where confirmation is used.
- For multiple selected relationships, show a pluralized relationship count
  and a bulk remove action, not a duplicated list of endpoints. Mixed
  selection summaries distinguish asset, set, and relationship counts. Keep
  keyboard focus and Inspector state coherent after removal and refresh.

### Inspector: Sources and Derived

- For a single selected image, show incoming **Sources** and outgoing
  **Derived** separately, with direction, asset name/thumbnail, accessible
  action names, clear empty states, and per-row **Go to** and **Remove
  relationship**. Removal changes only that edge; refresh both Canvas and
  Inspector, and report errors without pretending the edge disappeared.
- Go to a placed endpoint selects and centers its Canvas node; expand its set
  when needed. Go to an unplaced endpoint opens All Assets, reveals and selects
  it without placing it. A separate physical-location action opens Folders.
  Navigation transfers the one active selection context; it does not create a
  second hidden selection. Handle an endpoint that disappears or changes
  placement between display and action with a clear message and refresh.

## Action catalog and discoverability

Add relationship actions to the existing contextual action catalog rather
than inventing a parallel command surface. List the gesture where an image is
the source, and list endpoint navigation and unlink actions for an edge.
Describe availability and disabled reasons, including collapsed-set source
and multi-selection limits. Keep labels, count plurals, shortcuts, focus order,
and feedback accessible and localized through the existing conventions. The
catalog must not imply that an edge can be dragged to reconnect it.

## Design references

- ComfyUI uses visible typed handles for executable node workflows. Borrow
  explicit direction and connection feedback, not its permanent handles or
  port/type model.
- Obsidian Canvas edges are a useful reference for spatial links and selecting
  connections. Loom keeps its directed provenance semantics instead of
  copying a general-purpose canvas data model.
- Figma connectors offer useful feedback during a connection gesture. Borrow
  the clear source-to-target preview and target feedback, not permanent
  handles or endpoint reconnection.

## Delivery approach

1. Trace gesture and selection ownership in `frontend/src/routes/canvas.tsx`,
   especially `targetAt`, `validTarget`, and relationship drag lifecycle;
   locate Inspector, catalog, and service mutation paths before changing them.
2. Model validation as a reasoned result for individual and set targets;
   retain backend DAG enforcement and add an atomic fan-out boundary if the
   existing service cannot provide it. Specify duplicate and stale-state
   outcomes at that boundary.
3. Add transient preview, rejection, cancellation, and accessible status;
   retain React Flow's selection and viewport primitives.
4. Add edge and Inspector actions, count summaries, navigation, and consistent
   error handling. Integrate with existing undo and translation patterns.
5. Add focused service tests for atomicity, duplicate handling, cycles, and
   concurrent/stale membership; add Playwright workflows below. Run the
   relevant existing checks and record any environment limitations.

## Acceptance and E2E workflows

Use real pointer gestures and visible UI assertions in Playwright, not only
direct service calls. Assert graph and selection state after each step and
after reload where persistence matters. Reuse isolated fixture repos.

1. **Create → reject → fan-out → navigate → unlink:** Mod-drag A to B and
   verify the directional preview, resulting edge, and B's Sources/A's
   Derived. Attempt B to A and A to A; verify distinct rejection feedback
   and no graph change. Drag A to a valid collapsed set and verify the
   one-time member edges and count. Navigate from Inspector to a placed member,
   then unlink one edge from Inspector and another by selecting its Canvas
   edge and deleting it; verify both surfaces agree after reload.
2. **Set boundaries:** reject a set containing the source or any cyclic
   member without creating any edges; cover existing and mixed existing/new
   links. Change membership after a successful fan-out and prove old edges
   remain and new members gain no automatic edge. A collapsed set cannot
   start a relationship or show a connection preview.
3. **Navigation and selection:** navigate from both Sources and Derived to
   placed, collapsed-set, and unplaced endpoints. Verify centering/expansion
   or All Assets reveal as appropriate, one active selection, and no implicit
   placement. Select multiple edges and a mixed selection; verify pluralized,
   distinct counts and the exact deletion scope.
4. **Gesture safety and recovery:** normal drag moves nodes, modified drag
   uses the grabbed image despite multi-selection, and empty drop, Escape,
   and pointer cancellation leave no edge or stuck preview. Test a stale or
   failed commit and confirm visible feedback with no false success.
5. **Accessibility:** verify keyboard access and meaningful names for
   catalog and Inspector actions, non-color rejection cues, and status
   announcements. Confirm no permanent handles or reconnection affordances
   appear.

Existing self-link, cycle, set fan-out, navigation, and unlink tests remain
regressions; extend them rather than replacing their independent coverage with
only a long workflow.

## Implementation notes

- The current frontend validation is advisory. The image service and store
  remain authoritative for self-links and cycles.
- A collapsed-set preview reports its current member count and rejects the
  entire target when the grabbed source is a member or any member creates a
  cycle. Membership can change between preview and commit, so the service must
  re-read it when committing.
- This implementation pass assumes the existing React Flow and Inspector
  surfaces remain the owners of edge selection and navigation. It does not add
  permanent handles or reconnection.
- Atomic set fan-out is still a required service boundary: it must roll back
  all new links and undo records if any member fails. Do not treat the current
  loop in `LinkSourceToGroup` as atomic.

## Review verdict and next slice

**Verdict: partial; not ready to claim the fan-out contract.** The preview
checks self-links first, then follows outgoing edges from each target to the
source. This correctly distinguishes self-links from cycle-producing links
for the loaded graph. Set validation checks every loaded member, including
unplaced members. The two edited E2E expectations match the current self-link
and cycle status text; no old generic rejection expectation remains in that
spec. This is a static review, not a Playwright result.

The valid set preview counts current loaded members, not new edges. Its
“create N one-time relationships” wording is inaccurate when some or all
edges already exist, and it does not handle singular or localization. It also
has no E2E assertion for the count. Treat this count as advisory: graph and
membership may change before commit.

Backend work is required. `ImageService.LinkSourceToGroup` holds the operation
coordinator but reads members and writes links one at a time. It skips a
source member instead of rejecting the set, can leave earlier links and undo
records after a later failure, and records one undo action per inserted edge.
`GroupService` membership operations do not supply an atomic relationship
fan-out. Individual `LinkSource` calls reject cycles and ignore duplicates,
but do not provide a transaction spanning the group operation and history.

The service now validates and inserts fan-out edges in a transaction, and
records the newly inserted edges as one undo action. Undo removes those edges;
redo restores them. Pre-existing edges are not part of the operation.

**Remaining limits:** the operation-log append follows the relationship
transaction, so a log-write failure uses compensating rollback rather than one
shared database transaction. Undo/redo applies the composite edge step in
sequence and is not atomic if an out-of-band database change makes a later
edge fail. The preview count remains advisory; accurate all-existing and mixed
outcomes, localization, and focused UI assertions remain follow-up work.

### Fan-out preview count follow-up

The Canvas set preview now excludes member edges that already exist from its
create count. It reports “Already related” when no new edges are needed, while
self-link and cycle reasons retain priority. This remains advisory because
relationships or set membership can change before commit. Playwright was not
run for this change.

### Transactional fan-out build follow-up

`LinkSourceToGroup` now validates and inserts the fan-out in one transaction.
Cycle validation uses a transaction-scoped reachability helper because the
store's `reachable` method is private and reads through `Repo.DB`. This avoids
adding a store API that would bypass the fan-out transaction snapshot. The
build and service/store tests pass with this implementation.
