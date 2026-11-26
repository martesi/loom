import type { Viewport } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
  type LayoutSnapshot,
  type UndoResult,
} from '../../../bindings/loom/internal/service'
import {
  allowsCanvasCapability,
  type CanvasCapability,
  type CanvasInternalMode,
} from './canvas-mode-policy'
import { buildDisplayGeometry } from './canvas-projection-geometry'

export interface ResizeGesture {
  cancelled: boolean
  generation: number
  revision: string
  expected: GeometryUpdate
  before: GeometryUpdate
}

export interface DragGesture {
  cancelled: boolean
  generation: number
  revision: string
  expected: GeometryUpdate[]
  before: GeometryUpdate[]
  onCancel?: () => void
}

export interface CanvasBoardExecutor {
  execute<T>(action: () => Promise<T>): Promise<T>
  cancelGesture?(): void
  isActive?(): boolean
}

export interface AcceptedCanvasBoard {
  snapshot: LayoutSnapshot
  data: CanvasData
}

export type CanvasIntentPhase =
  | 'queued'
  | 'dispatched'
  | 'settled'
  | 'unknown'
  | 'reconciled'
  | 'cancelled'

export interface CanvasOperationIntent {
  readonly owner: CanvasBoardOwner
  readonly repoPath: string
  readonly activationEpoch: number
  readonly modeRequestRevision: number
  readonly mode: CanvasInternalMode
  readonly capability: CanvasCapability
  readonly userIntentRevision: number
  phase: CanvasIntentPhase
}

export interface CanvasIntentResult<T> {
  dispatched: boolean
  value?: T
}

export interface CanvasRepositoryQueue {
  tail: Promise<void>
  needsReconciliation: boolean
  fence: {
    error: unknown
    uncertain: boolean
    effect: 'unknown' | 'rejected' | 'succeeded-dirty'
  } | null
  owners: Set<CanvasBoardOwner>
  pendingWrites: number
}

const repositoryLanes = new Map<string, CanvasRepositoryQueue>()

export function createCanvasRepositoryQueue(): CanvasRepositoryQueue {
  return {
    tail: Promise.resolve(),
    needsReconciliation: false,
    fence: null,
    owners: new Set(),
    pendingWrites: 0,
  }
}

function repositoryLane(repoPath: string) {
  let lane = repositoryLanes.get(repoPath)
  if (!lane) {
    lane = createCanvasRepositoryQueue()
    repositoryLanes.set(repoPath, lane)
  }
  return lane
}

function enqueueRepository<T>(
  lane: CanvasRepositoryQueue,
  action: () => Promise<T>
) {
  const result = lane.tail.then(action)
  lane.tail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export class CanvasWriteRejectedError extends Error {
  readonly effectNotApplied = true
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CanvasWriteRejectedError'
    this.cause = cause
  }
}

function uncertainTransport(error: unknown) {
  return !(
    error instanceof CanvasWriteRejectedError && error.effectNotApplied === true
  )
}

