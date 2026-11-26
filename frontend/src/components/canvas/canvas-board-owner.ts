import { useEffect, useRef } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
  type LayoutSnapshot,
  type UndoResult,
} from '../../../bindings/loom/internal/service'
import type { CanvasBoardExecutor } from './canvas-board-executor'
import type { DragGesture, ResizeGesture } from './canvas-board-gestures'
import {
  allowsCanvasCapability,
  type CanvasCapability,
  type CanvasInternalMode,
} from './canvas-mode-policy'
import {
  type CanvasOperationContext,
  type CanvasOperationOutcome,
  type CanvasOperationRuntime,
  type CanvasUserOperationRequest,
  canvasRepositoryIssue,
  isCanvasOperationPending,
  isCanvasRepositoryDirty,
  isCanvasRepositoryUncertain,
  submitCanvasOperation,
} from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'
import { buildDisplayGeometry } from './canvas-projection-geometry'
import type { ResizeDirection } from './canvas-resize-geometry'
import { joinCanvasSnapshot } from './canvas-snapshot'

export interface AcceptedCanvasBoard {
  snapshot: LayoutSnapshot
  data: CanvasData
}

export interface CanvasBoardOwner extends CanvasBoardExecutor {
  getMode(): CanvasInternalMode
  getModeRevision(): number
  getLifetimeRevision(): number
  getIntentRevision(): number
  getRepositoryIssue(): Error | null
  advanceIntent(): number
  isLayoutPending(): boolean
  submit<T>(
    request: CanvasUserOperationRequest,
    action: (context: CanvasOperationContext) => Promise<T>
  ): Promise<CanvasOperationOutcome<T>>
  beginModeTransition(target?: CanvasInternalMode): number
  cancelModeTransition(revision: number): void
  setMode(mode: CanvasInternalMode): void
  allows(capability: CanvasCapability): boolean
  refresh(): Promise<CanvasOperationOutcome<AcceptedCanvasBoard | null>>
  stageHistory(result: UndoResult): void
  takeHistory(): UndoResult[]
  getSnapshot(): AcceptedCanvasBoard | null
  beginResize(
    board: AcceptedCanvasBoard | null,
    before: GeometryUpdate,
    direction: ResizeDirection,
    pointerId: number,
    onPreview: (geometry: GeometryUpdate) => void,
    onCancel: () => void
  ): number | null
  updateResize(token: number, pointerId: number, after: GeometryUpdate): boolean
  endResize(
    token: number,
    pointerId: number,
    after: GeometryUpdate
  ): Promise<CanvasOperationOutcome<void>>
  cancelResize(token: number, pointerId: number): void
  beginDrag(
    board: AcceptedCanvasBoard | null,
    before: GeometryUpdate[],
    onCancel?: () => void
  ): DragGesture | null
  endDrag(
    gesture: DragGesture,
    after: GeometryUpdate[]
  ): Promise<CanvasOperationOutcome<void>>
  /** Called inside execute, alongside mode transitions and other mutations. */
  commitDisplayedLayout(
    context: CanvasOperationContext,
    board: AcceptedCanvasBoard,
    before: GeometryUpdate[],
    after: GeometryUpdate[],
    accept: () => void
  ): Promise<void>
  cancelGesture(): void
  isGestureActive(gesture: DragGesture): boolean
  subscribe(listener: () => void): () => void
  dispose(): void
  activate(): Promise<CanvasOperationOutcome<void>>
}

export function useCanvasBoardOwner(repoPath: string): CanvasBoardOwner {
  const owner = useRef<{ repoPath: string; executor: CanvasBoardOwner }>(null)
  if (!owner.current || owner.current.repoPath !== repoPath) {
    owner.current = {
      repoPath,
      executor: createCanvasBoardOwner(repoPath, true),
    }
  }
  const current = owner.current.executor
  useEffect(() => {
    void current.activate().then((outcome) => {
      if (outcome.status === 'failed')
        console.error('canvas startup failed', outcome.error)
    })
    return () => current.dispose()
  }, [current])
  return current
}

