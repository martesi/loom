import type { UndoResult } from '../../../bindings/loom/internal/service'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { CanvasCapability } from './canvas-mode-policy'
import type { CanvasOperationContext } from './canvas-operation'
import { unwrapCanvasOutcome } from './canvas-operation'

export async function refreshBoard(owner: CanvasBoardOwner) {
  return unwrapCanvasOutcome(await owner.refresh())
}

export function reserveCanvasOperation<T>(
  owner: CanvasBoardOwner,
  action: (context: CanvasOperationContext) => Promise<T>,
  capability: CanvasCapability = 'geometry',
  board: object | null = owner.getSnapshot()
) {
  return owner.submit({ kind: 'mutation', capability, board }, action)
}

export async function replayCanvasHistory(
  owner: CanvasBoardOwner,
  result: UndoResult
) {
  if (!owner.getSnapshot()) await refreshBoard(owner)
  return unwrapCanvasOutcome(await queueCanvasHistory(owner, result))
}

export function queueCanvasHistory(
  owner: CanvasBoardOwner,
  result: UndoResult
) {
  return owner.submit(
    { kind: 'history', board: owner.getSnapshot() },
    async (context) => {
      if (result.applied) owner.stageHistory(result)
      await context.reconcile()
      return result
    }
  )
}

export function reserveCanvasRead<T>(
  owner: CanvasBoardOwner,
  action: () => Promise<T>
) {
  return owner.submit(
    { kind: 'read', capability: 'metadata', board: owner.getSnapshot() },
    async () => action()
  )
}
