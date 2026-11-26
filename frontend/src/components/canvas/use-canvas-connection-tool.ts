import { t } from '@lingui/core/macro'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { useEffect, useRef } from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { CanvasInternalMode } from './canvas-mode-policy'
import type { CanvasConnectionTool } from './use-canvas-workspace-state'

interface Preview {
  x1: number
  y1: number
  x2: number
  y2: number
  valid: boolean | null
}

interface Target {
  id: string
  valid: boolean
  kind: 'relationship'
  reason?: string
}

interface Props {
  tool: CanvasConnectionTool
  anchorId: number | null
  mode: CanvasInternalMode
  owner: CanvasBoardOwner
  repoPath: string
  data: CanvasData
  host: { current: HTMLDivElement | null }
  targetAt: (x: number, y: number) => string | null
  validTarget: (
    source: number,
    target: string,
    excludedRelationshipId?: number
  ) => { valid: boolean; reason?: string }
  run: (action: () => Promise<unknown>) => void
  setError: (message: string) => void
  setPreview: (preview: Preview | null) => void
  updateTarget: (target: Target | null) => void
}

interface PendingConnection {
  anchorId: number
  targetId?: string
  edgeId?: number
}

export function useCanvasConnectionTool(props: Props) {
  const current = useRef(props)
  current.current = props
  const pending = useRef<PendingConnection | null>(null)
  const previousTool = useRef(props.tool)

  useEffect(() => {
    const changed = previousTool.current !== props.tool
    previousTool.current = props.tool
    if (!changed && props.mode === 'edit') return
    pending.current = null
    props.setPreview(null)
    props.updateTarget(null)
  }, [props.mode, props.setPreview, props.tool, props.updateTarget])

  function onClickCapture(event: ReactMouseEvent<HTMLElement>) {
    const { owner, tool, targetAt } = current.current
    if (!tool || !owner.allows('relationship')) return false
    const element = event.target instanceof Element ? event.target : null
    if (
      targetAt(event.clientX, event.clientY) ||
      element?.closest('.react-flow__edge')
    ) {
      event.stopPropagation()
      event.preventDefault()
    }
    return true
  }

  function onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
    const { owner, tool, anchorId, targetAt, setError } = current.current
    if (!tool || !owner.allows('relationship') || event.button !== 0)
      return false
    const eventElement = event.target instanceof Element ? event.target : null
    if (
      eventElement?.closest(
        'button,a,input,textarea,select,[contenteditable=true]'
      )
    ) {
      if (!eventElement.closest('.react-flow__node')) return false
      event.stopPropagation()
      event.preventDefault()
      return true
    }
    const edge = eventElement
      ? eventElement.closest<HTMLElement>('.react-flow__edge')
      : null
    const targetId = targetAt(event.clientX, event.clientY)
    if (tool === 'reverse-relationship' && edge?.dataset.id) {
      pending.current = { anchorId: 0, edgeId: Number(edge.dataset.id) }
      event.stopPropagation()
      event.preventDefault()
      return true
    }
    if (tool === 'reverse-relationship') {
      if (targetId) {
        event.stopPropagation()
        event.preventDefault()
        return true
      }
      return false
    }
    if (!targetId) return false
    event.stopPropagation()
    event.preventDefault()
    if (anchorId === null) {
      setError(t`Select one Canvas image first`)
      return true
    }
    pending.current = { anchorId, targetId }
    return true
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const { tool } = current.current
    if (!tool) return false
    if (tool === 'reverse-relationship') {
      previewReverseTarget(event.clientX, event.clientY)
      return true
    }
    previewLinkTarget(event.clientX, event.clientY)
    return true
  }

  function onPointerUpCapture(event: ReactPointerEvent<HTMLElement>) {
    const connection = pending.current
    const { owner, tool, repoPath, targetAt, validTarget, run, setError } =
      current.current
    if (!connection || !tool) return false
    event.stopPropagation()
    event.preventDefault()
    pending.current = null
    current.current.setPreview(null)
    current.current.updateTarget(null)
    if (!owner.allows('relationship')) return true
    if (connection.edgeId !== undefined) {
      reverseEdge(connection.edgeId, event.target)
      return true
    }
    const id = targetAt(event.clientX, event.clientY)
    if (!id || id !== connection.targetId) return true
    const source = tool === 'connect-source' ? Number(id) : connection.anchorId
    const derived = tool === 'connect-source' ? connection.anchorId : Number(id)
    const result = validTarget(source, String(derived))
    if (!result.valid) {
      setError(result.reason ?? t`Cannot create this relationship`)
      return true
    }
    run(() =>
      owner.allows('relationship')
        ? ImageService.LinkSource(repoPath, source, derived)
        : Promise.resolve()
    )
    return true
  }

  function reverseEdge(edgeId: number, eventTarget: EventTarget | null) {
    const { owner, data, validTarget, run, repoPath, setError } =
      current.current
    const edge =
      eventTarget instanceof Element
        ? eventTarget.closest<HTMLElement>('.react-flow__edge')
        : null
    if (Number(edge?.dataset.id) !== edgeId) return
    const relationship = data.relationships?.find((item) => item.id === edgeId)
    if (!relationship) return
    const result = validTarget(
      relationship.derivedImageId,
      String(relationship.sourceImageId),
      relationship.id
    )
    if (!result.valid) {
      setError(result.reason ?? t`Cannot reverse this relationship`)
      return
    }
    run(() =>
      owner.allows('relationship')
        ? ImageService.ReverseRelationship(repoPath, edgeId)
        : Promise.resolve()
    )
  }

  function onPointerCancel() {
    cancel()
  }

  function cancel() {
    pending.current = null
    current.current.setPreview(null)
    current.current.updateTarget(null)
  }

  function previewLinkTarget(x: number, y: number) {
    const {
      tool,
      anchorId,
      targetAt,
      validTarget,
      host,
      setPreview,
      updateTarget,
    } = current.current
    if (!tool || tool === 'reverse-relationship' || anchorId === null) return
    const targetId = targetAt(x, y)
    if (!targetId) {
      setPreview(null)
      updateTarget(null)
      return
    }
    const source = tool === 'connect-source' ? Number(targetId) : anchorId
    const derived = tool === 'connect-source' ? anchorId : Number(targetId)
    const result = validTarget(source, String(derived))
    const surface = host.current?.getBoundingClientRect()
    const anchor = host.current
      ?.querySelector<HTMLElement>(`.react-flow__node[data-id="${anchorId}"]`)
      ?.getBoundingClientRect()
    if (surface && anchor)
      setPreview({
        x1:
          (tool === 'connect-source' ? x : anchor.left + anchor.width / 2) -
          surface.left,
        y1:
          (tool === 'connect-source' ? y : anchor.top + anchor.height / 2) -
          surface.top,
        x2:
          (tool === 'connect-source' ? anchor.left + anchor.width / 2 : x) -
          surface.left,
        y2:
          (tool === 'connect-source' ? anchor.top + anchor.height / 2 : y) -
          surface.top,
        valid: result.valid,
      })
    updateTarget({
      id: targetId,
      valid: result.valid,
      reason: result.reason,
      kind: 'relationship',
    })
  }

  function previewReverseTarget(x: number, y: number) {
    const { data, host, validTarget, setPreview, updateTarget } =
      current.current
    const edge = document
      .elementsFromPoint(x, y)
      .map((element) => element.closest<HTMLElement>('.react-flow__edge'))
      .find((element) => element !== null)
    const relationship = edge?.dataset.id
      ? data.relationships?.find((item) => item.id === Number(edge.dataset.id))
      : undefined
    if (!relationship) {
      setPreview(null)
      updateTarget(null)
      return
    }
    const result = validTarget(
      relationship.derivedImageId,
      String(relationship.sourceImageId),
      relationship.id
    )
    const surface = host.current?.getBoundingClientRect()
    const source = host.current
      ?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${relationship.derivedImageId}"]`
      )
      ?.getBoundingClientRect()
    const derived = host.current
      ?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${relationship.sourceImageId}"]`
      )
      ?.getBoundingClientRect()
    if (surface && source && derived)
      setPreview({
        x1: source.left + source.width / 2 - surface.left,
        y1: source.top + source.height / 2 - surface.top,
        x2: derived.left + derived.width / 2 - surface.left,
        y2: derived.top + derived.height / 2 - surface.top,
        valid: result.valid,
      })
    updateTarget({
      id: String(relationship.id),
      valid: result.valid,
      reason: result.reason,
      kind: 'relationship',
    })
  }

  return {
    onClickCapture,
    onPointerDownCapture,
    onPointerMove,
    onPointerUpCapture,
    onPointerCancel,
    cancel,
  }
}
