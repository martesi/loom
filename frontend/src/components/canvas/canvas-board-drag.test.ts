import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Node } from '@xyflow/react'
import { useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
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
  const owner = createCanvasBoardOwner('/drag-committed-batch')
  const board = await owner.refresh()
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
    '/drag-committed-batch',
    '5',
    [{ ...first, w: null, h: null }, second],
    [first, second],
    after
  )
})

it('rejects a late stop after cancellation or refresh', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/drag-cancelled-gestures')
  const board = await owner.refresh()
  const cancelled = owner.beginDrag(board, [first])
  if (!cancelled) throw new Error('missing drag')
  owner.cancelGesture()
  await owner.endDrag(cancelled, [{ ...first, x: 30 }])
  const stale = owner.beginDrag(board, [first])
  if (!stale) throw new Error('missing drag')
  await owner.refresh()
  await owner.endDrag(stale, [{ ...first, x: 30 }])
  expect(write).not.toHaveBeenCalled()
})

it('keeps a completed drag queued across a renderer-only rerender', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/drag-stale-revision')
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  let release = () => {}
  const blocked = owner.execute(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await Promise.resolve()
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
  act(() => {
    result.current.start(nodes)
    const gesture = result.current.take()
    if (!gesture) throw new Error('missing gesture')
    result.current.finish(
      gesture,
      nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 25, y: node.position.y + 15 },
      }))
    )
  })
  rerender({ generation: 1 })
  expect(write).not.toHaveBeenCalled()
  await act(async () => {
    release()
    await blocked
    await owner.execute(async () => {})
  })
  expect(write).toHaveBeenCalledWith(
    '/drag-stale-revision',
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

it('discards a completed queued drag when a refresh wins before dispatch', async () => {
  const write = setup()
  const owner = createCanvasBoardOwner('/drag-refresh-before-dispatch')
  const board = await owner.refresh()
  let release = () => {}
  const blocked = owner.execute(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const drag = owner.beginDrag(board, [first])
  if (!drag) throw new Error('missing drag')
  const pending = owner.endDrag(drag, [{ ...first, x: 30 }])
  await owner.refresh()
  release()
  await Promise.all([blocked, pending])
  expect(write).not.toHaveBeenCalled()
})

it('restores cancelled displayed positions and ignores later pointer changes', async () => {
  setup()
  const owner = createCanvasBoardOwner('/drag-cancelled-display')
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
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
  const error = new Error('stale layout revision')
  write.mockImplementation(() => Promise.reject(error) as never)
  const owner = createCanvasBoardOwner('/drag-stale-rejected')
  const board = await owner.refresh()
  const drag = owner.beginDrag(board, [first])
  if (!drag) throw new Error('missing drag')
  await expect(owner.endDrag(drag, [{ ...first, x: 30 }])).rejects.toBe(error)
  expect(ImageService.LoadCanvas).toHaveBeenCalledTimes(2)
})