export function createCanvasBoardOwner(
  repoPath: string,
  coordinateRepository = false
): CanvasBoardOwner {
  let requestedMode: CanvasInternalMode | null = null
  const operationIdentity = coordinateRepository
    ? repoPath
    : `${repoPath}:${crypto.randomUUID()}`
  const operationToken = {}
  let generation = 0
  let active = true
  let mode: CanvasInternalMode = 'legacy'
  let modeRevision = 0
  let lifetimeRevision = 0
  let intentRevision = 0
  let nextGestureToken = 1
  let accepted: AcceptedCanvasBoard | null = null
  let acceptedGeneration = -1
  let gesture: ResizeGesture | DragGesture | null = null
  let pendingHistory: UndoResult[] = []
  let readyHistory: UndoResult[] = []
  const listeners = new Set<() => void>()
  async function loadBoard(context: CanvasOperationContext): Promise<void> {
    if (!active) return
    const request = ++generation
    owner.cancelGesture()
    const isCurrent = () => active && request === generation
    const observation = coordinateRepository
      ? await context.prepare(() => ImageService.ObserveCanvas(repoPath))
      : await context.prepare(async () => {
          const [canvas, snapshot] = await Promise.all([
            ImageService.LoadCanvas(repoPath),
            ImageService.GetLayoutSnapshot(repoPath),
          ])
          return { canvas, snapshot }
        })
    if (!isCurrent()) return
    if (!observation?.canvas || !observation.snapshot)
      throw new Error('Canvas observation is unavailable')
    const { canvas: metadata, snapshot } = observation
    const data = joinCanvasSnapshot(metadata, snapshot)
    // An intermediate publication may not have reached React before this one.
    // Keep its replay membership, but use this snapshot's authoritative rows.
    const geometry = new Map(
      (snapshot.images ?? []).map((image) => [image.id, image.geometry])
    )
    readyHistory = [...readyHistory, ...pendingHistory].map((result) => ({
      ...result,
      geometry: result.geometry?.flatMap((row) => {
        const current = geometry.get(row.imageId)
        return current ? [current] : []
      }),
    }))
    pendingHistory = []
    accepted = { snapshot, data }
    acceptedGeneration = generation
    for (const listener of listeners) listener()
  }
  let owner: CanvasBoardOwner
  const runtime: CanvasOperationRuntime = {
    token: operationToken,
    isCurrent: (revision) => active && revision === lifetimeRevision,
    getLifetime: () => lifetimeRevision,
    getIntentRevision: () => intentRevision,
    getMode: () => mode,
    getRequestedMode: () => requestedMode,
    setMode: (next) => {
      if (mode !== next) modeRevision++
      mode = next
      requestedMode = null
    },
    getSnapshot: () => accepted,
    recover: loadBoard,
  }
  let startup: Promise<CanvasOperationOutcome<void>> | null = null
  let startupSettled = false
  function queueStartup() {
    if (!startup) {
      const queued = submitCanvasOperation(
        operationIdentity,
        runtime,
        { kind: 'startup' },
        (context) => {
          if (!coordinateRepository) return context.reconcile()
          if (isCanvasRepositoryUncertain(operationIdentity))
            return context.reconcile()
          return canvasEffects
            .discoverCanvas(context, repoPath)
            .then(() => context.reconcile())
        }
      )
      startup = queued
      void queued.then(() => {
        if (startup === queued) startupSettled = true
      })
    }
    return startup
  }
  function submit<T>(
    request: CanvasUserOperationRequest,
    action: (context: CanvasOperationContext) => Promise<T>
  ) {
    if (request.kind === 'mutation' || request.kind === 'history')
      owner.cancelGesture()
    queueStartup()
    const result = submitCanvasOperation(
      operationIdentity,
      runtime,
      request,
      action
    )
    return result
  }
  owner = {
    getMode: () => mode,
    getModeRevision: () => modeRevision,
    getLifetimeRevision: () => lifetimeRevision,
    getIntentRevision: () => intentRevision,
    getRepositoryIssue: () => canvasRepositoryIssue(operationIdentity),
    advanceIntent() {
      intentRevision++
      return intentRevision
    },
    isLayoutPending: () => isCanvasOperationPending(operationIdentity),
    submit,
    beginModeTransition: (target) => {
      modeRevision++
      intentRevision++
      requestedMode = target ?? null
      owner.cancelGesture()
      return modeRevision
    },
    cancelModeTransition(revision) {
      if (modeRevision === revision) requestedMode = null
    },
    setMode(next) {
      if (coordinateRepository)
        throw new Error(
          'Use a queued Canvas mode transition for active owners.'
        )
      owner.cancelGesture()
      if (mode !== next) modeRevision++
      intentRevision++
      mode = next
      requestedMode = null
    },
    allows: (capability) =>
      !isCanvasRepositoryDirty(operationIdentity) &&
      !isCanvasOperationPending(operationIdentity) &&
      allowsCanvasCapability(requestedMode ?? mode, capability),
    refresh() {
      const wasStarting = !startup || !startupSettled
      if (wasStarting)
        return queueStartup().then((outcome) =>
          outcome.status === 'success'
            ? { status: 'success', value: accepted }
            : outcome
        )
      owner.cancelGesture()
      return submit({ kind: 'recovery' }, (context) =>
        context.reconcile().then(() => accepted)
      )
    },
    takeHistory() {
      const ready = readyHistory
      readyHistory = []
      return ready
    },
    isActive: () => active,
    getSnapshot: () => accepted,
    stageHistory(result) {
      if (result.applied) pendingHistory.push(result)
    },
    beginResize(board, before, direction, pointerId, onPreview, onCancel) {
      if (
        gesture ||
        !owner.allows('geometry') ||
        !active ||
        !board ||
        board !== accepted ||
        acceptedGeneration !== generation
      ) {
        return null
      }
      const stored = board.snapshot.images?.find(
        (item) => item.id === before.imageId
      )?.geometry
      if (!stored) return null
      const current: ResizeGesture = {
        kind: 'resize',
        token: nextGestureToken++,
        pointerId,
        cancelled: false,
        generation,
        modeRevision,
        lifetimeRevision,
        revision: board.snapshot.revision,
        expected: { ...stored },
        before: { ...before },
        direction,
        onPreview,
        onCancel,
      }
      gesture = current
      return current.token
    },
    updateResize(token, pointerId, after) {
      const current = gesture
      if (
        current?.kind !== 'resize' ||
        current.token !== token ||
        current.pointerId !== pointerId
      ) {
        return false
      }
      if (
        current.cancelled ||
        !active ||
        current.lifetimeRevision !== lifetimeRevision ||
        current.modeRevision !== modeRevision ||
        current.generation !== generation
      ) {
        owner.cancelResize(token, pointerId)
        return false
      }
      current.onPreview(after)
      return true
    },
    endResize(token, pointerId, after) {
      const current = gesture
      if (
        current?.kind !== 'resize' ||
        current.token !== token ||
        current.pointerId !== pointerId
      )
        return Promise.resolve({
          status: 'cancelled',
          reason: 'The resize gesture is no longer active.',
        })
      if (
        current.cancelled ||
        !active ||
        current.lifetimeRevision !== lifetimeRevision ||
        current.modeRevision !== modeRevision ||
        current.generation !== generation
      ) {
        owner.cancelResize(token, pointerId)
        return Promise.resolve({
          status: 'cancelled',
          reason: 'The resize gesture is stale.',
        })
      }
      gesture = null
      current.onPreview(after)
      const batch = buildDisplayGeometry(
        new Map([[current.expected.imageId, current.expected]]),
        [current.before],
        [after]
      )
      if (!batch.changed)
        return Promise.resolve({ status: 'success', value: undefined })
      return owner.submit(
        { kind: 'mutation', capability: 'geometry', board: accepted },
        (context) =>
          canvasEffects.setDisplayGeometry(
            context,
            repoPath,
            current.revision,
            batch.expected,
            batch.before,
            batch.after
          )
      )
    },
    cancelResize(token, pointerId) {
      const current = gesture
      if (
        current?.kind !== 'resize' ||
        current.token !== token ||
        current.pointerId !== pointerId
      )
        return
      gesture = null
      current.cancelled = true
      current.onCancel()
    },
    beginDrag(board, before, onCancel) {
      if (
        !owner.allows('geometry') ||
        !active ||
        !board ||
        board !== accepted ||
        acceptedGeneration !== generation ||
        !before.length
      )
        return null
      const stored = new Map(
        (board.snapshot.images ?? []).map((item) => [item.id, item.geometry])
      )
      if (
        new Set(before.map((item) => item.imageId)).size !== before.length ||
        before.some((item) => !stored.has(item.imageId))
      )
        return null
      const expected: GeometryUpdate[] = []
      for (const item of before) {
        const geometry = stored.get(item.imageId)
        if (!geometry) return null
        expected.push({ ...geometry })
      }
      const current: DragGesture = {
        kind: 'drag',
        cancelled: false,
        generation,
        modeRevision,
        lifetimeRevision,
        revision: board.snapshot.revision,
        expected,
        before: before.map((item) => ({ ...item })),
        onCancel,
      }
      gesture = current
      return current
    },
    endDrag(current, after) {
      if (gesture !== current)
        return Promise.resolve({
          status: 'cancelled',
          reason: 'The drag gesture is no longer active.',
        })
      gesture = null
      const batch = buildDisplayGeometry(
        new Map(current.expected.map((item) => [item.imageId, item])),
        current.before,
        after
      )
      if (
        current.cancelled ||
        !active ||
        current.generation !== generation ||
        current.modeRevision !== modeRevision ||
        current.lifetimeRevision !== lifetimeRevision ||
        !owner.allows('geometry')
      ) {
        current.onCancel?.()
        return Promise.resolve({
          status: 'cancelled',
          reason: 'The drag gesture is stale.',
        })
      }
      if (!batch.changed)
        return Promise.resolve({ status: 'success', value: undefined })
      return owner.submit(
        { kind: 'mutation', capability: 'geometry', board: accepted },
        (context) =>
          canvasEffects.setDisplayGeometry(
            context,
            repoPath,
            current.revision,
            batch.expected,
            batch.before,
            batch.after
          )
      )
    },
    async commitDisplayedLayout(context, board, before, after, accept) {
      if (mode !== 'edit' || !active) return
      if (board !== accepted || acceptedGeneration !== generation)
        throw new Error('Canvas changed during layout. Try again.')
      const batch = buildDisplayGeometry(
        new Map(
          (board.snapshot.images ?? []).map((item) => [item.id, item.geometry])
        ),
        before,
        after
      )
      if (!batch.changed) return
      const requestMode = modeRevision
      await canvasEffects.setDisplayGeometry(
        context,
        repoPath,
        board.snapshot.revision,
        batch.expected,
        batch.before,
        batch.after
      )
      context.assertCurrent()
      if (mode !== 'edit' || modeRevision !== requestMode || accepted !== board)
        throw new Error('Canvas changed during layout. Try again.')
      accept()
    },
    cancelGesture() {
      const current = gesture
      gesture = null
      if (current) {
        current.cancelled = true
        current.onCancel?.()
      }
    },
    isGestureActive: (current) =>
      active &&
      gesture === current &&
      !current.cancelled &&
      current.generation === generation,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      active = false
      lifetimeRevision++
      intentRevision++
      startup = null
      startupSettled = false
      generation++
      accepted = null
      acceptedGeneration = -1
      pendingHistory = []
      readyHistory = []
      owner.cancelGesture()
      listeners.clear()
    },
    activate() {
      active = true
      return queueStartup()
    },
  }
  return owner
}
