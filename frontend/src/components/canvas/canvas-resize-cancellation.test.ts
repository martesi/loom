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

it('preserves a submitted resize across a graph refresh before dispatch', async () => {
  const write = mockSnapshot()
  const owner = createCanvasBoardOwner('/repo')
  const board = await owner.refresh()
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = owner.execute(() => blocked)
  const token = owner.beginResize(
    board,
    rectangle,
    'nw',
    1,
    () => {},
    () => {}
  )
  expect(token).not.toBeNull()
  if (token === null) throw new Error('missing gesture')
  const pending = owner.endResize(token, 1, resized)
  await owner.refresh()
  release()
  await Promise.all([first, pending])
  expect(write).toHaveBeenCalledTimes(1)
})

it('ignores resize callbacks after the repository owner is disposed', async () => {
  const write = mockSnapshot()
  const owner = createCanvasBoardOwner('/one')
  const board = await owner.refresh()
  const token = owner.beginResize(
    board,
    rectangle,
    'nw',
    1,
    () => {},
    () => {}
  )
  expect(token).not.toBeNull()
  if (token === null) throw new Error('missing gesture')
  owner.dispose()
  const next = createCanvasBoardOwner('/two')
  await next.refresh()
  await owner.endResize(token, 1, resized)
  expect(write).not.toHaveBeenCalled()
})
