import type { Viewport } from '@xyflow/react'

interface CameraClock {
  now(): number
  request(callback: (time: number) => void): number
  cancel(id: number): void
}

interface CameraDependencies {
  read(): Viewport
  /** Apply immediately, without a library-owned animation. */
  apply(viewport: Viewport): void
  persist(viewport: Viewport): Promise<void>
  report(error: unknown): void
  clock: CameraClock
}

/** Owns programmatic camera intent and serializes persistence of accepted views. */
export function createCanvasCamera(deps: CameraDependencies) {
  let revision = 0
  let frame: number | null = null
  let finishAnimation: ((completed: boolean) => void) | null = null
  let disposed = false
  let pending: Viewport | null = null
  let saving = false
  let failed = false
  let visible = deps.read()
  let drainWaiters: Array<() => void> = []

  function resolveDrains() {
    if (saving || (!failed && pending)) return
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  function flush() {
    if (saving || failed || !pending) return
    const viewport = pending
    pending = null
    saving = true
    void deps
      .persist(viewport)
      .catch((error) => {
        failed = true
        pending = null
        deps.report(error)
      })
      .finally(() => {
        saving = false
        flush()
        resolveDrains()
      })
  }

  function save(viewport: Viewport) {
    pending = { ...viewport }
    flush()
  }

  function interrupt() {
    revision++
    // A queued write is no longer authoritative once a new intent arrives.
    // An in-flight write cannot be recalled; flush serializes any later write
    // after it completes.
    pending = null
    if (frame !== null) deps.clock.cancel(frame)
    frame = null
    finishAnimation?.(false)
    finishAnimation = null
    return revision
  }

  async function move(
    resolveTarget: () => Promise<Viewport>,
    duration = 0
  ): Promise<boolean> {
    if (disposed) return false
    const intent = interrupt()
    const target = await resolveTarget()
    if (disposed || intent !== revision) return false
    const start = visible
    if (duration <= 0) {
      visible = target
      deps.apply(target)
      save(target)
      return true
    }
    const started = deps.clock.now()
    return new Promise<boolean>((resolve) => {
      finishAnimation = resolve
      function tick(time: number) {
        if (disposed || intent !== revision) {
          resolve(false)
          return
        }
        const progress = Math.max(0, Math.min(1, (time - started) / duration))
        const eased = 1 - (1 - progress) ** 3
        const viewport = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          zoom: start.zoom + (target.zoom - start.zoom) * eased,
        }
        visible = viewport
        deps.apply(viewport)
        if (progress === 1) {
          frame = null
          finishAnimation = null
          save(viewport)
          resolve(true)
        } else frame = deps.clock.request(tick)
      }
      frame = deps.clock.request(tick)
    })
  }

  function updateGesture(intent: number, viewport: Viewport) {
    if (disposed) return false
    if (intent !== revision) {
      deps.apply(visible)
      return false
    }
    visible = viewport
    return true
  }

  return {
    move,
    activate() {
      disposed = false
    },
    version: () => revision,
    reserve() {
      return interrupt()
    },
    drain() {
      if (!saving && (!pending || failed)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve)
      })
    },
    restore(viewport: Viewport) {
      if (disposed) return
      interrupt()
      visible = viewport
      deps.apply(viewport)
    },
    beginGesture() {
      return interrupt()
    },
    updateGesture,
    endGesture(intent: number, viewport: Viewport) {
      if (!updateGesture(intent, viewport)) return
      save(viewport)
    },
    /** User input supersedes an animation and persists the visible camera. */
    accept(viewport: Viewport) {
      if (disposed) return
      interrupt()
      visible = viewport
      save(viewport)
    },
    dispose() {
      disposed = true
      revision++
      if (frame !== null) deps.clock.cancel(frame)
      frame = null
      finishAnimation?.(false)
      finishAnimation = null
    },
  }
}
