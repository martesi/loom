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

  function flush() {
    if (saving || !pending) return
    const viewport = pending
    pending = null
    saving = true
    void deps
      .persist(viewport)
      .catch(deps.report)
      .finally(() => {
        saving = false
        flush()
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
    const start = deps.read()
    if (duration <= 0) {
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

  return {
    move,
    /** User input supersedes an animation and persists the visible camera. */
    accept(viewport: Viewport) {
      if (disposed) return
      interrupt()
      save(viewport)
    },
    dispose() {
      disposed = true
      interrupt()
    },
  }
}
