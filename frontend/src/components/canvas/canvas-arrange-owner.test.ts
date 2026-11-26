import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import {
  refreshBoard,
  reserveCanvasOperation,
} from './canvas-operation-test-utils.test'

afterEach(() => mock.restore())

it('serializes layout with mode changes and rejects an obsolete board', async () => {
  const stored = { imageId: 1, x: null, y: null, w: null, h: null }
  const before = { imageId: 1, x: 100, y: 200, w: 250, h: 180 }
  const after = { ...before, x: 10, y: 20 }
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: 'revision',
    relationships: [],
    images: [{ id: 1, width: 640, height: 480, geometry: stored }],
  } as never)
  const write = spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockResolvedValue(undefined as never)
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  owner.setMode('edit')
  const noOp = await reserveCanvasOperation(owner, (context) =>
    owner.commitDisplayedLayout(context, board, [before], [before], () => {
      throw new Error('no-op published')
    })
  )
  expect(noOp.status).toBe('success')
  expect(write).not.toHaveBeenCalled()
  const toView = owner.submit(
    { kind: 'mode', target: 'view' },
    async (context) => context.setMode('view')
  )
  const arrange = reserveCanvasOperation(owner, (context) =>
    owner.commitDisplayedLayout(context, board, [before], [after], () => {
      throw new Error('View published')
    })
  )
  expect((await toView).status).toBe('success')
  expect(await arrange).toMatchObject({ status: 'rejected' })
  expect(write).not.toHaveBeenCalled()
  const toEdit = await owner.submit(
    { kind: 'mode', target: 'edit' },
    async (context) => context.setMode('edit')
  )
  expect(toEdit.status).toBe('success')
  await refreshBoard(owner)
  const obsolete = await reserveCanvasOperation(
    owner,
    (context) =>
      owner.commitDisplayedLayout(context, board, [before], [after], () => {}),
    'geometry',
    board
  )
  expect(obsolete).toMatchObject({ status: 'rejected' })
  expect(write).not.toHaveBeenCalled()
  owner.dispose()
})

it('rejects a graph change while a guarded layout write is pending', async () => {
  const stored = { imageId: 1, x: 0, y: 0, w: 150, h: 110 }
  const after = { ...stored, x: 20 }
  let revision = 'old'
  let release = () => {}
  let started = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writing = new Promise<void>((resolve) => {
    started = resolve
  })
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision,
        relationships: [],
        images: [{ id: 1, width: 640, height: 480, geometry: stored }],
      }) as never
  )
  spyOn(ImageService, 'SetGeometryFromDisplayAtRevision').mockImplementation(
    async (_path, expectedRevision) => {
      started()
      await gate
      if (revision !== expectedRevision) throw new Error('stale revision')
      return undefined as never
    }
  )
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  owner.setMode('edit')
  const accept = mock(() => {})
  const operation = reserveCanvasOperation(owner, (context) =>
    owner.commitDisplayedLayout(context, board, [stored], [after], accept)
  )
  await writing
  revision = 'changed graph'
  const refresh = owner.refresh()
  release()
  expect(await operation).toMatchObject({ status: 'failed' })
  await refresh
  expect(accept).not.toHaveBeenCalled()
  expect(owner.getSnapshot()?.snapshot.revision).toBe('changed graph')
  owner.dispose()
})
