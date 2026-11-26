import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, StrictMode, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  ImageService,
  type LayoutSnapshot,
} from '../../../bindings/loom/internal/service'
import {
  createCanvasBoardOwner,
  useCanvasBoardOwner,
} from './canvas-board-owner'
import {
  mockCanvasObservationFromLegacyRPCs,
  refreshBoard,
} from './canvas-operation-test-utils.test'

const image = {
  id: 1,
  fileName: 'one.png',
  filePath: 'one.png',
  thumbUrl: 'thumb',
  previewUrl: '',
  fullUrl: '',
  width: 10,
  height: 20,
  archived: false,
  trashed: false,
  missing: false,
  placed: true,
  canvasX: 9,
  canvasY: 8,
  canvasW: 7,
  canvasH: 6,
  promptText: '',
  groupId: 0,
  createdAt: '',
}
const data: CanvasData = {
  images: [image, { ...image, id: 2, fileName: 'two.png' }],
  groups: [],
  relationships: [
    {
      id: 5,
      sourceImageId: 1,
      derivedImageId: 2,
      pairingOrder: 1,
      createdAt: null,
    },
  ],
}
const snapshot: LayoutSnapshot = {
  revision: '3',
  images: [1, 2].map((id) => ({
    id,
    width: 100,
    height: 200,
    geometry: { imageId: id, x: null, y: null, w: null, h: null },
  })),
  relationships: [
    {
      id: 5,
      sourceImageId: 2,
      derivedImageId: 1,
      pairingOrder: 8,
      createdAt: null,
    },
  ],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  cleanup()
  mock.restore()
})
beforeEach(mockCanvasObservationFromLegacyRPCs)

describe('board snapshot publication', () => {
  it('uses one later snapshot for membership, geometry and reversed topology', async () => {
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
      snapshot as never
    )
    const owner = createCanvasBoardOwner('/repo')
    const result = await refreshBoard(owner)
    expect(result?.snapshot).toEqual(snapshot)
    expect(result?.data.relationships).toEqual(snapshot.relationships)
    expect(result?.data.images?.[0]).toMatchObject({
      fileName: 'one.png',
      width: 100,
      height: 200,
      placed: false,
      canvasX: 0,
      canvasY: 0,
      canvasW: 0,
      canvasH: 0,
    })
    expect(result?.snapshot.images?.[0].geometry.x).toBeNull()
  })

  it('withholds and reports a snapshot whose metadata is missing', async () => {
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
      ...data,
      images: [image],
    } as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
      snapshot as never
    )
    const owner = createCanvasBoardOwner('/repo')
    expect(await owner.refresh()).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining('metadata missing for image 2'),
      },
    })
    expect(owner.getSnapshot()).toBeNull()
  })

  it('uses snapshot membership and keeps the last accepted value on mismatch', async () => {
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot')
      .mockResolvedValueOnce(snapshot as never)
      .mockResolvedValueOnce({
        ...snapshot,
        images: snapshot.images?.slice(1) ?? [],
        relationships: [],
      } as never)
      .mockResolvedValueOnce({
        ...snapshot,
        images: [
          {
            id: 3,
            width: 1,
            height: 1,
            geometry: { imageId: 3, x: null, y: null, w: null, h: null },
          },
        ],
      } as never)
    const owner = createCanvasBoardOwner('/repo')
    await refreshBoard(owner)
    const accepted = await refreshBoard(owner)
    expect(accepted?.data.images?.map((item) => item.id)).toEqual([2])
    expect(await owner.refresh()).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining('metadata missing for image 3'),
      },
    })
    expect(owner.getSnapshot()).toBe(accepted)
  })

  it('serializes refresh requests and publishes them in FIFO order', async () => {
    const old = deferred<CanvasData | null>()
    spyOn(ImageService, 'LoadCanvas')
      .mockResolvedValueOnce(data as never)
      .mockImplementationOnce(() => old.promise as never)
      .mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
      snapshot as never
    )
    const owner = createCanvasBoardOwner('/repo')
    await refreshBoard(owner)
    const first = owner.refresh()
    const second = owner.refresh()
    await Promise.resolve()
    old.resolve(data)
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])
    expect(firstOutcome.status).toBe('success')
    expect(secondOutcome.status).toBe('success')
    expect(owner.getSnapshot()).toBe(
      secondOutcome.status === 'success' ? secondOutcome.value : null
    )
    expect(ImageService.GetLayoutSnapshot).toHaveBeenCalledTimes(3)
  })

  it('queues a newer refresh behind a snapshot that is already loading', async () => {
    const old = deferred<LayoutSnapshot | null>()
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot')
      .mockResolvedValueOnce(snapshot as never)
      .mockImplementationOnce(() => old.promise as never)
      .mockResolvedValue(snapshot as never)
    const owner = createCanvasBoardOwner('/repo')
    await refreshBoard(owner)
    const first = owner.refresh()
    await Promise.resolve()
    const latest = owner.refresh()
    await Promise.resolve()
    old.resolve({ ...snapshot, revision: '2' })
    const [firstOutcome, latestOutcome] = await Promise.all([first, latest])
    expect(firstOutcome.status).toBe('success')
    expect(latestOutcome.status).toBe('success')
    expect(owner.getSnapshot()).toBe(
      latestOutcome.status === 'success' ? latestOutcome.value : null
    )
  })

  it('unsubscribes notifications and prevents publication after disposal', async () => {
    const pending = deferred<LayoutSnapshot | null>()
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot')
      .mockImplementationOnce(() => Promise.resolve(snapshot) as never)
      .mockImplementationOnce(() => pending.promise as never)
    const owner = createCanvasBoardOwner('/repo')
    const listener = mock()
    const unsubscribe = owner.subscribe(listener)
    await refreshBoard(owner)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    const refresh = owner.refresh()
    await Promise.resolve()
    owner.dispose()
    pending.resolve(snapshot)
    expect((await refresh).status).toBe('cancelled')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('disposes the old owner on repository switch and unmount', async () => {
    const pending = deferred<CanvasData | null>()
    spyOn(ImageService, 'LoadCanvas').mockImplementation(
      () => pending.promise as never
    )
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
      snapshot as never
    )
    const { result, rerender, unmount } = renderHook(
      ({ path }) => useCanvasBoardOwner(path),
      { initialProps: { path: '/one' } }
    )
    const first = result.current
    const loading = first.refresh()
    rerender({ path: '/two' })
    const second = result.current
    const loadingSecond = second.refresh()
    unmount()
    pending.resolve(data)
    expect((await loading).status).toBe('cancelled')
    expect((await loadingSecond).status).toBe('cancelled')
    expect(first.getSnapshot()).toBeNull()
    expect(second.getSnapshot()).toBeNull()
  })

  it('notifies React subscribers after Strict Mode effect replay', async () => {
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
      snapshot as never
    )
    const { result, unmount } = renderHook(
      () => {
        const owner = useCanvasBoardOwner('/repo')
        const accepted = useSyncExternalStore(
          owner.subscribe,
          owner.getSnapshot
        )
        return { owner, accepted }
      },
      { wrapper: ({ children }) => createElement(StrictMode, null, children) }
    )
    await act(async () => {
      await result.current.owner.refresh()
    })
    expect(result.current.accepted?.snapshot.revision).toBe('3')
    unmount()
  })
})
