import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import {
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import {
  type CanvasData,
  ImageService,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { useCanvasBoardOwner } from './canvas-board-owner'
import { useCanvasAssetOperations } from './use-canvas-asset-operations'
import { useCanvasBoardModel } from './use-canvas-board-model'
import { useCanvasPreview } from './use-canvas-preview'

afterEach(() => {
  cleanup()
  mock.restore()
})

it('uses the projected graph for navigation and preview in View and Edit', async () => {
  const images = [3, 2, 1, 4].map((id) => ({
    id,
    fileName: `${id}.png`,
    filePath: `/repo/${id}.png`,
    thumbUrl: '',
    previewUrl: '',
    fullUrl: '',
    width: 640,
    height: 480,
    archived: false,
    trashed: false,
    missing: false,
    placed: false,
    canvasX: 9000,
    canvasY: 9000,
    canvasW: 150,
    canvasH: 110,
    promptText: '',
    groupId: 0,
    createdAt: '',
  }))
  const links = [
    {
      id: 2,
      sourceImageId: 1,
      derivedImageId: 3,
      pairingOrder: 2,
      createdAt: null,
    },
    {
      id: 1,
      sourceImageId: 1,
      derivedImageId: 2,
      pairingOrder: 1,
      createdAt: null,
    },
  ]
  const data: CanvasData = { images, relationships: links, groups: [] }
  const empty: CanvasData = { images: [], relationships: [], groups: [] }
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue(data as never)
  spyOn(ImageService, 'GetImage').mockImplementation(
    async (_path, id) => images.find((image) => image.id === id) as never
  )
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    relationships: links,
    images: images.map((image) => ({
      id: image.id,
      width: image.width,
      height: image.height,
      geometry: { imageId: image.id, x: null, y: null, w: null, h: null },
    })),
  } as never)
  const selectAssets = mock()
  const reveal = mock()
  let app: ReturnType<typeof useHarness> | undefined
  // biome-ignore lint/correctness/noComponentHookFactories: this isolated test owns its fixture and hook lifetime.
  function useHarness() {
    const owner = useCanvasBoardOwner('/repo')
    const board = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
    const [nodes, setNodes] = useState<Node[]>([])
    const [edges, setEdges] = useState<Edge[]>([])
    const [selection, setSelection] = useState(emptySelection)
    const flow = useReactFlow()
    const host = useRef<HTMLDivElement | null>(null)
    const callbacks = useRef({ report: mock() })
    const model = useCanvasBoardModel({
      data: board?.data ?? empty,
      owner,
      renditionGeneration: 0,
      callbacks,
      selection,
      nodes,
      setNodes,
      edges,
      setEdges,
      target: null,
      host,
      flow,
    })
    const operations = useCanvasAssetOperations({
      owner,
      repoPath: '/repo',
      flow,
      selection,
      setSelection,
      setExpanded: mock(),
      openAssets: mock(),
      selectAssets,
      setReveal: reveal,
    } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
    const preview = useCanvasPreview({
      data: board?.data ?? data,
      mode: model.mode,
      graphOrder: model.graphOrder,
      repoPath: '/repo',
      previewOrigin: { surface: 'canvas' },
      previewFolderOrder: null,
      previewImageId: 1,
      setPreviewOrigin: mock(),
      setPreviewFolderOrder: mock(),
      setPreviewImageId: mock(),
    })
    return {
      owner,
      model,
      flow,
      nodes,
      edges,
      selection,
      operations,
      preview,
      host,
    }
  }
  // biome-ignore lint/correctness/noComponentHookFactories: this component is mounted once for this fixture.
  function Harness() {
    app = useHarness()
    return createElement(
      'div',
      { ref: app.host, style: { width: 800, height: 600 } },
      createElement(ReactFlow, {
        nodes: app.model.displayNodes,
        edges: app.model.displayEdges,
      })
    )
  }
  render(createElement(ReactFlowProvider, null, createElement(Harness)))
  const current = () => {
    if (!app) throw new Error('missing harness')
    return app
  }
  await act(async () => {
    await current().owner.refresh()
  })
  await act(async () => {
    await current().model.transitionMode('view')
  })
  await waitFor(() =>
    expect(current().nodes.map((node) => node.id)).toEqual(['1', '2', '3'])
  )
  expect(current().preview.images.map((image) => image.id)).toEqual([1, 2, 3])
  expect(
    current()
      .preview.relatedImages(1, 'children')
      .map((image) => image.id)
  ).toEqual([2, 3])
  await act(async () => {
    await current().flow.setViewport({ x: -120, y: -90, zoom: 1.5 })
    current().model.updateProjectionViewport(current().flow.getViewport())
  })
  const viewViewport = current().flow.getViewport()
  expect(viewViewport).toEqual({ x: -120, y: -90, zoom: 1.5 })
  const projected = current().flow.getNode('2')
  expect(projected?.position).not.toEqual({ x: 9000, y: 9000 })
  await act(async () => {
    await current().operations.go(2)
  })
  expect(current().selection.ids).toEqual([2])
  expect(current().flow.getViewport()).not.toEqual(viewViewport)
  await act(async () => {
    await current().flow.setViewport(viewViewport)
    current().model.updateProjectionViewport(viewViewport)
  })
  await act(async () => {
    await current().operations.go(4)
  })
  expect(selectAssets).toHaveBeenCalledWith([4])
  expect(reveal).toHaveBeenCalledWith({ id: 4, folder: null })
  await act(async () => {
    await current().model.transitionMode('edit')
  })
  await act(async () => {
    await current().flow.setViewport({ x: -400, y: -300, zoom: 0.75 })
    current().model.updateProjectionViewport(current().flow.getViewport())
  })
  await waitFor(() => expect(current().flow.getNode('4')).toBeDefined())
  await act(async () => {
    await current().operations.go(4)
  })
  expect(current().selection).toEqual({
    surface: 'canvas',
    ids: [4],
    edges: [],
    group: null,
  })
  expect(current().flow.getNode('4')?.position).not.toEqual({
    x: 9000,
    y: 9000,
  })
  const editViewport = current().flow.getViewport()
  expect(editViewport).not.toEqual(viewViewport)
  await act(async () => {
    await current().model.transitionMode('view')
  })
  expect(current().flow.getViewport()).toEqual(viewViewport)
  await act(async () => {
    await current().model.transitionMode('edit')
  })
  expect(current().flow.getViewport()).toEqual(editViewport)
})
