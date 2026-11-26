import type { CanvasBoardOwner } from './canvas-board-owner'
import type { CanvasInternalMode } from './canvas-mode-policy'

export type CanvasViewportOrigin =
  | 'restore'
  | 'initial-fit'
  | 'anchor'
  | 'user'
  | 'command'
  | 'external'
  | 'stale'

export type CanvasViewportPhase = 'move' | 'end'

export interface CanvasViewportIntentToken {
  id: number
  gestureId: number
  owner: CanvasBoardOwner
  repoPath: string
  mode: CanvasInternalMode
  modeRequestRevision: number
  activationEpoch: number
}

export interface CanvasViewportEventOrigin {
  origin: CanvasViewportOrigin
  token?: CanvasViewportIntentToken
}
