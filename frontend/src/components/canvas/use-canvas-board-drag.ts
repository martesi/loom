import type { Node, NodeChange } from '@xyflow/react'
import { type Dispatch, type SetStateAction, useRef } from 'react'
import type {
  CanvasData,
  GeometryUpdate,
} from '../../../bindings/loom/internal/service'
import type { DragGesture } from './canvas-board-gestures'
import type { CanvasBoardOwner } from './canvas-board-owner'

export function useCanvasBoardDrag(
  owner: CanvasBoardOwner,
  data: CanvasData,
  report: (error: unknown) => void,
  setNodes: Dispatch<SetStateAction<Node[]>>
) {
  const current = useRef<DragGesture | null>(null)
  const blocked = useRef(new Set<string>())

  function start(nodes: Node[]) {
    owner.cancelGesture()
    const board = owner.getSnapshot()
    const before = nodes.filter((node) => node.type === 'image').map(rectangle)
    blocked.current = new Set()
    const restore = () => {
      const positions = new Map(
        before.map((item) => [
          String(item.imageId),
          { x: item.x ?? 0, y: item.y ?? 0 },
        ])
      )
      blocked.current = new Set(positions.keys())
      setNodes((previous) =>
        previous.map((node) => {
          const position = positions.get(node.id)
          return position ? { ...node, position, dragging: false } : node
        })
      )
    }
    current.current = owner.beginDrag(
      board?.data === data ? board : null,
      before,
      restore
    )
    if (before.length && !current.current) {
      restore()
      if (owner.isLayoutPending())
        report(
          new Error('Canvas layout is being saved. Try moving the image again.')
        )
    }
  }

  function take() {
    const gesture = current.current
    current.current = null
    blocked.current = new Set()
    return gesture && owner.isGestureActive(gesture) ? gesture : null
  }

  function finish(gesture: DragGesture, nodes: Node[]) {
    const byId = new Map(
      nodes
        .filter((node) => node.type === 'image')
        .map((node) => [Number(node.id), node])
    )
    const after: GeometryUpdate[] = []
    for (const before of gesture.before) {
      const node = byId.get(before.imageId)
      if (!node) {
        owner.cancelGesture()
        void owner.refresh().catch(report)
        report(new Error('Dragged image is unavailable. Canvas reloaded.'))
        return
      }
      after.push({ ...before, ...node.position })
    }
    void owner.endDrag(gesture, after).catch(report)
  }

  function filterChanges(changes: NodeChange[]) {
    return changes.filter(
      (change) => change.type !== 'position' || !blocked.current.has(change.id)
    )
  }

  function abandon() {
    owner.cancelGesture()
    blocked.current = new Set()
  }

  return { start, take, finish, filterChanges, abandon }
}

function rectangle(node: Node): GeometryUpdate {
  return {
    imageId: Number(node.id),
    x: node.position.x,
    y: node.position.y,
    w: node.measured?.width ?? node.width ?? 150,
    h: node.measured?.height ?? node.height ?? 110,
  }
}
