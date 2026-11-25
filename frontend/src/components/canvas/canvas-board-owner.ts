import { useEffect, useRef } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
  type LayoutSnapshot,
  type UndoResult,
} from '../../../bindings/loom/internal/service'
import type { DragGesture, ResizeGesture } from './canvas-board-gestures'
import { createCanvasLayoutWriteGate } from './canvas-layout-write-gate'
import {
  allowsCanvasCapability,
  type CanvasCapability,
  type CanvasInternalMode,
} from './canvas-mode-policy'
import { buildDisplayGeometry } from './canvas-projection-geometry'
import type { ResizeDirection } from './canvas-resize-geometry'
import { joinCanvasSnapshot } from './canvas-snapshot'

export interface CanvasBoardExecutor {
  execute<T>(action: () => Promise<T>): Promise<T>
  cancelGesture?(): void
  isActive?(): boolean
}

export interface AcceptedCanvasBoard {
  snapshot: LayoutSnapshot
  data: CanvasData
}

export interface CanvasBoardOwner extends CanvasBoardExecutor {
  getMode(): CanvasInternalMode
  getModeRevision(): number
  getLifetimeRevision(): number
  isLayoutPending(): boolean
  guardLayout(action: () => Promise<void>): Promise<void>
  reserveLayout(): () => void
  beginModeTransition(): void
  setMode(mode: CanvasInternalMode): void
  allows(capability: CanvasCapability): boolean
  refresh(): Promise<AcceptedCanvasBoard | null>
  applyHistory(result: UndoResult): Promise<void>
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
  ): Promise<void>
  cancelResize(token: number, pointerId: number): void
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
  const owner = useRef<{ repoPath: string; executor: CanvasBoardOwner }>(null)
  if (!owner.current || owner.current.repoPath !== repoPath) {
    owner.current = { repoPath, executor: createCanvasBoardOwner(repoPath) }
  }
  const current = owner.current.executor
  useEffect(() => {
    current.activate()
    return () => current.dispose()
  }, [current])
  return current
}

export function createCanvasBoardOwner(repoPath: string): CanvasBoardOwner {
  let tail: Promise<void> = Promise.resolve()
  let generation = 0
  let active = true
  let mode: CanvasInternalMode = 'legacy'
  let modeRevision = 0
  let lifetimeRevision = 0
  let nextGestureToken = 1
  const layoutGate = createCanvasLayoutWriteGate()
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
  function refresh() {
    const request = loadBoard()
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
    return accepted
  }
  const owner: CanvasBoardOwner = {
    getMode: () => mode,
    getModeRevision: () => modeRevision,
    getLifetimeRevision: () => lifetimeRevision,
    isLayoutPending: layoutGate.isPending,
    guardLayout: layoutGate.guard,
    reserveLayout: layoutGate.reserve,
    beginModeTransition: () => {
      modeRevision++
    },
    setMode(next) {
      owner.cancelGesture()
      if (mode !== next) modeRevision++
      mode = next
    },
    allows: (capability) =>
      !(capability === 'geometry' && layoutGate.isPending()) &&
      allowsCanvasCapability(mode, capability),
    execute<T>(action: () => Promise<T>): Promise<T> {
      // Queue outer operations only: awaiting a nested execute would deadlock.
      const result = tail.then(action)
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
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
    beginResize(board, before, direction, pointerId, onPreview, onCancel) {
      if (
        gesture ||
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
      )
        return false
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
        return Promise.resolve()
      if (
        current.cancelled ||
        !active ||
        current.lifetimeRevision !== lifetimeRevision ||
        current.modeRevision !== modeRevision ||
        current.generation !== generation
      ) {
        owner.cancelResize(token, pointerId)
        return Promise.resolve()
      }
      gesture = null
      current.onPreview(after)
      const batch = buildDisplayGeometry(
        new Map([[current.expected.imageId, current.expected]]),
        [current.before],
        [after]
      )
      if (!batch.changed) return Promise.resolve()
      return owner.execute(async () => {
        if (!active || current.lifetimeRevision !== lifetimeRevision) return
        await layoutGate.guard(async () => {
          await ImageService.SetGeometryFromDisplayAtRevision(
            repoPath,
            current.revision,
            batch.expected,
            batch.before,
            batch.after
          ).catch(async (error: unknown) => {
            await owner
              .refresh()
              .catch((reloadError: unknown) =>
                console.error('canvas resize reload failed', reloadError)
              )
            throw error
          })
          await owner.refresh()
        })
      })
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
          !allowsCanvasCapability(mode, 'geometry') ||
          !active ||
          current.cancelled ||
          current.generation !== generation
        )
          return
        await layoutGate.guard(async () => {
          await ImageService.SetGeometryFromDisplayAtRevision(
            repoPath,
            current.revision,
            batch.expected,
            batch.before,
            batch.after
          ).catch(async (error: unknown) => {
            await owner
              .refresh()
              .catch((reloadError: unknown) =>
                console.error('canvas drag reload failed', reloadError)
              )
            throw error
          })
          await owner.refresh()
        })
      })
    },
    async commitDisplayedLayout(board, before, after, accept) {
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
      owner.cancelGesture()
      const requestMode = modeRevision
      const signal = lifetime.signal
      await layoutGate.guard(async () => {
        await ImageService.SetGeometryFromDisplayAtRevision(
          repoPath,
          board.snapshot.revision,
          batch.expected,
          batch.before,
          batch.after
        ).catch(async (error: unknown) => {
          await owner
            .refresh()
            .catch((reloadError: unknown) =>
              console.error('canvas arrange reload failed', reloadError)
            )
          throw error
        })
        if (!active || signal.aborted) return
        if (
          mode === 'edit' &&
          modeRevision === requestMode &&
          owner.getSnapshot() === board
        ) {
          accept()
          await owner.refresh()
        } else {
          // The write is already in history. Reconcile its rows without replaying it.
          await owner.applyHistory({
            applied: true,
            kind: 'geometry',
            geometry: batch.after,
          })
        }
      })
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
      lifetime.abort()
      generation++
      pendingHistory = []
      readyHistory = []
      owner.cancelGesture()
      listeners.clear()
    },
    activate() {
      if (!active) {
        lifetimeRevision++
        lifetime = new AbortController()
      }
      active = true
    },
  }
  return owner
}
