import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import {
  type GeometryUpdate,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'

const before: GeometryUpdate = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
const after: GeometryUpdate = { ...before, x: 40, w: 180 }

function setup(coordinateRepository = false) {
  const load = spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
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
  return {
    owner: createCanvasBoardOwner('/repo', coordinateRepository),
    write,
    load,
  }
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

it('reconciles a replacement owner after an old in-flight write settles', async () => {
  const { owner: oldOwner, write, load } = setup(true)
  const board = await oldOwner.refresh()
  oldOwner.setMode('edit')
  let signalWriteStarted = () => {}
  let releaseWrite = () => {}
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve
  })
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  write.mockImplementationOnce(async () => {
    signalWriteStarted()
    await writeGate
  })
  const token = oldOwner.beginResize(
    board,
    before,
    'se',
    7,
    () => {},
    () => {}
  )
  if (token === null) throw new Error('resize was rejected')
  const submitted = oldOwner.endResize(token, 7, after)
  await writeStarted
  oldOwner.dispose()

  const replacement = createCanvasBoardOwner('/repo', true)
  const initialLoads = load.mock.calls.length
  const refreshed = replacement.refresh()
  await Promise.resolve()
  expect(load).toHaveBeenCalledTimes(initialLoads)
  expect(
    replacement.beginResize(
      null,
      before,
      'se',
      8,
      () => {},
      () => {}
    )
  ).toBeNull()
  releaseWrite()
  await submitted
  const freshBoard = await refreshed
  expect(freshBoard).not.toBeNull()
  expect(load).toHaveBeenCalledTimes(initialLoads + 1)
  replacement.setMode('edit')
  expect(
    replacement.beginResize(
      freshBoard,
      before,
      'se',
      8,
      () => {},
      () => {}
    )
  ).not.toBeNull()
  replacement.dispose()
})

it('keeps a reactivated owner fenced until its old in-flight write settles', async () => {
  const { owner, write, load } = setup(true)
  const board = await owner.refresh()
  owner.setMode('edit')
  let signalWriteStarted = () => {}
  let releaseWrite = () => {}
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve
  })
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  write.mockImplementationOnce(async () => {
    signalWriteStarted()
    await writeGate
  })
  const token = owner.beginResize(
    board,
    before,
    'se',
    7,
    () => {},
    () => {}
  )
  if (token === null) throw new Error('resize was rejected')
  const submitted = owner.endResize(token, 7, after)
  await writeStarted
  owner.dispose()
  owner.activate()
  expect(
    owner.beginResize(
      board,
      before,
      'se',
      8,
      () => {},
      () => {}
    )
  ).toBeNull()
  releaseWrite()
  await submitted
  const refreshed = await owner.refresh()
  expect(refreshed).not.toBeNull()
  expect(load.mock.calls.length).toBeGreaterThanOrEqual(2)
  owner.setMode('edit')
  expect(
    owner.beginResize(
      refreshed,
      before,
      'se',
      9,
      () => {},
      () => {}
    )
  ).not.toBeNull()
  owner.dispose()
})

it('blocks gestures after reconciliation failure until a later refresh succeeds', async () => {
  const { owner, load } = setup()
  const board = await owner.refresh()
  owner.setMode('edit')
  load.mockRejectedValueOnce(new Error('reconciliation failed'))
  await expect(
    owner.admit(async () => {
      throw new Error('backend write failed')
    })
  ).rejects.toThrow('Canvas could not be reconciled')
  expect(owner.beginDrag(board, [before])).toBeNull()
  const fresh = await owner.refresh()
  expect(fresh).not.toBeNull()
  owner.setMode('edit')
  expect(
    owner.beginResize(
      fresh,
      before,
      'se',
      10,
      () => {},
      () => {}
    )
  ).not.toBeNull()
  owner.dispose()
})

it('records View intent synchronously and preserves rapid View-to-Edit FIFO', async () => {
  const { owner } = setup()
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
  const viewTicket = owner.beginModeTransition('view')
  const view = owner.admit(async () => owner.setMode('view'), false)
  expect(
    owner.beginResize(
      board,
      before,
      'se',
      7,
      () => {},
      () => {}
    )
  ).toBeNull()
  owner.beginModeTransition('edit')
  const edit = owner.admit(async () => owner.setMode('edit'), false)
  release()
  await Promise.all([blocker, view, edit])
  expect(owner.getMode()).toBe('edit')
  expect(owner.allows('geometry')).toBe(true)
  owner.cancelModeTransition(viewTicket)
  owner.dispose()
})

it('clears a failed pending mode intent so later geometry can recover', async () => {
  const { owner } = setup()
  const board = await owner.refresh()
  owner.setMode('edit')
  const ticket = owner.beginModeTransition('view')
  await expect(
    owner.admit(async () => {
      throw new Error('projection failed')
    }, false)
  ).rejects.toThrow('projection failed')
  owner.cancelModeTransition(ticket)
  expect(owner.getMode()).toBe('edit')
  expect(
    owner.beginResize(
      board,
      before,
      'se',
      8,
      () => {},
      () => {}
    )
  ).not.toBeNull()
  owner.dispose()
})

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
    await block.blocked
    await submitted
    expect(write).not.toHaveBeenCalled()
    expect(owner.isLayoutPending()).toBe(false)
  })
}
