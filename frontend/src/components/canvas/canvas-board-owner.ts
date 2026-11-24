import { useEffect, useRef } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
  type LayoutSnapshot,
} from '../../../bindings/loom/internal/service'
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
}

export interface AcceptedCanvasBoard {
  snapshot: LayoutSnapshot
  data: CanvasData
}

export interface CanvasBoardOwner extends CanvasBoardExecutor {
  refresh(): Promise<AcceptedCanvasBoard | null>
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
  let accepted: AcceptedCanvasBoard | null = null
  let acceptedGeneration = -1
  let gesture: ResizeGesture | DragGesture | null = null
  const listeners = new Set<() => void>()
  const owner: CanvasBoardOwner = {
    execute<T>(action: () => Promise<T>): Promise<T> {
      // Queue outer operations only: awaiting a nested execute would deadlock.
      const result = tail.then(action)
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
    async refresh() {
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
      accepted = { snapshot, data }
      acceptedGeneration = generation
      for (const listener of listeners) listener()
      return accepted
    },
    getSnapshot: () => accepted,
    beginResize(board, before) {
      if (
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
        if (!active || current.cancelled || current.generation !== generation)
          return
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
    },
    cancelResize(current) {
      current.cancelled = true
      if (gesture === current) gesture = null
    },
    beginDrag(board, before, onCancel) {
      if (
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
        if (!active || current.cancelled || current.generation !== generation)
          return
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
      generation++
      owner.cancelGesture()
      listeners.clear()
    },
    activate() {
      active = true
    },
  }
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
