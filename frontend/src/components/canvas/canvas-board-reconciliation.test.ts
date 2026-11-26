import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { waitFor } from '@testing-library/react'
import {
  type CanvasData,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { isCanvasRepositoryDirty } from './canvas-operation'
import { canvasEffects } from './canvas-operation-effects'
import {
  mockCanvasObservationFromLegacyRPCs,
  queueCanvasHistory,
  refreshBoard,
} from './canvas-operation-test-utils.test'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const data: CanvasData = {
  images: [
    {
      id: 1,
      fileName: 'image.png',
      filePath: 'image.png',
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

const rect = (x: number) => ({ imageId: 1, x, y: 20, w: 150, h: 110 })
const replay = {
  applied: true,
  kind: 'geometry',
  geometry: [rect(20)],
} as never
const owners: ReturnType<typeof createCanvasBoardOwner>[] = []

function ownerFor(path = '/repo', shared = false) {
  const owner = createCanvasBoardOwner(path, shared)
  owners.push(owner)
  return owner
}

function snapshot(revision: string, x = 10) {
  return {
    revision,
    images: [{ id: 1, width: 640, height: 480, geometry: rect(x) }],
    relationships: [],
  }
}

function mockBoard() {
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
    snapshot('1') as never
  )
  mockCanvasObservationFromLegacyRPCs()
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose()
  mock.restore()
})

it('keeps repeated replay publication ordered and retains each applied entry', async () => {
  mockBoard()
  const load = ImageService.LoadCanvas
  const owner = ownerFor()
  await refreshBoard(owner)

  for (let index = 0; index < 100; index++)
    await queueCanvasHistory(owner, {
      ...replay,
      geometry: [rect(index)],
    } as never)

  expect(owner.takeHistory()).toHaveLength(100)
  expect(load).toHaveBeenCalledTimes(101)
})

it('rejects geometry captured before a queued history reconciliation publishes', async () => {
  const delayed = deferred<CanvasData | null>()
  const load = spyOn(ImageService, 'LoadCanvas')
    .mockResolvedValueOnce(data as never)
    .mockImplementationOnce(() => delayed.promise as never)
    .mockResolvedValue(data as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue(
    snapshot('1', 20) as never
  )
  const write = spyOn(ImageService, 'SetGeometry').mockResolvedValue(
    undefined as never
  )
  const owner = ownerFor()
  await refreshBoard(owner)
  const original = owner.getSnapshot()
  const history = queueCanvasHistory(owner, replay)
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  let attempted = false
  const geometry = owner.submit(
    { kind: 'mutation', capability: 'geometry', board: original },
    async (context) => {
      attempted = true
      await canvasEffects.setGeometry(context, '/repo', [rect(90)])
    }
  )

  delayed.resolve(data)
  expect((await history).status).toBe('success')
  expect(await geometry).toMatchObject({ status: 'rejected' })
  expect(attempted).toBe(false)
  expect(write).not.toHaveBeenCalled()
  expect(owner.getSnapshot()?.snapshot.images?.[0].geometry).toEqual(rect(20))
})

it('serializes two refreshes and publishes them in FIFO order', async () => {
  const firstResponse = deferred<CanvasData | null>()
  let call = 0
  const load = spyOn(ImageService, 'LoadCanvas').mockImplementation(() => {
    call++
    if (call === 2) return firstResponse.promise as never
    return Promise.resolve(data) as never
  })
  let snapshotIndex = 0
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(() => {
    snapshotIndex++
    return Promise.resolve(
      snapshot(String(snapshotIndex), snapshotIndex)
    ) as never
  })
  const owner = ownerFor()
  await refreshBoard(owner)
  const first = owner.refresh()
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  const second = owner.refresh()
  expect(load).toHaveBeenCalledTimes(2)

  firstResponse.resolve(data)
  expect((await first).status).toBe('success')
  expect((await second).status).toBe('success')
  expect(load).toHaveBeenCalledTimes(3)
  expect(owner.getSnapshot()?.snapshot.revision).toBe('3')
  expect(owner.getSnapshot()?.snapshot.images?.[0].geometry).toEqual(rect(3))
})

it('keeps the repository fenced after a write whose outcome is unknown', async () => {
  mockBoard()
  const repoPath = '/repo-unknown-write-fence'
  const owner = ownerFor(repoPath, true)
  await refreshBoard(owner)
  const board = owner.getSnapshot()
  const reload = spyOn(ImageService, 'LoadCanvas').mockRejectedValueOnce(
    new Error('reload failed') as never
  )
  reload.mockClear()
  const partialWrite = owner.submit(
    { kind: 'mutation', capability: 'geometry', board },
    (context) =>
      context.effect(async () => {
        throw new Error('backend write failed')
      })
  )
  expect(await partialWrite).toMatchObject({ status: 'failed' })
  expect(reload).not.toHaveBeenCalled()
  expect(isCanvasRepositoryDirty(repoPath)).toBe(true)

  let wrote = false
  expect(
    await owner.submit(
      {
        kind: 'mutation',
        capability: 'geometry',
        board: owner.getSnapshot(),
      },
      async () => {
        wrote = true
      }
    )
  ).toMatchObject({ status: 'failed' })
  expect(wrote).toBe(false)
  expect(isCanvasRepositoryDirty(repoPath)).toBe(true)
})

it('cancels prepared work after disposal and does not publish its late result', async () => {
  mockBoard()
  const owner = ownerFor()
  const board = await refreshBoard(owner)
  const prepared = deferred<void>()
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const write = spyOn(ImageService, 'SetGeometry').mockResolvedValue(
    undefined as never
  )
  const operation = owner.submit(
    { kind: 'mutation', capability: 'geometry', board },
    async (context) => {
      await context.prepare(async () => {
        signalStarted()
        await prepared.promise
      })
      await canvasEffects.setGeometry(context, '/repo', [rect(90)])
    }
  )
  await started
  owner.dispose()
  prepared.resolve()
  expect(await operation).toMatchObject({ status: 'cancelled' })
  expect(write).not.toHaveBeenCalled()
  expect(owner.getSnapshot()).toBeNull()
})
