import { useEffect, useRef } from 'react'
import {
  type CanvasData,
  ImageService,
  type LayoutSnapshot,
} from '../../../bindings/loom/internal/service'

export interface CanvasBoardExecutor {
  execute<T>(action: () => Promise<T>): Promise<T>
}

export interface AcceptedCanvasBoard {
  snapshot: LayoutSnapshot
  data: CanvasData
}

export interface CanvasBoardOwner extends CanvasBoardExecutor {
  refresh(): Promise<AcceptedCanvasBoard | null>
  getSnapshot(): AcceptedCanvasBoard | null
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
  const listeners = new Set<() => void>()
  return {
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
      const isCurrent = () => active && request === generation
      const metadata = await ImageService.LoadCanvas(repoPath)
      if (!isCurrent()) return null
      if (!metadata) throw new Error('Canvas metadata is unavailable')
      const snapshot = await ImageService.GetLayoutSnapshot(repoPath)
      if (!isCurrent()) return null
      if (!snapshot) throw new Error('Canvas layout snapshot is unavailable')
      const data = joinSnapshot(metadata, snapshot)
      accepted = { snapshot, data }
      for (const listener of listeners) listener()
      return accepted
    },
    getSnapshot: () => accepted,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      active = false
      generation++
      listeners.clear()
    },
    activate() {
      active = true
    },
  }
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
