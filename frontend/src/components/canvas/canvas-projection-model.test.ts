import { describe, expect, it } from 'bun:test'
import { renderHook, waitFor } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { applyNodeChanges } from '@xyflow/react'
import { useRef, useState } from 'react'
import type {
  CanvasData,
  ImageInfo,
} from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import {
  createCanvasProjection,
  enterEdit,
  enterView,
  reconcileCanvasProjection,
  setEditNodes,
} from './canvas-projection'
import { canvasProjectionGraph } from './canvas-projection-model'
import { useCanvasBoardModel } from './use-canvas-board-model'

const image = (id: number, placed = false): ImageInfo => ({
  id,
  fileName: `${id}.png`,
  filePath: `${id}.png`,
  thumbUrl: '',
  previewUrl: '',
  fullUrl: '',
  width: 640,
  height: 480,
  archived: false,
  trashed: false,
  missing: false,
  placed,
  canvasX: 10,
  canvasY: 20,
  canvasW: 150,
  canvasH: 110,
  promptText: '',
  groupId: 0,
  createdAt: '',
})
const data: CanvasData = {
  images: [image(1, true), image(2), image(3), image(4), image(5)],
  relationships: [
    {
      id: 12,
      sourceImageId: 1,
      derivedImageId: 2,
      pairingOrder: 9,
      createdAt: null,
    },
    {
      id: 13,
      sourceImageId: 3,
      derivedImageId: 4,
      pairingOrder: 2,
      createdAt: null,
    },
  ],
  groups: [],
}
const graph = (value: CanvasData) => canvasProjectionGraph(value, 0, () => {})

describe('board projection mapping', () => {
  it('keeps the live board placement filter and group mapping unchanged', async () => {
    const boardData = {
      ...data,
      images:
        data.images?.map((item) =>
          item.id === 2 ? { ...item, placed: true } : item
        ) ?? null,
      groups: [
        { id: 5, name: 'set', kind: '', coverImageId: 1, memberIds: [1] },
      ],
    }
    const { result, unmount } = renderHook(() => {
      const [nodes, setNodes] = useState<Node[]>([])
      const [edges, setEdges] = useState<Edge[]>([])
      const callbacks = useRef({ run: (_action: () => Promise<unknown>) => {} })
      const dropTargets = useRef<Node[]>([])
      const host = useRef<HTMLDivElement | null>(null)
      useCanvasBoardModel({
        data: boardData,
        expanded: null,
        repoPath: 'test',
        renditionGeneration: 0,
        callbacks,
        selection: emptySelection,
        nodes,
        setNodes,
        edges,
        setEdges,
        target: null,
        dropTargets,
        host,
      })
      return { nodes, edges }
    })
    await waitFor(() =>
      expect(result.current.nodes.map((node) => node.id)).toEqual([
        '2',
        'set-5',
      ])
    )
    expect(result.current.edges).toMatchObject([
      { id: '12', source: 'set-5', target: '2' },
    ])
    unmount()
  })
  it('excludes trashed images and relationships with unavailable endpoints', () => {
    const result = graph({
      ...data,
      images: [...(data.images ?? []), { ...image(6), trashed: true }],
      relationships: [
        ...(data.relationships ?? []),
        {
          id: 14,
          sourceImageId: 1,
          derivedImageId: 6,
          pairingOrder: 3,
          createdAt: null,
        },
        {
          id: 15,
          sourceImageId: 1,
          derivedImageId: 999,
          pairingOrder: 4,
          createdAt: null,
        },
      ],
    })
    expect(result.nodes.map((node) => node.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
    expect(result.edges.map((edge) => edge.id)).toEqual(['12', '13'])
    expect([...result.pairingOrders]).toEqual([
      ['12', 9],
      ['13', 2],
    ])
  })
  it('maps real canvas DTOs by pairing order and preserves React Flow edits across refresh', () => {
    const input = {
      ...graph(data),
      geometry: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 800, height: 600 },
    }
    let state = createCanvasProjection(input)
    expect(
      state.projection.components.map((component) => component.pairingOrder)
    ).toEqual([2, 9])
    expect(state.viewNodes.map((node) => node.id)).toEqual(['1', '2', '3', '4'])
    state = enterEdit(state)
    expect(state.editNodes).toHaveLength(5)
    const moved = applyNodeChanges(
      [{ id: '1', type: 'position', position: { x: 800, y: 900 } }],
      state.editNodes
    )
    state = setEditNodes(
      state,
      moved.map((node) =>
        node.id === '1' ? { ...node, width: 210, height: 120 } : node
      )
    )
    const updated = {
      ...data,
      images:
        data.images?.map((item) =>
          item.id === 1 ? { ...item, fileName: 'updated.png' } : item
        ) ?? null,
      relationships: [],
    }
    state = reconcileCanvasProjection(state, {
      ...graph(updated),
      geometry: [],
    })
    expect(state.editNodes.find((node) => node.id === '1')).toMatchObject({
      position: { x: 800, y: 900 },
      width: 210,
      height: 120,
      data: { fileName: 'updated.png' },
    })
    expect(enterView(state).viewNodes).toHaveLength(0)
  })
})
