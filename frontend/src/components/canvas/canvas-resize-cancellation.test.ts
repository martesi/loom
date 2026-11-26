import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'

const rectangle = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
const resized = { imageId: 1, x: 1, y: 2, w: 300, h: 200 }

function mockSnapshot() {
  spyOn(ImageService, 'LoadCanvas').mockImplementation(
    () => Promise.resolve({ images: [{ id: 1 }], groups: [] }) as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '1',
        images: [{ id: 1, width: 640, height: 480, geometry: rectangle }],
        relationships: [],
      }) as never
  )
  return spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockImplementation(() => Promise.resolve() as never)
}

afterEach(() => mock.restore())

it('rejects a queued resize if a graph refresh wins before dispatch', async () => {
  const write = mockSnapshot()
  const owner = createCanvasBoardOwner('/repo')
  const board = await owner.refresh()
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = owner.execute(() => blocked)
  const gesture = owner.beginResize(board, rectangle)
  expect(gesture).not.toBeNull()
  if (!gesture) throw new Error('missing gesture')
  const pending = owner.endResize(gesture, resized)
  await owner.refresh()
  release()
  await Promise.all([first, pending])
  expect(write).not.toHaveBeenCalled()
})

it('ignores resize callbacks after the repository owner is disposed', async () => {
  const write = mockSnapshot()
  const owner = createCanvasBoardOwner('/one')
  const board = await owner.refresh()
  const gesture = owner.beginResize(board, rectangle)
  expect(gesture).not.toBeNull()
  if (!gesture) throw new Error('missing gesture')
  owner.dispose()
  const next = createCanvasBoardOwner('/two')
  await next.refresh()
  await owner.endResize(gesture, resized)
  expect(write).not.toHaveBeenCalled()
})
