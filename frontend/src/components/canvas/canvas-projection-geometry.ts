import type { Node } from '@xyflow/react'
import type {
  GeometryUpdate,
  UndoResult,
} from '../../../bindings/loom/internal/service'
import type { CanvasProjectionState } from './canvas-projection'

export interface DisplayGeometryBatch {
  expected: GeometryUpdate[]
  before: GeometryUpdate[]
  after: GeometryUpdate[]
  changed: boolean
}

/** Build the three ordered snapshots for ImageService.SetGeometryFromDisplay. */
export function prepareDisplayGeometry(
  state: CanvasProjectionState,
  before: readonly GeometryUpdate[],
  after: readonly GeometryUpdate[]
): DisplayGeometryBatch {
  if (state.mode !== 'edit') throw new Error('geometry gestures require Edit')
  return buildDisplayGeometry(state.expectedGeometry, before, after)
}

/** Build a batch from the exact stored baseline, independent of board mode. */
export function buildDisplayGeometry(
  expectedGeometry: ReadonlyMap<number, GeometryUpdate>,
  before: readonly GeometryUpdate[],
  after: readonly GeometryUpdate[]
): DisplayGeometryBatch {
  if (before.length !== after.length)
    throw new Error('geometry batch length mismatch')
  const seen = new Set<number>()
  const expected = before.map((item, index) => {
    if (seen.has(item.imageId) || after[index].imageId !== item.imageId)
      throw new Error(`duplicate or mismatched geometry: ${item.imageId}`)
    seen.add(item.imageId)
    const stored = expectedGeometry.get(item.imageId)
    if (!stored) throw new Error(`missing expected geometry: ${item.imageId}`)
    return { ...stored }
  })
  return {
    expected,
    before: before.map((item) => ({ ...item })),
    after: after.map((item) => ({ ...item })),
    changed: before.some((item, index) => !equalGeometry(item, after[index])),
  }
}

/** Call only after a successful service call. A no-op does not write any row. */
export function acceptDisplayGeometry(
  state: CanvasProjectionState,
  batch: DisplayGeometryBatch
): CanvasProjectionState {
  if (!batch.changed) return state
  return {
    ...state,
    expectedGeometry: replaceGeometry(state.expectedGeometry, batch.after),
  }
}

/**
 * Apply every geometry row from a successful undo/redo, including unchanged and
 * null pairs. The caller resolves nulls and collapsed sets against fresh model
 * data; a null position cannot be represented by a React Flow node alone.
 * Semantic history has no geometry and leaves the display untouched.
 */
export function applyProjectionUndo(
  state: CanvasProjectionState,
  result: UndoResult,
  resolve: (
    nodes: readonly Node[],
    geometry: readonly GeometryUpdate[]
  ) => Node[]
): CanvasProjectionState {
  if (!result.applied || !result.geometry?.length) return state
  const geometry = result.geometry.map((item) => ({ ...item }))
  return {
    ...state,
    expectedGeometry: replaceGeometry(state.expectedGeometry, geometry),
    editNodes:
      state.mode === 'edit'
        ? resolve(state.editNodes, geometry)
        : state.editNodes,
  }
}

function replaceGeometry(
  previous: ReadonlyMap<number, GeometryUpdate>,
  updates: readonly GeometryUpdate[]
) {
  const next = new Map(previous)
  for (const item of updates) next.set(item.imageId, { ...item })
  return next
}

function equalGeometry(a: GeometryUpdate, b: GeometryUpdate): boolean {
  return (
    a.imageId === b.imageId &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h
  )
}
