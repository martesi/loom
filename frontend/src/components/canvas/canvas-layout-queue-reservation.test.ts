import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import {
  type GeometryUpdate,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { refreshBoard, reserveCanvasRead } from './canvas-operation-test-utils'

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
  const blocked = reserveCanvasRead(owner, async () => {
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

async function setMode(
  owner: ReturnType<typeof createCanvasBoardOwner>,
  mode: 'view' | 'edit'
) {
  return owner.submit({ kind: 'mode', target: mode }, async (context) =>
    context.setMode(mode)
  )
}

afterEach(() => mock.restore())

for (const kind of ['resize', 'drag'] as const) {
  it(`reserves layout as soon as a queued ${kind} is submitted`, async () => {
    const { owner, write } = setup()
    const board = await refreshBoard(owner)
    expect((await setMode(owner, 'edit')).status).toBe('success')
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
    owner.beginModeTransition('view')
    const mode = owner.submit(
      { kind: 'mode', target: 'view' },
      async (context) => context.setMode('view')
    )
    const refresh = owner.refresh()
    block.release()
    expect((await block.blocked).status).toBe('success')
    expect((await submitted).status).toBe('cancelled')
    expect((await mode).status).toBe('success')
    await refresh
    expect(write).not.toHaveBeenCalled()
    expect(owner.isLayoutPending()).toBe(false)
    let continued = false
    expect(
      (
        await reserveCanvasRead(owner, async () => {
          continued = true
        })
      ).status
    ).toBe('success')
    expect(continued).toBe(true)
    owner.dispose()
  })
}

it('reconciles a replacement owner after an old in-flight write settles', async () => {
  const { owner: oldOwner, write, load } = setup(true)
  const board = await refreshBoard(oldOwner)
  expect((await setMode(oldOwner, 'edit')).status).toBe('success')
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
  const refreshed = replacement.activate()
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
  expect((await submitted).status).toBe('cancelled')
  expect((await refreshed).status).toBe('success')
  const freshBoard = replacement.getSnapshot()
  expect(freshBoard).not.toBeNull()
  expect(load).toHaveBeenCalledTimes(initialLoads + 1)
  expect((await setMode(replacement, 'edit')).status).toBe('success')
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
  const board = await refreshBoard(owner)
  expect((await setMode(owner, 'edit')).status).toBe('success')
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
  const activation = owner.activate()
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
  expect((await submitted).status).toBe('cancelled')
  expect((await activation).status).toBe('success')
  const refreshed = owner.getSnapshot()
  expect(refreshed).not.toBeNull()
  expect(load.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect((await setMode(owner, 'edit')).status).toBe('success')
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
  const board = await refreshBoard(owner)
  expect((await setMode(owner, 'edit')).status).toBe('success')
  load.mockRejectedValueOnce(new Error('reconciliation failed'))
  const outcome = await owner.submit(
    { kind: 'mutation', capability: 'geometry', board },
    (context) =>
      context.effect(async () => {
        throw new Error('backend write failed')
      })
  )
  expect(outcome).toMatchObject({ status: 'failed' })
  if (outcome.status === 'failed')
    expect(outcome.error.message).toContain('reconciliation failed')
  expect(owner.beginDrag(board, [before])).toBeNull()
  const fresh = await refreshBoard(owner)
  expect(fresh).not.toBeNull()
  expect((await setMode(owner, 'edit')).status).toBe('success')
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
  const board = await refreshBoard(owner)
  expect((await setMode(owner, 'edit')).status).toBe('success')
  let release = () => {}
  let started = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const blocker = reserveCanvasRead(owner, async () => {
    started()
    await gate
  })
  await ready
  const viewTicket = owner.beginModeTransition('view')
  const view = setMode(owner, 'view')
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
  const edit = setMode(owner, 'edit')
  release()
  expect((await blocker).status).toBe('success')
  expect((await view).status).toBe('success')
  expect((await edit).status).toBe('success')
  expect(owner.getMode()).toBe('edit')
  expect(owner.allows('geometry')).toBe(true)
  owner.cancelModeTransition(viewTicket)
  owner.dispose()
})

it('clears a failed pending mode intent so later geometry can recover', async () => {
  const { owner } = setup()
  const board = await refreshBoard(owner)
  expect((await setMode(owner, 'edit')).status).toBe('success')
  const ticket = owner.beginModeTransition('view')
  expect(
    await owner.submit({ kind: 'mode', target: 'view' }, async () => {
      throw new Error('projection failed')
    })
  ).toMatchObject({ status: 'failed' })
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
    const board = await refreshBoard(owner)
    expect((await setMode(owner, 'edit')).status).toBe('success')
    let release = () => {}
    let started = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocker = reserveCanvasRead(owner, async () => {
      started()
      await gate
    })
    await ready
    write.mockRejectedValueOnce(new Error('write failed'))
    const submitted = submitGeometry(owner, board, kind)
    expect(owner.isLayoutPending()).toBe(true)
    release()
    expect((await blocker).status).toBe('success')
    expect(await submitted).toMatchObject({ status: 'failed' })
    expect(owner.isLayoutPending()).toBe(false)
    let continued = false
    expect(
      (
        await reserveCanvasRead(owner, async () => {
          continued = true
        })
      ).status
    ).toBe('success')
    expect(continued).toBe(true)
    owner.dispose()
  })
}

for (const kind of ['resize', 'drag'] as const) {
  it(`releases a queued ${kind} reservation when owner disposal cancels dispatch`, async () => {
    const { owner, write } = setup()
    const board = await refreshBoard(owner)
    const block = makeQueueBlock(owner)
    await block.ready
    const submitted = submitGeometry(owner, board, kind)
    expect(owner.isLayoutPending()).toBe(true)
    owner.dispose()
    expect(owner.isLayoutPending()).toBe(true)
    block.release()
    expect((await block.blocked).status).toBe('cancelled')
    expect(await submitted).toMatchObject({ status: 'cancelled' })
    expect(write).not.toHaveBeenCalled()
    expect(owner.isLayoutPending()).toBe(false)
  })
}
