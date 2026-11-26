import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { waitFor } from '@testing-library/react'
import {
  type CanvasData,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

const data: CanvasData = {
  images: [
    {
      id: 1,
      fileName: 'image.png',
      filePath: '',
      thumbUrl: '',
      previewUrl: '',
      fullUrl: '',
      width: 640,
      height: 480,
      archived: false,
      trashed: false,
      missing: false,
      placed: true,
      canvasX: 10,
      canvasY: 20,
      canvasW: 150,
      canvasH: 110,
      promptText: '',
      groupId: 0,
      createdAt: '',
    },
  ],
  relationships: [],
  groups: [],
}
const rect = (x: number) => ({ imageId: 1, x, y: 20, w: null, h: null })
const replay = { applied: true, kind: 'geometry', geometry: [rect(20)] }
const owners: ReturnType<typeof createCanvasBoardOwner>[] = []
function ownerFor(path = '/repo') {
  const owner = createCanvasBoardOwner(path)
  owners.push(owner)
  return owner
}
function snapshot(x: number) {
  return {
    revision: String(x),
    images: [{ id: 1, width: 640, height: 480, geometry: rect(x) }],
    relationships: [],
  }
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose()
  mock.restore()
})

it('removes disposal waiters after completed replays and wakes a pending waiter', async () => {
  const pending = deferred<CanvasData>()
  const load = spyOn(ImageService, 'LoadCanvas').mockResolvedValue(
    data as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
    snapshot(20) as never
  )
  const added = spyOn(AbortSignal.prototype, 'addEventListener')
  const removed = spyOn(AbortSignal.prototype, 'removeEventListener')
  const owner = ownerFor()

  for (let i = 0; i < 1000; i++) await owner.applyHistory(replay)

  const waiters = () => {
    const listeners = new Set<EventListenerOrEventListenerObject | null>()
    for (const [type, listener] of added.mock.calls) {
      if (type === 'abort') listeners.add(listener)
    }
    for (const [type, listener] of removed.mock.calls) {
      if (type === 'abort') listeners.delete(listener)
    }
    return listeners.size
  }
  expect(waiters()).toBe(0)
  expect(added).toHaveBeenCalledTimes(1000)
  expect(removed).toHaveBeenCalledTimes(1000)
  load.mockImplementationOnce(() => pending.promise as never)
  const history = owner.applyHistory(replay)
  expect(waiters()).toBe(1)
  owner.dispose()
  await history
  expect(waiters()).toBe(0)
})

it('unblocks replay and queued work when a newer refresh accepts while the original never settles', async () => {
  const added = spyOn(AbortSignal.prototype, 'addEventListener')
  const removed = spyOn(AbortSignal.prototype, 'removeEventListener')
  const obsolete = deferred<CanvasData>()
  spyOn(ImageService, 'LoadCanvas')
    .mockImplementationOnce(() => obsolete.promise as never)
    .mockResolvedValue(data as never)
  let x = 20
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () => Promise.resolve(snapshot(x)) as never
  )
  const owner = ownerFor()
  const reconciled = mock()
  const committed = mock()
  const history = owner.execute(async () => {
    await owner.applyHistory(replay)
    reconciled()
  })
  const queued = owner.execute(async () => {
    committed()
    x = 90
    await owner.refresh()
  })
  await waitFor(() => expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(1))
  expect(committed).not.toHaveBeenCalled()
  await owner.refresh()
  await waitFor(() => expect(committed).toHaveBeenCalledTimes(1), {
    timeout: 500,
  })
  await Promise.all([history, queued])
  expect(added).toHaveBeenCalledTimes(1)
  expect(removed).toHaveBeenCalledTimes(1)
  expect(removed.mock.calls[0][1]).toBe(added.mock.calls[0][1])
  expect(reconciled).toHaveBeenCalledTimes(1)
  expect(owner.getSnapshot()?.snapshot.images?.[0].geometry).toEqual(rect(90))
  expect(owner.takeHistory()).toEqual([{ ...replay, geometry: [rect(90)] }])
  obsolete.reject(new Error('obsolete refresh failed late'))
  await Promise.resolve()
})

it('ignores a stale newer refresh that completes before the current refresh', async () => {
  const obsolete = deferred<CanvasData>()
  const stale = deferred<CanvasData>()
  const current = deferred<CanvasData>()
  spyOn(ImageService, 'LoadCanvas')
    .mockImplementationOnce(() => obsolete.promise as never)
    .mockImplementationOnce(() => stale.promise as never)
    .mockImplementationOnce(() => current.promise as never)
  const snapshots = spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
    snapshot(20) as never
  )
  const owner = ownerFor()
  const history = owner.execute(() => owner.applyHistory(replay))
  const done = mock()
  const queued = owner.execute(async () => {
    done()
  })
  await waitFor(() => expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(1))
  const staleRefresh = owner.refresh()
  const currentRefresh = owner.refresh()
  stale.resolve(data)
  expect(await staleRefresh).toBeNull()
  expect(snapshots).not.toHaveBeenCalled()
  expect(owner.takeHistory()).toEqual([])
  expect(done).not.toHaveBeenCalled()
  current.resolve(data)
  await currentRefresh
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 500 })
  await Promise.all([history, queued])
  expect(owner.takeHistory()).toEqual([replay])
})

