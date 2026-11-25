import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import {
  type GeometryUpdate,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'

const before: GeometryUpdate = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
const after: GeometryUpdate = { ...before, x: 40, w: 180 }

function setup() {
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
  const write = spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockResolvedValue(undefined as never)
  return { owner: createCanvasBoardOwner('/repo'), write }
}

function makeQueueBlock(owner: ReturnType<typeof createCanvasBoardOwner>) {
  let release = () => {}
  let started = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const blocked = owner.execute(async () => {
    started()
    await gate
  })
  return { blocked, ready, release }
}

function submitGeometry(
  owner: ReturnType<typeof createCanvasBoardOwner>,
  board: NonNullable<ReturnType<typeof owner.getSnapshot>>,
  kind: 'resize' | 'drag'
) {
  if (kind === 'drag') {
    const gesture = owner.beginDrag(board, [before])
    if (!gesture) throw new Error('drag was rejected')
    return owner.endDrag(gesture, [after])
  }
  const token = owner.beginResize(
    board,
    before,
    'se',
    7,
    () => {},
    () => {}
  )
  if (token === null) throw new Error('resize was rejected')
  return owner.endResize(token, 7, after)
}

afterEach(() => mock.restore())

for (const kind of ['resize', 'drag'] as const) {
  it(`reserves layout as soon as a queued ${kind} is submitted`, async () => {
    const { owner, write } = setup()
    const board = await owner.refresh()
    owner.setMode('edit')
    const block = makeQueueBlock(owner)
    await block.ready
    const submitted = submitGeometry(owner, board, kind)

    expect(owner.isLayoutPending()).toBe(true)
    expect(
      owner.beginResize(
        board,
        before,
        'e',
        8,
        () => {},
        () => {}
      )
    ).toBeNull()
    expect(owner.beginDrag(board, [before])).toBeNull()
    owner.beginModeTransition()
    owner.setMode('view')
    await owner.refresh()
    block.release()
    await Promise.all([block.blocked, submitted])
    expect(write).toHaveBeenCalledTimes(1)
    expect(owner.isLayoutPending()).toBe(false)
    let continued = false
    await owner.execute(async () => {
      continued = true
    })
    expect(continued).toBe(true)
    owner.dispose()
  })
}

for (const kind of ['resize', 'drag'] as const) {
  it(`releases a queued ${kind} reservation after write failure and continues`, async () => {
    const { owner, write } = setup()
    const board = await owner.refresh()
    owner.setMode('edit')
    let release = () => {}
    let started = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocker = owner.execute(async () => {
      started()
      await gate
    })
    await ready
    write.mockRejectedValueOnce(new Error('write failed'))
    const submitted = submitGeometry(owner, board, kind)
    expect(owner.isLayoutPending()).toBe(true)
    release()
    await blocker
    await expect(submitted).rejects.toThrow('write failed')
    expect(owner.isLayoutPending()).toBe(false)
    let continued = false
    await owner.execute(async () => {
      continued = true
    })
    expect(continued).toBe(true)
    owner.dispose()
  })
}

for (const kind of ['resize', 'drag'] as const) {
  it(`releases a queued ${kind} reservation when owner disposal cancels dispatch`, async () => {
    const { owner, write } = setup()
    const board = await owner.refresh()
    const block = makeQueueBlock(owner)
    await block.ready
    const submitted = submitGeometry(owner, board, kind)
    expect(owner.isLayoutPending()).toBe(true)
    owner.dispose()
    expect(owner.isLayoutPending()).toBe(false)
    block.release()
    await Promise.all([block.blocked, submitted])
    expect(write).not.toHaveBeenCalled()
    expect(owner.isLayoutPending()).toBe(false)
  })
}
