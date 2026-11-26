import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Edge, Node, Viewport } from '@xyflow/react'
import { StrictMode, useEffect, useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { writeCanvasModeViewport } from './canvas-mode-viewport'
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

function setupOwner(repoPath = '/repo') {
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
  return createCanvasBoardOwner(repoPath)
}

for (const explicit of [false, true])
  it(`${explicit ? 'preserves an explicit anchor' : 'uses the current viewport center'} after panning between compensated layouts`, async () => {
    const owner = setupOwner()
    const board = await owner.refresh()
    if (!board) throw new Error('missing board')
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
    await act(async () => {
      await result.current.controller.updateViewport(viewport, 'user', 'end')
    })
    if (explicit) act(() => result.current.controller.setAnchor(position('b')))
    const extendedA = [...initialEdges, edge('a2', 'a', 'a2')]
    act(() => {
      reconcile(extendedA)
    })
    viewport = { x: -position('c').x * 2, y: -position('c').y * 2, zoom: 2 }
    await act(async () => {
      await result.current.controller.updateViewport(viewport, 'user', 'end')
    })
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
      const board = await owner.refresh()
      if (!board) throw new Error('missing board')
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
      const refresh = owner.execute(() => owner.refresh())
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
  owner.setRepositoryViewport({ x: -25, y: 40, zoom: 1.25 })
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  let release = () => {}
  const blocker = owner.execute(
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
    await blocker
    await Promise.all(transitions)
  })
  expect(setNodes).toHaveBeenCalledTimes(1)
  expect(setEdges).toHaveBeenCalledTimes(1)
  expect(setViewport).toHaveBeenCalledTimes(1)
})

it('keeps a saved restore target through early flow feedback and graph refresh', async () => {
  const owner = setupOwner()
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  const saved = { x: -180, y: 95, zoom: 1.4 }
  owner.setRepositoryViewport(saved)
  writeCanvasModeViewport('/repo', 'view', saved)
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
  const setViewport = mock(async (next: Viewport) => {
    viewport = next
    return true
  })
  const flow = {
    getViewport: () => viewport,
    setViewport,
    fitView: mock(async () => true),
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
      startInView: true,
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
    result.current.controller.updateViewport(viewport, 'external', 'move')
    reconcile([...initialEdges, edge('a2', 'a', 'a2')])
  })
  expect(setViewport).not.toHaveBeenCalled()
  await act(async () => result.current.controller.onFlowReady())
  await waitFor(() => expect(setViewport).toHaveBeenCalledTimes(1))
  expect(setViewport).toHaveBeenCalledWith(saved)
  expect(viewport).toEqual(saved)
})

it('lets a user pan supersede a delayed saved restore', async () => {
  const owner = setupOwner()
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  const saved = { x: -200, y: 85, zoom: 1.4 }
  const userViewport = { x: 42, y: -77, zoom: 0.9 }
  owner.setRepositoryViewport(saved)
  writeCanvasModeViewport('/repo', 'view', saved)
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
  const pending: Array<{
    next: Viewport
    resolve: (applied: boolean) => void
  }> = []
  const setViewport = (next: Viewport) =>
    new Promise<boolean>((resolve) =>
      pending.push({
        next,
        resolve: (applied) => {
          // XYFlow applies the requested viewport before its promise settles.
          viewport = next
          resolve(applied)
        },
      })
    )
  const flow = {
    getViewport: () => viewport,
    setViewport,
    fitView: mock(async () => true),
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
      startInView: true,
    })
    return { controller }
  })
  act(() =>
    result.current.controller.reconcile(
      board,
      { nodes, edges: initialEdges, pairingOrders: orders },
      []
    )
  )
  act(() => result.current.controller.onFlowReady())
  expect(pending.map(({ next }) => next)).toEqual([saved])
  let userNavigation: Promise<boolean> | undefined
  act(() => {
    result.current.controller.beginUserViewportIntent()
    userNavigation = result.current.controller.updateViewport(
      userViewport,
      'user',
      'end'
    )
  })
  pending[0].resolve(true)
  await waitFor(() => expect(pending).toHaveLength(2))
  expect(pending[1].next).toEqual(userViewport)
  viewport = pending[1].next
  pending[1].resolve(true)
  await act(async () => {
    await userNavigation
  })
  expect(viewport).toEqual(userViewport)
})

it('bounds false viewport readiness retries and reports a failed restore', async () => {
  const owner = setupOwner()
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  const saved = { x: -250, y: 60, zoom: 1.6 }
  owner.setRepositoryViewport(saved)
  writeCanvasModeViewport('/repo', 'view', saved)
  const report = mock()
  const setViewport = mock(async () => false)
  const flow = {
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport,
    fitView: mock(async () => true),
  }
  const { result } = renderHook(() => {
    const controller = useCanvasProjectionController({
      owner,
      nodes: [],
      setNodes: () => {},
      setEdges: () => {},
      host: { current: null },
      flow,
      report,
      reconcileSelection: mock(),
      startInView: true,
    })
    return controller
  })
  act(() => {
    result.current.reconcile(
      board,
      { nodes, edges: initialEdges, pairingOrders: orders },
      []
    )
    result.current.onFlowReady()
  })
  await waitFor(() => expect(setViewport).toHaveBeenCalledTimes(3))
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('not ready') })
  )
})

