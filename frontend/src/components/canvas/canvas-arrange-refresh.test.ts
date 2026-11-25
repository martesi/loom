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
    const model = useCanvasBoardModel({
      data: board?.data ?? empty,
      owner,
      renditionGeneration: 0,
      callbacks: useRef({ report: mock() }),
      selection: emptySelection,
      nodes,
      setNodes,
      edges,
      setEdges,
      target: null,
      host: useRef(null),
    })
    return { owner, nodes, setNodes, edges, model }
  })
  await act(async () => {
    await result.current.owner.refresh()
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
  let operation: Promise<void> = Promise.resolve()
  await act(async () => {
    operation = result.current.owner.execute(() =>
      result.current.model.arrangeEdit()
    )
    await writing
    links = []
    await result.current.owner.refresh()
  })
  expect(result.current.edges).toHaveLength(0)
  await act(async () => {
    release()
    await operation
  })
  expect(result.current.edges).toHaveLength(0)
  expect(result.current.nodes.map((node) => node.position)).toEqual(
    geometry.map(({ x, y }) => ({ x, y }))
  )
})
