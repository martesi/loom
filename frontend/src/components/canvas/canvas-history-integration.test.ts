import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { Toast } from '@base-ui-components/react/toast'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  type GeometryUpdate,
  ImageService,
  UndoService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import {
  createCanvasBoardOwner,
  useCanvasBoardOwner,
} from './canvas-board-owner'
import { useCanvasBoardModel } from './use-canvas-board-model'

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray) => parts.join(''),
}))
const { useUndoActions } = await import('../../lib/use-undo')

afterEach(() => {
  cleanup()
  mock.restore()
})

it('passes the complete replay result to the awaited change callback', async () => {
  const replay = {
    applied: true,
    kind: 'geometry',
    geometry: [
      { imageId: 1, x: 1, y: 2, w: null, h: null },
      { imageId: 2, x: null, y: null, w: 150, h: 110 },
    ],
  }
  spyOn(UndoService, 'Undo').mockImplementation(
    () => Promise.resolve(replay) as never
  )
  const onChange = mock(
    async (
      _result: import('../../../bindings/loom/internal/service').UndoResult
    ) => {}
  )
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(Toast.Provider, null, children)
  const { result } = renderHook(() => useUndoActions('/repo', onChange), {
    wrapper,
  })
  await act(async () => result.current.undo())
  expect(onChange).toHaveBeenCalledWith(replay)
})

const rect = (
  imageId: number,
  x: number | null,
  y: number | null,
  w: number | null,
  h: number | null
): GeometryUpdate => ({ imageId, x, y, w, h })
const initial = [
  rect(1, 10, 20, 150, 110),
  rect(2, 40, 50, 150, 110),
  rect(3, 80, 90, 150, 110),
]
const images = initial.map(({ imageId }) => ({
  id: imageId,
  fileName: `${imageId}.png`,
  filePath: '',
  thumbUrl: '',
  previewUrl: '',
  fullUrl: '',
  width: 640,
  height: 480,
  archived: false,
  trashed: false,
  missing: false,
  placed: true,
  canvasX: 0,
  canvasY: 0,
  canvasW: 150,
  canvasH: 110,
  promptText: '',
  groupId: 0,
  createdAt: '',
}))
const data: CanvasData = { images, relationships: [], groups: [] }
const emptyData: CanvasData = { images: [], relationships: [], groups: [] }
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(Toast.Provider, null, children)

function useBoard(path: string) {
  const owner = useCanvasBoardOwner(path)
  const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const callbacks = useRef({ report: mock() })
  const host = useRef<HTMLDivElement | null>(null)
  useCanvasBoardModel({
    data: board?.data ?? emptyData,
    owner,
    renditionGeneration: 0,
    callbacks,
    selection: emptySelection,
    nodes,
    setNodes,
    edges,
    setEdges,
    target: null,
    host,
  })
  const undo = useUndoActions(path, owner.applyHistory, owner)
  return { owner, nodes, setNodes, edges, undo }
}

it('replays every batch member, preserves unrelated display, and reconciles semantic history', async () => {
  let geometry = initial
  let relationships: CanvasData['relationships'] = []
  let revision = 1
  spyOn(ImageService, 'LoadCanvas').mockImplementation(
    () => Promise.resolve(data) as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: String(revision),
        images: geometry.map((entry) => ({
          id: entry.imageId,
          width: 640,
          height: 480,
          geometry: entry,
        })),
        relationships,
      }) as never
  )
  const replay = [rect(1, 1, 2, null, null), rect(2, 40, 50, 150, 110)]
  spyOn(UndoService, 'Undo')
    .mockImplementationOnce(() => {
      relationships = [
        { id: 9, sourceImageId: 1, derivedImageId: 2, pairingOrder: 1 },
      ] as CanvasData['relationships']
      revision++
      return Promise.resolve({ applied: true, kind: 'link' }) as never
    })
    .mockImplementationOnce(() => {
      geometry = [replay[0], replay[1], initial[2]]
      revision++
      return Promise.resolve({
        applied: true,
        kind: 'geometry',
        geometry: replay,
      }) as never
    })
  const { result } = renderHook(() => useBoard('/repo'), { wrapper })
  await act(async () => {
    await result.current.owner.refresh()
  })
  act(() =>
    result.current.setNodes((nodes) =>
      nodes.map((node) => ({
        ...node,
        position: { x: Number(node.id) * 100, y: 300 },
        width: 200,
        height: 210,
        measured: { width: 200, height: 210 },
      }))
    )
  )
  await act(async () => {
    await result.current.undo.undo()
  })
  expect(result.current.edges).toHaveLength(1)
  expect(result.current.nodes.map((node) => node.position.x)).toEqual([
    100, 200, 300,
  ])
  await act(async () => {
    await result.current.undo.undo()
  })
  expect(result.current.nodes.map((node) => node.position.x)).toEqual([
    1, 40, 300,
  ])
  expect(
    result.current.nodes.map((node) => [node.width, node.height, node.measured])
  ).toEqual([
    [150, 110, { width: 150, height: 110 }],
    [150, 110, { width: 150, height: 110 }],
    [200, 210, { width: 200, height: 210 }],
  ])
  expect(result.current.owner.getSnapshot()?.snapshot.revision).toBe('3')
  expect(
    result.current.owner.getSnapshot()?.snapshot.images?.[0].geometry
  ).toEqual(replay[0])
})