export interface CanvasBoardOwner extends CanvasBoardExecutor {
  readonly repoPath: string
  getRepositoryViewport(): Viewport | null
  setRepositoryViewport(viewport: Viewport | null): void
  getMode(): CanvasInternalMode
  getModeRevision(): number
  getModeRequestRevision(): number
  getActivationEpoch(): number
  requestModeTransition(mode: CanvasInternalMode): number
  setMode(mode: CanvasInternalMode): void
  allows(capability: CanvasCapability): boolean
  captureIntent(
    capability: CanvasCapability,
    userIntentRevision: number
  ): CanvasOperationIntent
  isIntentCurrent(
    intent: CanvasOperationIntent,
    isUserIntentCurrent: () => boolean
  ): boolean
  executeIntent<T>(
    intent: CanvasOperationIntent,
    isUserIntentCurrent: () => boolean,
    action: () => Promise<T>,
    write: boolean
  ): Promise<CanvasIntentResult<T>>
  /** Dispatch a write from inside the repository queue and reconcile afterward. */
  write<T>(action: () => Promise<T>): Promise<T>
  getMutationFence(): CanvasRepositoryQueue['fence']
  retryReconciliation(): Promise<boolean>
  refresh(): Promise<AcceptedCanvasBoard | null>
  applyHistory(result: UndoResult): Promise<void>
  takeHistory(): UndoResult[]
  getSnapshot(): AcceptedCanvasBoard | null
  beginResize(
    board: AcceptedCanvasBoard | null,
    before: GeometryUpdate
  ): ResizeGesture | null
  endResize(gesture: ResizeGesture, after: GeometryUpdate): Promise<void>
  cancelResize(gesture: ResizeGesture): void
  beginDrag(
    board: AcceptedCanvasBoard | null,
    before: GeometryUpdate[],
    onCancel?: () => void
  ): DragGesture | null
  endDrag(gesture: DragGesture, after: GeometryUpdate[]): Promise<void>
  /** Called inside execute, alongside mode transitions and other mutations. */
  commitDisplayedLayout(
    board: AcceptedCanvasBoard,
    before: GeometryUpdate[],
    after: GeometryUpdate[],
    accept: () => void
  ): Promise<void>
  cancelGesture(): void
  isGestureActive(gesture: DragGesture): boolean
  subscribe(listener: () => void): () => void
  dispose(): void
  activate(): void
}

export function useCanvasBoardOwner(repoPath: string): CanvasBoardOwner {
  const owner = useRef<{
    repoPath: string
    executor: CanvasBoardOwner
    queue: CanvasRepositoryQueue
  }>(null)
  if (!owner.current || owner.current.repoPath !== repoPath) {
    const queue = repositoryLane(repoPath)
    owner.current = {
      repoPath,
      queue,
      executor: createCanvasBoardOwner(repoPath, queue),
    }
  }
  const current = owner.current.executor
  useEffect(() => {
    current.activate()
    return () => current.dispose()
  }, [current])
  return current
}