it('tags synchronous XYFlow restore echoes as internal and does not persist them', async () => {
  const owner = setupOwner()
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  const saved = { x: -315, y: 110, zoom: 1.7 }
  owner.setRepositoryViewport(saved)
  const echo = { x: 3, y: 4, zoom: 1 }
  writeCanvasModeViewport('/repo', 'view', saved)
  let controller: ReturnType<typeof useCanvasProjectionController> | null = null
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
  const flow = {
    getViewport: () => viewport,
    setViewport: mock(async (next: Viewport) => {
      expect(controller?.getViewportOrigin(null)).toBe('restore')
      controller?.updateViewport(echo, 'restore', 'move')
      viewport = next
      return true
    }),
    fitView: mock(async () => true),
  }
  const { result } = renderHook(() => {
    const instance = useCanvasProjectionController({
      owner,
      nodes: [],
      setNodes: () => {},
      setEdges: () => {},
      host: { current: null },
      flow,
      report: mock(),
      reconcileSelection: mock(),
      startInView: true,
    })
    controller = instance
    return instance
  })
  act(() => {
    result.current.reconcile(
      board,
      { nodes, edges: initialEdges, pairingOrders: orders },
      []
    )
    result.current.onFlowReady()
  })
  await waitFor(() => expect(flow.setViewport).toHaveBeenCalledTimes(1))
  expect(viewport).toEqual(saved)
})

it('applies a newer owner viewport after an older delayed restore settles', async () => {
  const firstOwner = setupOwner()
  const secondOwner = setupOwner('/repo-two')
  const firstBoard = await firstOwner.refresh()
  const secondBoard = await secondOwner.refresh()
  if (!firstBoard || !secondBoard) throw new Error('missing board')
  const firstViewport = { x: -120, y: 35, zoom: 1.2 }
  const secondViewport = { x: 210, y: -95, zoom: 0.8 }
  firstOwner.setRepositoryViewport(firstViewport)
  secondOwner.setRepositoryViewport(secondViewport)
  writeCanvasModeViewport('/repo', 'view', firstViewport)
  writeCanvasModeViewport('/repo-two', 'view', secondViewport)
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
  const pending: Array<{
    next: Viewport
    resolve: (applied: boolean) => void
  }> = []
  const setViewport = (next: Viewport) =>
    new Promise<boolean>((resolve) =>
      pending.push({
        next,
        resolve: (applied) => {
          // XYFlow applies before the viewport promise settles.
          viewport = next
          resolve(applied)
        },
      })
    )
  const flow = {
    getViewport: () => viewport,
    setViewport,
    fitView: mock(async () => true),
  }
  const { result, rerender } = renderHook(
    ({ owner }) => {
      const controller = useCanvasProjectionController({
        owner,
        nodes: [],
        setNodes: () => {},
        setEdges: () => {},
        host: { current: null },
        flow,
        report: mock(),
        reconcileSelection: mock(),
        startInView: true,
      })
      return controller
    },
    { initialProps: { owner: firstOwner } }
  )
  act(() => {
    result.current.reconcile(
      firstBoard,
      { nodes, edges: initialEdges, pairingOrders: orders },
      []
    )
    result.current.onFlowReady()
  })
  expect(pending[0]?.next).toEqual(firstViewport)
  rerender({ owner: secondOwner })
  await act(async () => {})
  act(() =>
    result.current.reconcile(
      secondBoard,
      { nodes, edges: initialEdges, pairingOrders: orders },
      []
    )
  )
  pending[0].resolve(true)
  await waitFor(() => expect(pending).toHaveLength(2))
  expect(pending[1]?.next).toEqual(secondViewport)
  pending[1].resolve(true)
  await waitFor(() => expect(viewport).toEqual(secondViewport))
})

it('requeues the current repository target after owner deactivation and reactivation', async () => {
  const owner = setupOwner('/reactivation-race')
  const board = await owner.refresh()
  if (!board) throw new Error('missing board')
  const firstViewport = { x: -40, y: 75, zoom: 1.1 }
  const resumedViewport = { x: 185, y: -125, zoom: 0.75 }
  owner.setRepositoryViewport(firstViewport)
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 }
  const pending: Array<{
    next: Viewport
    resolve: (applied: boolean) => void
  }> = []
  const flow = {
    getViewport: () => viewport,
    setViewport: (next: Viewport) =>
      new Promise<boolean>((resolve) =>
        pending.push({
          next,
          resolve: (applied) => {
            viewport = next
            resolve(applied)
          },
        })
      ),
    fitView: mock(async () => true),
  }
  const { result } = renderHook(() =>
    useCanvasProjectionController({
      owner,
      nodes: [],
      setNodes: () => {},
      setEdges: () => {},
      host: { current: null },
      flow,
      report: mock(),
      reconcileSelection: mock(),
      startInView: true,
    })
  )
  act(() => {
    result.current.reconcile(
      board,
      { nodes, edges: initialEdges, pairingOrders: orders },
      []
    )
    result.current.onFlowReady()
  })
  expect(pending[0]?.next).toEqual(firstViewport)
  owner.dispose()
  owner.activate()
  owner.setRepositoryViewport(resumedViewport)
  act(() =>
    result.current.reconcile(
      board,
      { nodes, edges: initialEdges, pairingOrders: orders },
      []
    )
  )
  pending[0]?.resolve(true)
  await waitFor(() => expect(pending).toHaveLength(2))
  expect(pending[1]?.next).toEqual(resumedViewport)
  pending[1]?.resolve(true)
  await waitFor(() => expect(viewport).toEqual(resumedViewport))
})
