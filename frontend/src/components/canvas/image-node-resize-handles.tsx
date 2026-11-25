import { t } from '@lingui/core/macro'
import { useReactFlow } from '@xyflow/react'
import { useRef } from 'react'
import type { GeometryUpdate } from '../../../bindings/loom/internal/service'
import {
  type ResizeDirection,
  resizeDirections,
  resizeRectangle,
} from './canvas-resize-geometry'

export interface ImageResizeCallbacks {
  onResizeStart?: (
    pointerId: number,
    direction: ResizeDirection,
    before: GeometryUpdate,
    cancelPointer: () => void
  ) => number | null
  onResizeMove?: (
    token: number,
    pointerId: number,
    after: GeometryUpdate
  ) => boolean
  onResizeEnd?: (
    token: number,
    pointerId: number,
    after: GeometryUpdate
  ) => void
  onResizeCancel?: (token: number, pointerId: number) => void
}

interface ActiveResize {
  token: number
  pointerId: number
  direction: ResizeDirection
  before: GeometryUpdate
  startX: number
  startY: number
  element: HTMLButtonElement | null
}

const handlePosition: Record<ResizeDirection, string> = {
  nw: '-left-1.5 -top-1.5 cursor-nwse-resize',
  n: 'left-1/2 -top-1.5 -translate-x-1/2 cursor-n-resize',
  ne: '-right-1.5 -top-1.5 cursor-nesw-resize',
  e: '-right-1.5 top-1/2 -translate-y-1/2 cursor-e-resize',
  se: '-bottom-1.5 -right-1.5 cursor-nwse-resize',
  s: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-s-resize',
  sw: '-bottom-1.5 -left-1.5 cursor-nesw-resize',
  w: '-left-1.5 top-1/2 -translate-y-1/2 cursor-w-resize',
}
const handleLabel: Record<ResizeDirection, string> = {
  nw: t`Resize image from top left`,
  n: t`Resize image from top edge`,
  ne: t`Resize image from top right`,
  e: t`Resize image from right edge`,
  se: t`Resize image from bottom right`,
  s: t`Resize image from bottom edge`,
  sw: t`Resize image from bottom left`,
  w: t`Resize image from left edge`,
}

export function ImageNodeResizeHandles({
  id,
  callbacks,
}: {
  id: string
  callbacks: ImageResizeCallbacks
}) {
  const { getNode, screenToFlowPosition } = useReactFlow()
  const active = useRef<ActiveResize | null>(null)

  function clear(token?: number) {
    const current = active.current
    if (!current || (token !== undefined && current.token !== token)) return
    active.current = null
    if (current.element?.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId)
  }

  function begin(
    event: React.PointerEvent<HTMLButtonElement>,
    direction: ResizeDirection
  ) {
    event.preventDefault()
    event.stopPropagation()
    if (active.current || event.button !== 0) return
    const node = getNode(id)
    if (!node) return
    const before: GeometryUpdate = {
      imageId: Number(id),
      x: node.position.x,
      y: node.position.y,
      w: node.measured?.width ?? node.width ?? 150,
      h: node.measured?.height ?? node.height ?? 110,
    }
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const element = event.currentTarget
    const token = callbacks.onResizeStart?.(
      event.pointerId,
      direction,
      before,
      () => clear()
    )
    if (token === undefined || token === null) return
    active.current = {
      token,
      pointerId: event.pointerId,
      direction,
      before,
      startX: point.x,
      startY: point.y,
      element,
    }
    element.setPointerCapture(event.pointerId)
  }

  function update(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const current = active.current
    if (!current || current.pointerId !== event.pointerId) return
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const after = resizeRectangle(
      current.before,
      current.direction,
      point.x - current.startX,
      point.y - current.startY
    )
    if (!callbacks.onResizeMove?.(current.token, event.pointerId, after))
      clear(current.token)
  }

  function finish(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const current = active.current
    if (!current || current.pointerId !== event.pointerId) return
    update(event)
    if (active.current?.token !== current.token) return
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const after = resizeRectangle(
      current.before,
      current.direction,
      point.x - current.startX,
      point.y - current.startY
    )
    active.current = null
    callbacks.onResizeEnd?.(current.token, event.pointerId, after)
    if (current.element?.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId)
  }

  function cancel(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const current = active.current
    if (!current || current.pointerId !== event.pointerId) return
    active.current = null
    callbacks.onResizeCancel?.(current.token, event.pointerId)
    if (current.element?.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId)
  }

  function resizeWithKeyboard(
    event: React.KeyboardEvent<HTMLButtonElement>,
    direction: ResizeDirection
  ) {
    const delta =
      event.key === 'ArrowLeft'
        ? [-10, 0]
        : event.key === 'ArrowRight'
          ? [10, 0]
          : event.key === 'ArrowUp'
            ? [0, -10]
            : event.key === 'ArrowDown'
              ? [0, 10]
              : null
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    const node = getNode(id)
    if (!node) return
    const before: GeometryUpdate = {
      imageId: Number(id),
      x: node.position.x,
      y: node.position.y,
      w: node.measured?.width ?? node.width ?? 150,
      h: node.measured?.height ?? node.height ?? 110,
    }
    const token = callbacks.onResizeStart?.(-1, direction, before, () => {})
    if (token === undefined || token === null) return
    const after = resizeRectangle(before, direction, delta[0], delta[1])
    if (callbacks.onResizeMove?.(token, -1, after))
      callbacks.onResizeEnd?.(token, -1, after)
    else callbacks.onResizeCancel?.(token, -1)
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {resizeDirections.map((direction) => (
        <button
          key={direction}
          type="button"
          aria-label={handleLabel[direction]}
          data-testid={`resize-handle-${direction}`}
          className={`pointer-events-auto absolute h-2.5 w-2.5 touch-none rounded-sm border border-primary bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${handlePosition[direction]}`}
          onPointerDown={(event) => begin(event, direction)}
          onPointerMove={update}
          onPointerUp={finish}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onKeyDown={(event) => resizeWithKeyboard(event, direction)}
        />
      ))}
    </div>
  )
}
