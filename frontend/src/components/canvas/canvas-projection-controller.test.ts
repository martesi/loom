import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Edge, Node, Viewport } from '@xyflow/react'
import { StrictMode, useEffect, useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { unwrapCanvasOutcome } from './canvas-operation'
import { useCanvasProjectionController } from './use-canvas-projection-controller'

afterEach(() => {
  cleanup()
  mock.restore()
})

const nodes: Node[] = ['a', 'a1', 'a2', 'b', 'b1', 'b2', 'c', 'c1'].map(
  (id) => ({ id, position: { x: 0, y: 0 }, width: 150, height: 110, data: {} })
)
const edge = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
})
const initialEdges = [
  edge('a', 'a', 'a1'),
  edge('b', 'b', 'b1'),
  edge('c', 'c', 'c1'),
]
const orders = new Map([
  ['a', 1],
  ['a2', 4],
  ['b', 2],
  ['b2', 5],
  ['c', 3],
])

function setupOwner() {
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [],
    relationships: [],
  } as never)
  return createCanvasBoardOwner('/repo')
}

async function loadBoard(owner: ReturnType<typeof createCanvasBoardOwner>) {
  const board = unwrapCanvasOutcome(await owner.refresh())
  if (!board) throw new Error('missing board')
  return board
}

function reserveGeometry(
  owner: ReturnType<typeof createCanvasBoardOwner>,
  action: () => Promise<void>
) {
  return owner.submit(
    { kind: 'mutation', capability: 'geometry', board: owner.getSnapshot() },
    action
  )
}

for (const explicit of [false, true])
  it(`${explicit ? 'preserves an explicit anchor' : 'uses the current viewport center'} after panning between compensated layouts`, async () => {
    const owner = setupOwner()
    const board = await loadBoard(owner)
    let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
    const flow = {
      getViewport: () => viewport,
      setViewport: async (next: Viewport) => {
        viewport = next
        return true
      },
    }
    const { result } = renderHook(() => {
      const [display, setNodes] = useState<Node[]>([])
      const controller = useCanvasProjectionController({
        owner,
        nodes: display,
        setNodes,
        setEdges: () => {},
        host: { current: null },
        flow,
        report: mock(),
        reconcileSelection: mock(),
      })
      return { controller, display }
    })
    const reconcile = (edges: Edge[]) =>
      result.current.controller.reconcile(
        board,
        { nodes, edges, pairingOrders: orders },
        []
      )
    act(() => {
      reconcile(initialEdges)
    })
    await act(async () => {
      await result.current.controller.transitionMode('view')
    })
    const position = (id: string) => {
      const node = result.current.display.find((item) => item.id === id)
      if (!node) throw new Error(`missing ${id}`)
      return node.position
    }
    viewport = { x: -position('b').x, y: -position('b').y, zoom: 1 }
    act(() => result.current.controller.updateViewport(viewport))
    if (explicit) act(() => result.current.controller.setAnchor(position('b')))
    const extendedA = [...initialEdges, edge('a2', 'a', 'a2')]
    act(() => {
      reconcile(extendedA)
    })
    viewport = { x: -position('c').x * 2, y: -position('c').y * 2, zoom: 2 }
    act(() => result.current.controller.updateViewport(viewport))
    const target = explicit ? 'b' : 'c'
    const before = {
      x: position(target).x * viewport.zoom + viewport.x,
      y: position(target).y * viewport.zoom + viewport.y,
    }
    act(() => {
      reconcile([...extendedA, edge('b2', 'b', 'b2')])
    })
    expect({
      x: position(target).x * viewport.zoom + viewport.x,
      y: position(target).y * viewport.zoom + viewport.y,
    }).toEqual(before)
  })

for (const ending of ['unmount', 'owner change'] as const) {
  for (const strict of [false, true]) {
    it(`drops a transition queued behind refresh on ${ending}${strict ? ' in StrictMode' : ''}`, async () => {
      const owner = setupOwner()
      const board = await loadBoard(owner)
      const setNodes = mock(() => {})
      const setEdges = mock(() => {})
      const setViewport = mock(async (_viewport: Viewport) => true)
      const flow = { getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport }
      const hook = renderHook(
        ({ currentOwner }) =>
          useCanvasProjectionController({
            owner: currentOwner,
            nodes: [],
            setNodes,
            setEdges,
            host: { current: null },
            flow,
            report: mock(),
            reconcileSelection: mock(),
          }),
        {
          initialProps: { currentOwner: owner },
          wrapper: strict ? StrictMode : undefined,
        }
      )
      act(() => {
        hook.result.current.reconcile(
          board,
          { nodes, edges: initialEdges, pairingOrders: orders },
          []
        )
      })
      await act(async () => {
        await hook.result.current.transitionMode('view')
      })
      setNodes.mockClear()
      setEdges.mockClear()
      setViewport.mockClear()
      let release: (value: never) => void = () => {}
      spyOn(ImageService, 'LoadCanvas').mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const refresh = owner.refresh()
      await act(async () => {
        await Promise.resolve()
      })
      const transition = hook.result.current.transitionMode('edit')
      if (ending === 'unmount') hook.unmount()
      else hook.rerender({ currentOwner: createCanvasBoardOwner('/other') })
      owner.dispose()
      await act(async () => {
        release({ images: [], relationships: [], groups: [] } as never)
        await refresh
        await transition
      })
      expect(setNodes).not.toHaveBeenCalled()
      expect(setEdges).not.toHaveBeenCalled()
      expect(setViewport).not.toHaveBeenCalled()
    })
  }
}

it('invalidates the first StrictMode effect lifetime without cancelling the second', async () => {
  const owner = setupOwner()
  const board = await loadBoard(owner)
  let release = () => {}
  const blocker = reserveGeometry(
    owner,
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await act(async () => {
    await Promise.resolve()
  })
  const setNodes = mock(() => {})
  const setEdges = mock(() => {})
  const setViewport = mock(async (_viewport: Viewport) => true)
  const flow = { getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport }
  const transitions: Promise<void>[] = []
  renderHook(
    () => {
      const controller = useCanvasProjectionController({
        owner,
        nodes: [],
        setNodes,
        setEdges,
        host: { current: null },
        flow,
        report: mock(),
        reconcileSelection: mock(),
      })
      // biome-ignore lint/correctness/useExhaustiveDependencies: exercise the two StrictMode mount lifetimes only.
      useEffect(() => {
        controller.reconcile(
          board,
          { nodes, edges: initialEdges, pairingOrders: orders },
          []
        )
        transitions.push(controller.transitionMode('view'))
      }, [])
    },
    { wrapper: StrictMode }
  )
  expect(transitions).toHaveLength(2)
  await act(async () => {
    release()
    expect((await blocker).status).toBe('success')
    await Promise.all(transitions)
  })
  expect(setNodes).toHaveBeenCalledTimes(1)
  expect(setEdges).toHaveBeenCalledTimes(1)
  expect(setViewport).toHaveBeenCalledTimes(1)
})
