import { describe, expect, it, mock } from 'bun:test'
import type { Viewport } from '@xyflow/react'
import { createCanvasCamera } from './canvas-camera'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  let visible: Viewport = { x: 0, y: 0, zoom: 2 }
  let now = 0
  let id = 0
  const frames = new Map<number, (time: number) => void>()
  const persist = mock(async (_viewport: Viewport) => {})
  const camera = createCanvasCamera({
    read: () => visible,
    apply: (viewport) => {
      visible = viewport
    },
    persist,
    report: () => {},
    clock: {
      now: () => now,
      request: (callback) => {
        frames.set(++id, callback)
        return id
      },
      cancel: (key) => frames.delete(key),
    },
  })
  function advance(time: number) {
    now = time
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(time)
  }
  return {
    camera,
    persist,
    advance,
    visible: () => visible,
    callbacks: () => [...frames.values()],
  }
}

describe('canvas camera intent', () => {
  it('interrupts recenter at the visible position when Fit is requested', async () => {
    const f = fixture()
    const recenter = f.camera.move(
      async () => ({ x: 100, y: 50, zoom: 2 }),
      100
    )
    await Promise.resolve()
    f.advance(50)
    const visible = f.visible()
    const fit = f.camera.move(async () => ({ x: -20, y: -30, zoom: 1 }), 100)
    expect(await recenter).toBe(false)
    await Promise.resolve()
    expect(f.visible()).toEqual(visible)
    f.advance(150)
    expect(await fit).toBe(true)
    expect(f.visible()).toEqual({ x: -20, y: -30, zoom: 1 })
    expect(f.persist).toHaveBeenCalledTimes(1)
  })

  it('ignores a delayed Fit target after a later recenter intent', async () => {
    const f = fixture()
    const target = deferred<Viewport>()
    const fit = f.camera.move(() => target.promise)
    const recenter = f.camera.move(async () => ({ x: 10, y: 20, zoom: 2 }))
    expect(await recenter).toBe(true)
    target.resolve({ x: 300, y: 400, zoom: 1 })
    expect(await fit).toBe(false)
    expect(f.visible()).toEqual({ x: 10, y: 20, zoom: 2 })
    expect(f.persist).toHaveBeenCalledTimes(1)
  })

  it('serializes writes so a slower old save cannot overwrite the latest view', async () => {
    const first = deferred<void>()
    const writes: Viewport[] = []
    const f = fixture()
    f.persist.mockImplementation((viewport) => {
      writes.push(viewport)
      return writes.length === 1 ? first.promise : Promise.resolve()
    })
    f.camera.accept({ x: 1, y: 2, zoom: 2 })
    f.camera.accept({ x: 3, y: 4, zoom: 2 })
    expect(writes).toEqual([{ x: 1, y: 2, zoom: 2 }])
    first.resolve()
    await first.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual([
      { x: 1, y: 2, zoom: 2 },
      { x: 3, y: 4, zoom: 2 },
    ])
  })

  it('does not apply or persist an already queued stale animation callback', async () => {
    const f = fixture()
    const old = f.camera.move(async () => ({ x: 100, y: 50, zoom: 2 }), 100)
    await Promise.resolve()
    const stale = f.callbacks()[0]
    const latest = f.camera.move(async () => ({ x: 5, y: 8, zoom: 2 }))
    expect(await old).toBe(false)
    expect(await latest).toBe(true)
    stale(100)
    expect(f.visible()).toEqual({ x: 5, y: 8, zoom: 2 })
    expect(f.persist).toHaveBeenCalledTimes(1)
  })

  it('drops a queued save as soon as a later intent is accepted', async () => {
    const first = deferred<void>()
    const target = deferred<Viewport>()
    const writes: Viewport[] = []
    const f = fixture()
    f.persist.mockImplementation((viewport) => {
      writes.push(viewport)
      return writes.length === 1 ? first.promise : Promise.resolve()
    })
    f.camera.accept({ x: 1, y: 0, zoom: 2 })
    f.camera.accept({ x: 2, y: 0, zoom: 2 })
    const latest = f.camera.move(() => target.promise)
    first.resolve()
    await first.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual([{ x: 1, y: 0, zoom: 2 }])
    target.resolve({ x: 3, y: 0, zoom: 2 })
    expect(await latest).toBe(true)
    expect(writes).toEqual([
      { x: 1, y: 0, zoom: 2 },
      { x: 3, y: 0, zoom: 2 },
    ])
  })

  it('settles an interrupted animation and ignores callbacks after disposal', async () => {
    const f = fixture()
    const moving = f.camera.move(async () => ({ x: 100, y: 0, zoom: 2 }), 100)
    await Promise.resolve()
    const stale = f.callbacks()[0]
    f.camera.dispose()
    expect(await moving).toBe(false)
    stale(100)
    expect(f.visible()).toEqual({ x: 0, y: 0, zoom: 2 })
    expect(f.persist).toHaveBeenCalledTimes(0)
  })
})
