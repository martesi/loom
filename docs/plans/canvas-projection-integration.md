# Canvas projection integration boundary

This is a follow-up design, not an available mode switch. The workspace still
uses the placement-based board. Do not expose View or Edit until every mutation
entry point is gated and the geometry and history paths below are connected.

The intended board interface is a mode (`view` or `edit`), a transition
operation, and the current mode's nodes, edges, and viewport. `view` derives
positions from relationships and hides unpaired images. `edit` starts with the
View positions and stages unpaired images. Transitions do not write geometry or
add history. View and Edit retain separate viewports. Existing legacy Sets need
an explicit migration or mapping before this interface can replace the board.

`canvasProjectionGraph` maps `LoadCanvas` images and relationships to the
projection inputs, using relationship `pairingOrder` rather than relationship
ID as the ordering key. It includes unplaced, non-trashed images and excludes
edges with unavailable endpoints. The current board uses its image-node mapping
only; it does not yet use the chronological projection.

The integrating owner must:

1. Capture exact `GetGeometry` rows for the same graph revision before creating
   or reconciling a projection. Ignore stale asynchronous results and cancel
   gestures when graph or display data changes.
2. Feed React Flow's current Edit nodes into `setEditNodes` before reconciling,
   so metadata and semantic refreshes retain positions and sizes. Reconcile
   edges and the immutable pairing-order map with the latest graph.
3. Capture complete displayed rectangles at gesture start and end. Serialize
   gestures with undo and redo, call `prepareDisplayGeometry`, then
   `SetGeometryFromDisplay`, and call `acceptDisplayGeometry` only on success.
   On a stale or failed write, cancel the gesture, report the error, and reload.
4. Route `UndoResult.geometry` through `applyProjectionUndo` before reloading.
   Resolve null geometry pairs using the fresh model, not lossy DTO coordinates.
   Semantic replay must not move Edit nodes; View must remain derived.
5. Wire drag, resize, arrange, alignment and replay through that same owner;
   gate all remaining mutation surfaces in View. Use the backend operation log
   as the only undo history. Do not toggle the new mode until this is complete.
