import type {
  CanvasBoardOwner,
  CanvasOperationIntent,
} from './canvas-board-owner'

export interface CanvasSelectionIntentState {
  key: string
  revision: number
}

export interface CanvasSelectionIntentRef {
  current: CanvasSelectionIntentState
}

export interface CapturedCanvasSelectionIntent {
  revision: number
  operation: CanvasOperationIntent
}

export function advanceCanvasSelectionIntent(
  reference: CanvasSelectionIntentRef,
  key: string
) {
  if (reference.current.key === key) return reference.current
  reference.current = {
    key,
    revision: reference.current.revision + 1,
  }
  return reference.current
}

export function captureCanvasSelectionIntent(
  owner: CanvasBoardOwner,
  reference: CanvasSelectionIntentRef
): CapturedCanvasSelectionIntent {
  const revision = reference.current.revision
  return {
    revision,
    operation: owner.captureIntent('relationship', revision),
  }
}

export function isCanvasSelectionIntentCurrent(
  reference: CanvasSelectionIntentRef,
  revision: number
) {
  return reference.current.revision === revision
}
