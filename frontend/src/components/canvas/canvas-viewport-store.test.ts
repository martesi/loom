import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasCamera } from './canvas-camera'
import {
  loadCanvasViewport,
  registerCameraDrain,
  saveCanvasViewport,
} from './canvas-viewport-store'

afterEach(() => mock.restore())

describe('viewport store lifetimes', () => {
  it('waits for a disposed owner’s queued save before the next read', async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    let stored = { x: 0, y: 0, zoom: 1 }
    let writes = 0
    const set = spyOn(ImageService, 'SetViewport').mockImplementation(
      (_path, viewport) => {
        writes++
        return (
          writes === 1
            ? first.then(() => {
                stored = viewport
              })
            : Promise.resolve().then(() => {
                stored = viewport
              })
        ) as never
      }
    )
    spyOn(ImageService, 'GetViewport').mockImplementation(
      () => Promise.resolve(stored) as never
    )
    const path = '/viewport-drain-test'
    const camera = createCanvasCamera({
      read: () => stored,
      apply: () => {},
      persist: (viewport) => saveCanvasViewport(path, viewport),
      report: () => {},
      clock: { now: () => 0, request: () => 1, cancel: () => {} },
    })
    camera.accept({ x: 1, y: 0, zoom: 1 })
    await Promise.resolve()
    camera.accept({ x: 2, y: 0, zoom: 1 })
    camera.dispose()
    registerCameraDrain(path, camera.drain())
    const read = loadCanvasViewport(path)
    release()
    expect(await read).toEqual({ x: 2, y: 0, zoom: 1 })
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('does not use a read to clear a failed write', async () => {
    spyOn(ImageService, 'SetViewport').mockImplementation(
      () => Promise.reject(new Error('unknown outcome')) as never
    )
    const get = spyOn(ImageService, 'GetViewport')
    const path = '/viewport-failure-test'
    await expect(
      saveCanvasViewport(path, { x: 1, y: 0, zoom: 1 })
    ).rejects.toThrow('unknown outcome')
    await expect(loadCanvasViewport(path)).rejects.toThrow('unknown outcome')
    expect(get).not.toHaveBeenCalled()
  })
})
