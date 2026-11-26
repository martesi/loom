import { t } from '@lingui/core/macro'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { useEffect, useRef } from 'react'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import { type Selection, sameSelection } from '../../lib/selection'
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
  run: (action: () => Promise<unknown>, guard?: () => boolean) => void
  setError: (message: string) => void
  setPreview: (preview: Preview | null) => void
  updateTarget: (target: Target | null) => void
  exitTool: () => void
  getSelection: () => Selection
}

interface PendingConnection {
  anchorId: number
  tool: Exclude<CanvasConnectionTool, null>
  owner: CanvasBoardOwner
  repoPath: string
  modeRevision: number
  selection: Selection
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

  function onKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>) {
    const { tool, mode, owner } = current.current
    if (!tool) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      current.current.exitTool()
      return true
    }
    if (
      event.key !== 'Enter' ||
      mode !== 'edit' ||
      !owner.allows('relationship')
    )
      return false
    const element = event.target instanceof Element ? event.target : null
    if (
      !element ||
      element.closest('button,a,input,textarea,select,[contenteditable=true]')
    )
      return false
    if (tool === 'reverse-relationship') {
      const edge = element.closest<HTMLElement>('.react-flow__edge[data-id]')
      if (!edge) return false
      const connection = createConnection(0, tool, {
        edgeId: Number(edge.dataset.id),
      })
      event.preventDefault()
      event.stopPropagation()
      reverseEdge(connection, edge)
      return true
    }
    const node = element.closest<HTMLElement>('.react-flow__node[data-id]')
    if (!node) return false
    const targetId = node.dataset.id
    if (!targetId || current.current.anchorId === null) return false
    const connection = createConnection(current.current.anchorId, tool, {
      targetId,
    })
    event.preventDefault()
    event.stopPropagation()
    completeLink(connection, targetId)
    return true
  }

  function onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
    const { owner, repoPath, mode, tool, anchorId, targetAt, setError } =
      current.current
    if (
      !tool ||
      mode !== 'edit' ||
      !owner.allows('relationship') ||
      event.button !== 0
    )
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
      pending.current = {
        anchorId: 0,
        tool,
        owner,
        repoPath,
        modeRevision: owner.getModeRevision(),
        selection: current.current.getSelection(),
        edgeId: Number(edge.dataset.id),
      }
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
    pending.current = {
      anchorId,
      targetId,
      tool,
      owner,
      repoPath,
      modeRevision: owner.getModeRevision(),
      selection: current.current.getSelection(),
    }
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
    const { targetAt } = current.current
    if (!connection) return false
    event.stopPropagation()
    event.preventDefault()
    pending.current = null
    current.current.setPreview(null)
    current.current.updateTarget(null)
    if (!isCurrent(connection)) return true
    if (connection.edgeId !== undefined) {
      reverseEdge(connection, event.target)
      return
    }
    const id = targetAt(event.clientX, event.clientY)
    if (!id || id !== connection.targetId) return true
    completeLink(connection, id)
    return true
  }

  function completeLink(connection: PendingConnection, id: string) {
    if (!isCurrent(connection)) return
    const { validTarget, run, setError } = current.current
    const source =
      connection.tool === 'connect-source' ? Number(id) : connection.anchorId
    const derived =
      connection.tool === 'connect-source' ? connection.anchorId : Number(id)
    const result = validTarget(source, String(derived))
    if (!result.valid) {
      setError(result.reason ?? t`Cannot create this relationship`)
      return
    }
    run(
      () => ImageService.LinkSource(connection.repoPath, source, derived),
      () => isCurrent(connection)
    )
  }

  function createConnection(
    anchorId: number,
    tool: PendingConnection['tool'],
    target: Pick<PendingConnection, 'targetId' | 'edgeId'>
  ): PendingConnection {
    const { owner, repoPath } = current.current
    return {
      anchorId,
      tool,
      owner,
      repoPath,
      modeRevision: owner.getModeRevision(),
      selection: current.current.getSelection(),
      ...target,
    }
  }

  function reverseEdge(
    connection: PendingConnection,
    eventTarget: EventTarget | null
  ) {
    const { data, validTarget, run, setError } = current.current
    const edgeId = connection.edgeId
    if (edgeId === undefined || !isCurrent(connection)) return
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
    run(
      () => ImageService.ReverseRelationship(connection.repoPath, edgeId),
      () => isCurrent(connection)
    )
  }

  function isCurrent(connection: PendingConnection) {
    const latest = current.current
    return (
      latest.owner === connection.owner &&
      latest.repoPath === connection.repoPath &&
      latest.tool === connection.tool &&
      sameSelection(latest.getSelection(), connection.selection) &&
      latest.mode === 'edit' &&
      connection.owner.isActive?.() !== false &&
      connection.owner.getMode() === 'edit' &&
      connection.owner.getModeRevision() === connection.modeRevision &&
      connection.owner.allows('relationship')
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
    onKeyDownCapture,
    onPointerDownCapture,
    onPointerMove,
    onPointerUpCapture,
    onPointerCancel,
    cancel,
  }
}