export function createCanvasBoardOwner(
  repoPath: string,
  lane = createCanvasRepositoryQueue()
): CanvasBoardOwner {
  let generation = 0
  let active = true
  let activationEpoch = 1
  let mode: CanvasInternalMode = 'legacy'
  let modeRevision = 0
  let modeRequestRevision = 0
  let requestedMode: CanvasInternalMode = 'legacy'
  let repositoryViewport: Viewport | null = null
  let accepted: AcceptedCanvasBoard | null = null
  let acceptedGeneration = -1
  let gesture: ResizeGesture | DragGesture | null = null
  let pendingHistory: UndoResult[] = []
  let readyHistory: UndoResult[] = []
  let latestRefresh: Promise<AcceptedCanvasBoard | null> | null = null
  let signalRefresh = () => {}
  let refreshChanged = new Promise<void>((resolve) => {
    signalRefresh = resolve
  })
  let lifetime = new AbortController()
  const listeners = new Set<() => void>()
  async function reconcileWithActiveOwner() {
    const replacement = [...lane.owners].find(
      (candidate) => candidate.isActive?.() === true
    )
    if (!replacement) return false
    const reconciled = await replacement.refresh()
    if (reconciled && !lane.fence?.uncertain) {
      lane.needsReconciliation = false
      lane.fence = null
    }
    return reconciled !== null
  }
  async function writeAndReconcile<T>(
    action: () => Promise<T>,
    alreadyPending = false
  ) {
    if (!alreadyPending) lane.pendingWrites++
    lane.needsReconciliation = true
    let effectSucceeded = false
    try {
      const value = await action()
      effectSucceeded = true
      let reconciled: AcceptedCanvasBoard | boolean | null
      if (active) {
        reconciled = await owner.refresh()
        if (!reconciled)
          throw new Error('Canvas write settled without an accepted snapshot.')
      } else {
        reconciled = await reconcileWithActiveOwner()
      }
      if (reconciled && !lane.fence?.uncertain) {
        lane.needsReconciliation = false
        lane.fence = null
      }
      return value
    } catch (error) {
      lane.needsReconciliation = true
      const uncertain = effectSucceeded ? false : uncertainTransport(error)
      lane.fence = {
        error,
        uncertain,
        effect: effectSucceeded
          ? 'succeeded-dirty'
          : uncertain
            ? 'unknown'
            : 'rejected',
      }
      console.error('canvas write settlement failed', {
        repoPath,
        effect: lane.fence.effect,
        error,
      })
      try {
        const reconciled = active
          ? await owner.refresh()
          : await reconcileWithActiveOwner()
        if (reconciled && !lane.fence.uncertain) {
          lane.needsReconciliation = false
          lane.fence = null
        }
      } catch {
        // Keep the fence until an explicit reconciliation retry succeeds.
      }
      throw error
    } finally {
      if (!alreadyPending) lane.pendingWrites--
    }
  }
  function refresh() {
    const request = loadBoard().then((board) => {
      if (board && lane.needsReconciliation && !lane.fence?.uncertain) {
        lane.needsReconciliation = false
        lane.fence = null
      }
      return board
    })
    latestRefresh = request
    const notify = signalRefresh
    refreshChanged = new Promise<void>((resolve) => {
      signalRefresh = resolve
    })
    notify()
    return request
  }
  async function loadBoard() {
    if (!active) return null
    const request = ++generation
    owner.cancelGesture()
    const isCurrent = () => active && request === generation
    const metadata = await ImageService.LoadCanvas(repoPath)
    if (!isCurrent()) return null
    if (!metadata) throw new Error('Canvas metadata is unavailable')
    const snapshot = await ImageService.GetLayoutSnapshot(repoPath)
    if (!isCurrent()) return null
    if (!snapshot) throw new Error('Canvas layout snapshot is unavailable')
    const data = joinSnapshot(metadata, snapshot)
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
    return accepted
  }
  const owner: CanvasBoardOwner = {
    repoPath,
    getRepositoryViewport: () => repositoryViewport,
    setRepositoryViewport: (viewport) => {
      repositoryViewport = viewport
    },
    getMode: () => mode,
    getModeRevision: () => modeRevision,
    getModeRequestRevision: () => modeRequestRevision,
    getActivationEpoch: () => activationEpoch,
    requestModeTransition(next) {
      modeRequestRevision++
      modeRevision++
      requestedMode = next
      owner.cancelGesture()
      return modeRequestRevision
    },
    setMode(next) {
      owner.cancelGesture()
      if (mode !== next && requestedMode !== next) {
        modeRevision++
        modeRequestRevision++
      }
      mode = next
      requestedMode = next
    },
    allows: (capability) =>
      allowsCanvasCapability(mode, capability) &&
      (requestedMode !== 'view' ||
        (capability !== 'relationship' &&
          capability !== 'geometry' &&
          capability !== 'canvas-drop')),
    captureIntent(capability, userIntentRevision) {
      return {
        owner,
        repoPath,
        activationEpoch,
        modeRequestRevision,
        mode: requestedMode,
        capability,
        userIntentRevision,
        phase: 'queued',
      }
    },
    isIntentCurrent(intent, isUserIntentCurrent) {
      return (
        active &&
        intent.owner === owner &&
        intent.repoPath === repoPath &&
        intent.activationEpoch === activationEpoch &&
        intent.modeRequestRevision === modeRequestRevision &&
        intent.mode === requestedMode &&
        isUserIntentCurrent() &&
        owner.allows(intent.capability)
      )
    },
    async executeIntent(intent, isUserIntentCurrent, action, write) {
      return enqueueRepository(lane, async () => {
        if (lane.needsReconciliation && active) {
          if (lane.fence?.uncertain)
            throw new Error(
              'Canvas write outcome is unknown. Editing remains blocked.'
            )
          const reconciled = await owner.refresh()
          if (!reconciled)
            throw new Error('Canvas reconciliation did not return a snapshot.')
          lane.needsReconciliation = false
          lane.fence = null
        }
        if (!owner.isIntentCurrent(intent, isUserIntentCurrent)) {
          intent.phase = 'cancelled'
          return { dispatched: false }
        }
        intent.phase = 'dispatched'
        if (!write) {
          const value = await action()
          intent.phase = 'settled'
          return { dispatched: true, value }
        }
        lane.pendingWrites++
        let pendingWrite = true
        let effectSucceeded = false
        try {
          const value = await action()
          effectSucceeded = true
          intent.phase = 'settled'
          await writeAndReconcile(async () => value, true)
          lane.pendingWrites--
          pendingWrite = false
          if (!lane.needsReconciliation) intent.phase = 'reconciled'
          return { dispatched: true, value }
        } catch (error) {
          if (pendingWrite) lane.pendingWrites--
          lane.needsReconciliation = true
          const uncertain = effectSucceeded ? false : uncertainTransport(error)
          intent.phase = uncertain ? 'unknown' : 'settled'
          lane.fence = {
            error,
            uncertain,
            effect: effectSucceeded
              ? 'succeeded-dirty'
              : uncertain
                ? 'unknown'
                : 'rejected',
          }
          console.error('canvas write settlement failed', {
            repoPath,
            effect: lane.fence.effect,
            error,
          })
          if (active) {
            const rejectedFence = lane.fence
            try {
              const reconciled = await owner.refresh()
              if (
                reconciled &&
                lane.fence === null &&
                !lane.needsReconciliation
              ) {
                if (!rejectedFence?.uncertain) intent.phase = 'reconciled'
              } else if (
                reconciled &&
                lane.fence === rejectedFence &&
                rejectedFence &&
                !rejectedFence.uncertain
              ) {
                intent.phase = 'reconciled'
                if (lane.fence === rejectedFence) {
                  lane.needsReconciliation = false
                  lane.fence = null
                }
              }
            } catch {
              // Keep the fence until an explicit reconciliation retry succeeds.
            }
          } else {
            await reconcileWithActiveOwner().catch(() => false)
          }
          throw error
        }
      })
    },
    getMutationFence: () => lane.fence,
    write: writeAndReconcile,
    async retryReconciliation() {
      return enqueueRepository(lane, async () => {
        if (!active) return false
        if (lane.fence?.uncertain) return false
        const first = await owner.refresh()
        if (!first) return false
        lane.needsReconciliation = false
        lane.fence = null
        return true
      })
    },
    execute<T>(action: () => Promise<T>): Promise<T> {
      // Queue outer operations only: awaiting a nested execute would deadlock.
      return enqueueRepository(lane, async () => {
        if (lane.needsReconciliation && active) {
          if (lane.fence?.uncertain)
            throw new Error(
              'Canvas write outcome is unknown. Editing remains blocked.'
            )
          const reconciled = await owner.refresh()
          if (!reconciled)
            throw new Error('Canvas reconciliation did not return a snapshot.')
          lane.needsReconciliation = false
          lane.fence = null
        }
        return action()
      })
    },
    refresh,
    async applyHistory(result) {
      if (!active || !result.applied) return
      pendingHistory.push(result)
      const signal = lifetime.signal
      // Disposal can stop reconciliation before it observes this request.
      void refresh().catch(() => {})
      const reconcile = async () => {
        while (active && !signal.aborted && pendingHistory.includes(result)) {
          const request = latestRefresh
          if (!request) return
          let notifyDisposal = () => {}
          const disposed = new Promise<void>((resolve) => {
            notifyDisposal = resolve
            signal.addEventListener('abort', notifyDisposal, { once: true })
          })
          const outcome = await Promise.race([
            request.then(
              () => ({ kind: 'settled' as const }),
              (error: unknown) => ({ kind: 'failed' as const, error })
            ),
            refreshChanged.then(() => ({ kind: 'superseded' as const })),
            disposed.then(() => ({ kind: 'disposed' as const })),
          ]).finally(() => signal.removeEventListener('abort', notifyDisposal))
          if (outcome.kind === 'disposed' || signal.aborted) return
          if (!active || !pendingHistory.includes(result)) return
          if (request !== latestRefresh) continue
          if (outcome.kind === 'failed') throw outcome.error
          if (outcome.kind === 'settled') return
        }
      }
      await reconcile().catch((error: unknown) => {
        pendingHistory = pendingHistory.filter((item) => item !== result)
        throw error
      })
    },
    takeHistory() {
      const ready = readyHistory
      readyHistory = []
      return ready
    },
    isActive: () => active,
    getSnapshot: () => accepted,
    beginResize(board, before) {
      if (
        !owner.allows('geometry') ||
        !active ||
        !board ||
        board !== accepted ||
        acceptedGeneration !== generation
      )
        return null
      const stored = board.snapshot.images?.find(
        (item) => item.id === before.imageId
      )?.geometry
      if (!stored) return null
      owner.cancelGesture()
      gesture = {
        cancelled: false,
        generation,
        revision: board.snapshot.revision,
        expected: { ...stored },
        before: { ...before },
      }
      return gesture
    },
    endResize(current, after) {
      if (gesture !== current) return Promise.resolve()
      gesture = null
      const batch = buildDisplayGeometry(
        new Map([[current.expected.imageId, current.expected]]),
        [current.before],
        [after]
      )
      return owner.execute(async () => {
        if (
          !owner.allows('geometry') ||
          !active ||
          current.cancelled ||
          current.generation !== generation
        )
          return
        await owner.write(() =>
          ImageService.SetGeometryFromDisplayAtRevision(
            repoPath,
            current.revision,
            batch.expected,
            batch.before,
            batch.after
          )
        )
      })
    },
    cancelResize(current) {
      current.cancelled = true
      if (gesture === current) gesture = null
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
        cancelled: false,
        generation,
        revision: board.snapshot.revision,
        expected,
        before: before.map((item) => ({ ...item })),
        onCancel,
      }
      gesture = current
      return current
    },
    endDrag(current, after) {
      if (gesture !== current) return Promise.resolve()
      gesture = null
      const batch = buildDisplayGeometry(
        new Map(current.expected.map((item) => [item.imageId, item])),
        current.before,
        after
      )
      return owner.execute(async () => {
        if (
          !owner.allows('geometry') ||
          !active ||
          current.cancelled ||
          current.generation !== generation
        )
          return
        await owner.write(() =>
          ImageService.SetGeometryFromDisplayAtRevision(
            repoPath,
            current.revision,
            batch.expected,
            batch.before,
            batch.after
          )
        )
      })
    },
    async commitDisplayedLayout(board, before, after, accept) {
      if (!owner.allows('geometry') || !active) return
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
      owner.cancelGesture()
      await owner.write(() =>
        ImageService.SetGeometryFromDisplayAtRevision(
          repoPath,
          board.snapshot.revision,
          batch.expected,
          batch.before,
          batch.after
        )
      )
      if (active && owner.allows('geometry')) accept()
    },
    cancelGesture() {
      const current = gesture
      gesture = null
      if (current) {
        current.cancelled = true
        if ('onCancel' in current) current.onCancel?.()
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
      lane.owners.delete(owner)
      if (
        lane.owners.size === 0 &&
        lane.pendingWrites === 0 &&
        !lane.fence?.uncertain
      ) {
        lane.needsReconciliation = false
        lane.fence = null
      }
      activationEpoch++
      lifetime.abort()
      generation++
      pendingHistory = []
      readyHistory = []
      owner.cancelGesture()
      listeners.clear()
    },
    activate() {
      if (!active) {
        lifetime = new AbortController()
        activationEpoch++
      }
      active = true
      lane.owners.add(owner)
    },
  }
  lane.owners.add(owner)
  return owner
}

function joinSnapshot(
  metadata: CanvasData,
  snapshot: LayoutSnapshot
): CanvasData {
  const byId = new Map(
    (metadata.images ?? []).map((image) => [image.id, image])
  )
  const images = (snapshot.images ?? []).map((node) => {
    const image = byId.get(node.id)
    if (!image)
      throw new Error(
        `Canvas snapshot metadata missing for image ${node.id}. Refresh and try again.`
      )
    const { x, y, w, h } = node.geometry
    return {
      ...image,
      width: node.width,
      height: node.height,
      trashed: false,
      placed: x !== null && y !== null,
      canvasX: x ?? 0,
      canvasY: y ?? 0,
      canvasW: w ?? 0,
      canvasH: h ?? 0,
    }
  })
  return { ...metadata, images, relationships: snapshot.relationships }
}
