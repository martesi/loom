import type { Viewport } from '@xyflow/react'
import { ImageService } from '../../../bindings/loom/internal/service'

interface StoreQueue {
  tail: Promise<void>
  error: unknown | null
  drains: Set<Promise<void>>
}

// Owners may overlap during a repository switch or React remount. Keep writes
// and the next read in one process-local sequence for each repository.
const queues = new Map<string, StoreQueue>()

function queueFor(repoPath: string): StoreQueue {
  let queue = queues.get(repoPath)
  if (!queue) {
    queue = { tail: Promise.resolve(), error: null, drains: new Set() }
    queues.set(repoPath, queue)
  }
  return queue
}

export function registerCameraDrain(repoPath: string, drain: Promise<void>) {
  const queue = queueFor(repoPath)
  queue.drains.add(drain)
  void drain.finally(() => queue.drains.delete(drain))
}

export function saveCanvasViewport(
  repoPath: string,
  viewport: Viewport
): Promise<void> {
  const queue = queueFor(repoPath)
  const write = queue.tail.then(async () => {
    if (queue.error !== null) throw queue.error
    await ImageService.SetViewport(repoPath, viewport)
  })
  queue.tail = write.catch((error: unknown) => {
    queue.error = error ?? new Error('Viewport write outcome is unknown')
  })
  return write
}

export async function loadCanvasViewport(repoPath: string) {
  const queue = queueFor(repoPath)
  await Promise.all(queue.drains)
  await queue.tail
  if (queue.error !== null) throw queue.error
  return ImageService.GetViewport(repoPath)
}
