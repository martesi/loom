import type {
  CanvasOperationContext,
  CanvasOperationOutcome,
  CanvasUserOperationRequest,
} from './canvas-operation'

export interface CanvasSubmitOptions {
  onReserved?: () => void
}

export interface CanvasBoardExecutor {
  submit<T>(
    request: CanvasUserOperationRequest,
    action: (context: CanvasOperationContext) => Promise<T>,
    options?: CanvasSubmitOptions
  ): Promise<CanvasOperationOutcome<T>>
  getSnapshot(): object | null
  stageHistory(result: UndoResult): void
  cancelGesture?(): void
  isActive?(): boolean
  getLifetimeRevision?(): number
}

import type { UndoResult } from '../../../bindings/loom/internal/service'
