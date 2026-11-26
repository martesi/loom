import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  type GeometryUpdate,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { useCanvasBoardOwner } from './canvas-board-owner'
import { data, empty, images, relationships } from './canvas-mode-test-fixtures'
import {
  refreshBoard,
  reserveCanvasOperation,
} from './canvas-operation-test-utils'
import { useCanvasBoardModel } from './use-canvas-board-model'

afterEach(() => {
  cleanup()
  mock.restore()
})

it('merges committed positions into the latest graph, not the graph used for layout', async () => {
  let links = relationships
  let geometry: GeometryUpdate[] = images.map((image) => ({
    imageId: image.id,
    x: image.canvasX,
    y: image.canvasY,
    w: 150,
    h: 110,
  }))
  let release = () => {}
  let started = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writing = new Promise<void>((resolve) => {
    started = resolve
  })
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '1',
        relationships: links,
        images: images.map((image) => ({
          id: image.id,
          width: image.width,
          height: image.height,
          geometry: geometry.find((row) => row.imageId === image.id),
        })),
      }) as never
  )
  spyOn(ImageService, 'SetGeometryFromDisplayAtRevision').mockImplementation(
    async (_path, _revision, _expected, _before, after) => {
      geometry = after
      started()
      await gate
      return undefined as never
    }
  )
  const { result } = renderHook(() => {
    const owner = useCanvasBoardOwner('/repo')
    const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
    const [nodes, setNodes] = useState<Node[]>([])
    const [edges, setEdges] = useState<Edge[]>([])
    const [selection, setSelection] = useState(emptySelection)
    const model = useCanvasBoardModel({
      data: board?.data ?? empty,
      owner,
      renditionGeneration: 0,
      callbacks: useRef({ report: mock() }),
      selection,
      setSelection,
      nodes,
      setNodes,
      edges,
      setEdges,
      target: null,
      host: useRef(null),
    })
    return { owner, nodes, setNodes, edges, selection, setSelection, model }
  })
  await act(async () => {
    await refreshBoard(result.current.owner)
  })
  await act(async () => {
    await result.current.model.transitionMode('edit')
  })
  act(() =>
    result.current.setNodes((nodes) =>
      nodes.map((node) =>
        node.id === '1' ? { ...node, position: { x: 900, y: 800 } } : node
      )
    )
  )
  expect(result.current.edges).toHaveLength(1)
  act(() =>
    result.current.setSelection({
      surface: 'canvas',
      ids: [1, 2],
      edges: [7],
      group: null,
    })
  )
  expect(result.current.model.displayEdges[0].selected).toBe(true)
  let operation: Promise<unknown> = Promise.resolve()
  let refresh: Promise<unknown> = Promise.resolve()
  await act(async () => {
    operation = reserveCanvasOperation(result.current.owner, (context) =>
      result.current.model.arrangeEdit(context)
    )
    await writing
    links = []
    refresh = result.current.owner.refresh()
  })
  expect(result.current.edges).toHaveLength(1)
  expect(result.current.selection).toEqual({
    surface: 'canvas',
    ids: [1, 2],
    edges: [7],
    group: null,
  })
  await act(async () => {
    release()
    expect(await operation).toMatchObject({ status: 'success' })
    expect(await refresh).toMatchObject({ status: 'success' })
  })
  expect(result.current.edges).toHaveLength(0)
  expect(result.current.selection.ids).toEqual([1, 2])
  expect(result.current.selection.edges).toEqual([])
  expect(
    result.current.model.displayNodes
      .filter((node) => node.selected)
      .map((node) => node.id)
  ).toEqual(['1', '2'])
  expect(result.current.nodes.map((node) => node.position)).toEqual(
    geometry.map(({ x, y }) => ({ x, y }))
  )
})
