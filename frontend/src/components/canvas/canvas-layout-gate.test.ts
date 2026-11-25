import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'

afterEach(() => mock.restore())

it('blocks new geometry gestures until a pending layout settles', async () => {
  const before = { imageId: 1, x: 0, y: 0, w: 150, h: 110 }
  const after = { ...before, x: 100 }
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
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    relationships: [],
    images: [{ id: 1, width: 640, height: 480, geometry: before }],
  } as never)
  spyOn(ImageService, 'SetGeometryFromDisplayAtRevision').mockImplementation(
    async () => {
      started()
      await gate
      return undefined as never
    }
  )
  const owner = createCanvasBoardOwner('/repo')
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  owner.setMode('edit')
  const operation = owner.execute(() =>
    owner.commitDisplayedLayout(board, [before], [after], () => {})
  )
  await writing
  const drag = owner.beginDrag(board, [before])
  const resize = owner.beginResize(
    board,
    before,
    'nw',
    1,
    () => {},
    () => {}
  )
  release()
  await operation
  expect(drag).toBeNull()
  expect(resize).toBeNull()
  expect(owner.beginDrag(owner.getSnapshot(), [after])).not.toBeNull()
  owner.dispose()
})