it('ignores a failed stale newer refresh and waits for the current refresh', async () => {
  const obsolete = deferred<CanvasData>()
  const stale = deferred<CanvasData>()
  const current = deferred<CanvasData>()
  spyOn(ImageService, 'LoadCanvas')
    .mockImplementationOnce(() => obsolete.promise as never)
    .mockImplementationOnce(() => stale.promise as never)
    .mockImplementationOnce(() => current.promise as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
    snapshot(20) as never
  )
  const owner = ownerFor()
  const done = mock()
  const history = owner.execute(() => owner.applyHistory(replay))
  const queued = owner.execute(async () => {
    done()
  })
  await waitFor(() => expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(1))
  const staleRefresh = owner.refresh().catch((error: unknown) => error)
  const currentRefresh = owner.refresh()
  const error = new Error('stale load failed')
  stale.reject(error)
  expect(await staleRefresh).toBe(error)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  current.resolve(data)
  await currentRefresh
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 500 })
  await Promise.all([history, queued])
  expect(owner.takeHistory()).toEqual([replay])
})

it('propagates the current refresh failure and releases queued work without replaying later', async () => {
  const added = spyOn(AbortSignal.prototype, 'addEventListener')
  const removed = spyOn(AbortSignal.prototype, 'removeEventListener')
  const obsolete = deferred<CanvasData>()
  const failing = deferred<CanvasData>()
  spyOn(ImageService, 'LoadCanvas')
    .mockImplementationOnce(() => obsolete.promise as never)
    .mockImplementationOnce(() => failing.promise as never)
    .mockResolvedValue(data as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
    snapshot(90) as never
  )
  const owner = ownerFor()
  const history = owner
    .execute(() => owner.applyHistory(replay))
    .catch((error: unknown) => error)
  const done = mock()
  const queued = owner.execute(async () => {
    done()
  })
  await waitFor(() => expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(1))
  const refresh = owner.refresh().catch((error: unknown) => error)
  await waitFor(() => expect(added).toHaveBeenCalledTimes(2))
  expect(removed).toHaveBeenCalledTimes(1)
  expect(removed.mock.calls[0][1]).toBe(added.mock.calls[0][1])
  const error = new Error('current load failed')
  failing.reject(error)
  expect(await refresh).toBe(error)
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 500 })
  expect(await history).toBe(error)
  expect(removed).toHaveBeenCalledTimes(2)
  expect(removed.mock.calls[1][1]).toBe(added.mock.calls[1][1])
  await queued
  await owner.refresh()
  expect(owner.takeHistory()).toEqual([])
})

it('releases reconciliation on disposal even when all requests stay unresolved', async () => {
  const obsolete = deferred<CanvasData>()
  const newer = deferred<CanvasData>()
  spyOn(ImageService, 'LoadCanvas')
    .mockImplementationOnce(() => obsolete.promise as never)
    .mockImplementationOnce(() => newer.promise as never)
  const owner = ownerFor()
  const history = owner.execute(() => owner.applyHistory(replay))
  const done = mock()
  const queued = owner.execute(async () => {
    done()
  })
  await waitFor(() => expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(1))
  const refresh = owner.refresh().catch((error: unknown) => error)
  owner.dispose()
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 500 })
  await Promise.all([history, queued])
  expect(owner.takeHistory()).toEqual([])
  expect(owner.getSnapshot()).toBeNull()
  obsolete.reject(new Error('disposed refresh failed late'))
  const error = new Error('superseding refresh failed late')
  newer.reject(error)
  expect(await refresh).toBe(error)
  await Promise.resolve()
})

it('does not carry a disposed reconciliation into a reactivated lifetime', async () => {
  const old = deferred<CanvasData>()
  const current = deferred<CanvasData>()
  spyOn(ImageService, 'LoadCanvas')
    .mockImplementationOnce(() => old.promise as never)
    .mockImplementationOnce(() => current.promise as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
    snapshot(20) as never
  )
  const owner = ownerFor()
  const first = owner.applyHistory(replay)
  owner.dispose()
  owner.activate()
  const second = owner.applyHistory(replay)
  const settled = mock()
  void first.then(settled)
  await waitFor(() => expect(settled).toHaveBeenCalledTimes(1), {
    timeout: 500,
  })
  current.resolve(data)
  await Promise.all([first, second])
  expect(owner.takeHistory()).toEqual([replay])
})
