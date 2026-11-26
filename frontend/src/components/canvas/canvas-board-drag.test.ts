import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Call } from '@wailsio/runtime'
import type { Node } from '@xyflow/react'
import { useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import {
  refreshBoard,
  reserveCanvasRead,
} from './canvas-operation-test-utils.test'
import { useCanvasBoardDrag } from './use-canvas-board-drag'

const first = { imageId: 1, x: 10, y: 20, w: 150, h: 110 }
const second = { imageId: 2, x: 200, y: 30, w: 230, h: 170 }

function setup() {
  spyOn(ImageService, 'LoadCanvas').mockImplementation(
    () =>
      Promise.resolve({ images: [{ id: 1 }, { id: 2 }], groups: [] }) as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '5',
        images: [
          {
            id: 1,
            width: 640,
            height: 480,
            geometry: { ...first, w: null, h: null },
          },
          { id: 2, width: 640, height: 480, geometry: second },
        ],
        relationships: [],
      }) as never
  )
  return spyOn(
    ImageService,
    'SetGeometryFromDisplayAtRevision'
  ).mockImplementation(() => Promise.resolve() as never)
}

afterEach(() => {
  cleanup()
  mock.restore()
})

it('commits all displayed rectangles in one guarded drag batch', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  const drag = owner.beginDrag(board, [first, second])
  expect(drag).not.toBeNull()
  if (!drag) throw new Error('missing drag')
  const after = [first, second].map((item) => ({
    ...item,
    x: item.x + 25,
    y: item.y + 15,
  }))
  await owner.endDrag(drag, after)
  expect(write).toHaveBeenCalledWith(
    '/repo',
    '5',
    [{ ...first, w: null, h: null }, second],
    [first, second],
    after
  )
})

it('rejects a late stop after cancellation or refresh', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  const cancelled = owner.beginDrag(board, [first])
  if (!cancelled) throw new Error('missing drag')
  owner.cancelGesture()
  await owner.endDrag(cancelled, [{ ...first, x: 30 }])
  const stale = owner.beginDrag(board, [first])
  if (!stale) throw new Error('missing drag')
  await refreshBoard(owner)
  expect(await owner.endDrag(stale, [{ ...first, x: 30 }])).toMatchObject({
    status: 'cancelled',
  })
  expect(write).not.toHaveBeenCalled()
})

it('keeps a completed drag queued across a renderer-only rerender', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  const nodes: Node[] = [
    {
      id: '1',
      type: 'image',
      position: { x: 10, y: 20 },
      width: 150,
      height: 110,
      data: {},
    },
    {
      id: '2',
      type: 'image',
      position: { x: 200, y: 30 },
      measured: { width: 230, height: 170 },
      data: {},
    },
  ]
  const report = mock()
  const { result, rerender } = renderHook(
    ({ generation }) => {
      void generation
      return useCanvasBoardDrag(owner, board.data, report, () => {})
    },
    { initialProps: { generation: 0 } }
  )
  let drag: ReturnType<typeof owner.beginDrag> = null
  act(() => {
    result.current.start(nodes)
    drag = result.current.take()
  })
  if (!drag) throw new Error('missing drag')
  let release = () => {}
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const blocked = reserveCanvasRead(owner, async () => {
    signalStarted()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await started
  act(() => {
    result.current.finish(
      drag,
      nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 25, y: node.position.y + 15 },
      }))
    )
  })
  act(() => rerender({ generation: 1 }))
  expect(write).not.toHaveBeenCalled()
  await act(async () => {
    release()
    expect((await blocked).status).toBe('success')
  })
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  expect(write).toHaveBeenCalledWith(
    '/repo',
    '5',
    [{ ...first, w: null, h: null }, second],
    [first, second],
    [
      { ...first, x: 35, y: 35 },
      { ...second, x: 225, y: 45 },
    ]
  )
  expect(report).not.toHaveBeenCalled()
})

it('preserves a completed queued drag when refresh wins before dispatch', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  const drag = owner.beginDrag(board, [first])
  if (!drag) throw new Error('missing drag')
  let release = () => {}
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const blocked = reserveCanvasRead(owner, async () => {
    signalStarted()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await started
  const pending = owner.endDrag(drag, [{ ...first, x: 30 }])
  const refresh = owner.refresh()
  release()
  expect((await blocked).status).toBe('success')
  expect((await pending).status).toBe('success')
  await refresh
  expect(write).toHaveBeenCalledTimes(1)
})

it('restores cancelled displayed positions and ignores later pointer changes', async () => {
  setup()
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  const initial: Node[] = [
    {
      id: '1',
      type: 'image',
      position: { x: 10, y: 20 },
      width: 150,
      height: 110,
      data: {},
    },
  ]
  const { result } = renderHook(() => {
    const [nodes, setNodes] = useState(initial)
    const drag = useCanvasBoardDrag(owner, board.data, mock(), setNodes)
    return { drag, nodes, setNodes }
  })
  act(() => {
    result.current.drag.start(initial)
    result.current.setNodes([{ ...initial[0], position: { x: 40, y: 50 } }])
  })
  act(() => owner.cancelGesture())
  expect(result.current.nodes[0].position).toEqual(initial[0].position)
  expect(
    result.current.drag.filterChanges([
      { type: 'position', id: '1', position: { x: 80, y: 90 } },
    ])
  ).toEqual([])
  expect(result.current.drag.take()).toBeNull()
})

it('reloads and reports a rejected stale drag write', async () => {
  const write = setup()
  const error = new Call.RuntimeError('stale layout revision')
  write.mockImplementation(() => Promise.reject(error) as never)
  const owner = createCanvasBoardOwner('/repo')
  const board = await refreshBoard(owner)
  const drag = owner.beginDrag(board, [first])
  if (!drag) throw new Error('missing drag')
  const outcome = await owner.endDrag(drag, [{ ...first, x: 30 }])
  expect(outcome).toMatchObject({ status: 'failed' })
  if (outcome.status === 'failed')
    expect(outcome.error.message).toContain(error.message)
  expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(2)
})
