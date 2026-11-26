import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { canvasEffects } from './canvas-operation-effects'

afterEach(() => mock.restore())

it('queues a replacement owner activation behind a disposed owner write', async () => {
  let releaseWrite = () => {}
  let signalWriteStarted = () => {}
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve
  })
  const load = spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [
      {
        id: 1,
        width: 640,
        height: 480,
        geometry: { imageId: 1, x: 0, y: 0, w: 150, h: 110 },
      },
    ],
    relationships: [],
  } as never)
  spyOn(ImageService, 'SetGeometry').mockImplementation(async () => {
    signalWriteStarted()
    await writeGate
  })

  const oldOwner = createCanvasBoardOwner('/same-repository', true)
  expect((await oldOwner.activate()).status).toBe('success')
  const edit = await oldOwner.submit(
    { kind: 'mode', target: 'edit' },
    async (context) => context.setMode('edit')
  )
  expect(edit.status).toBe('success')
  const board = oldOwner.getSnapshot()
  const write = oldOwner.submit(
    { kind: 'mutation', capability: 'geometry', board },
    (context) => canvasEffects.setGeometry(context, '/same-repository', [])
  )
  await writeStarted

  const replacement = createCanvasBoardOwner('/same-repository', true)
  const activation = replacement.activate()
  oldOwner.dispose()
  expect(load).toHaveBeenCalledTimes(1)

  releaseWrite()
  expect(await write).toMatchObject({ status: 'failed' })
  expect((await activation).status).toBe('success')
  expect(load).toHaveBeenCalledTimes(2)
  expect(replacement.getSnapshot()?.snapshot.revision).toBe('1')
  replacement.dispose()
})

it('does not perform a write when disposal invalidates asynchronous preparation', async () => {
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [
      {
        id: 1,
        width: 640,
        height: 480,
        geometry: { imageId: 1, x: 0, y: 0, w: 150, h: 110 },
      },
    ],
    relationships: [],
  } as never)
  const write = spyOn(ImageService, 'SetGeometry').mockResolvedValue(
    undefined as never
  )
  const owner = createCanvasBoardOwner('/dispose-prepare', true)
  expect((await owner.activate()).status).toBe('success')
  let releasePreparation = () => {}
  const preparation = new Promise<void>((resolve) => {
    releasePreparation = resolve
  })
  let signalPreparation = () => {}
  const started = new Promise<void>((resolve) => {
    signalPreparation = resolve
  })
  const board = owner.getSnapshot()
  const operation = owner.submit(
    { kind: 'mutation', capability: 'geometry', board },
    async (context) => {
      await context.prepare(async () => {
        signalPreparation()
        await preparation
      })
      await canvasEffects.setGeometry(context, '/dispose-prepare', [])
    }
  )

  await started
  owner.dispose()
  releasePreparation()
  expect(await operation).toMatchObject({ status: 'cancelled' })
  expect(write).not.toHaveBeenCalled()
})