it('drops null positions from the placement board rather than placing at zero', async () => {
  let geometry = initial
  spyOn(ImageService, 'LoadCanvas').mockImplementation(
    () => Promise.resolve(data) as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: '2',
        images: geometry.map((entry) => ({
          id: entry.imageId,
          width: 640,
          height: 480,
          geometry: entry,
        })),
        relationships: [],
      }) as never
  )
  spyOn(UndoService, 'Undo').mockImplementation(() => {
    geometry = [rect(1, null, null, null, null), ...initial.slice(1)]
    return Promise.resolve({ applied: true, geometry: [geometry[0]] }) as never
  })
  const { result } = renderHook(() => useBoard('/repo'), { wrapper })
  await act(async () => {
    await result.current.owner.refresh()
    await result.current.undo.undo()
  })
  await waitFor(() =>
    expect(result.current.nodes.map((node) => node.id)).toEqual(['2', '3'])
  )
  expect(
    result.current.owner.getSnapshot()?.snapshot.images?.[0].geometry
  ).toEqual(geometry[0])
})

it('carries replay through a superseding refresh without publishing it early', async () => {
  let release: (value: CanvasData) => void = () => {}
  const delayed = new Promise<CanvasData>((resolve) => {
    release = resolve
  })
  spyOn(ImageService, 'LoadCanvas')
    .mockImplementationOnce(() => delayed as never)
    .mockImplementation(() => Promise.resolve(data) as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockImplementation(
    () =>
      Promise.resolve({
        revision: 'new',
        images: initial.map((entry) => ({
          id: entry.imageId,
          width: 640,
          height: 480,
          geometry: entry,
        })),
        relationships: [],
      }) as never
  )
  const owner = createCanvasBoardOwner('/repo')
  const replay = { applied: true, kind: 'geometry', geometry: [initial[0]] }
  const first = owner.applyHistory(replay)
  expect(owner.takeHistory()).toEqual([])
  await owner.refresh()
  expect(owner.takeHistory()).toEqual([replay])
  release(data)
  await first
  expect(owner.takeHistory()).toEqual([])
  expect(owner.getSnapshot()?.snapshot.revision).toBe('new')
  owner.dispose()
})

it('does not dispatch a queued replay after a repository switch', async () => {
  const undo = spyOn(UndoService, 'Undo').mockImplementation(
    () => Promise.resolve({ applied: true }) as never
  )
  const { result, rerender } = renderHook(({ path }) => useBoard(path), {
    initialProps: { path: '/one' },
    wrapper,
  })
  let release = () => {}
  const blocked = result.current.owner.execute(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const done = result.current.undo.undo()
  await Promise.resolve()
  rerender({ path: '/two' })
  await act(async () => {
    release()
    await blocked
    await done
  })
  expect(undo).not.toHaveBeenCalled()
  expect(result.current.owner.getSnapshot()).toBeNull()
})

it('ignores an in-flight replay response after a repository switch', async () => {
  let release: (value: { applied: boolean }) => void = () => {}
  const response = new Promise<{ applied: boolean }>((resolve) => {
    release = resolve
  })
  spyOn(UndoService, 'Undo').mockImplementation(() => response as never)
  const load = spyOn(ImageService, 'LoadCanvas')
  const { result, rerender } = renderHook(({ path }) => useBoard(path), {
    initialProps: { path: '/one' },
    wrapper,
  })
  const old = result.current.owner
  const done = result.current.undo.undo()
  await Promise.resolve()
  rerender({ path: '/two' })
  await act(async () => {
    release({ applied: true })
    await done
  })
  expect(load).not.toHaveBeenCalled()
  expect(old.takeHistory()).toEqual([])
  expect(result.current.owner.getSnapshot()).toBeNull()
})
