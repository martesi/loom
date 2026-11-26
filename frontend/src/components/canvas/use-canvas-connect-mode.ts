import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { CanvasInternalMode } from './canvas-mode-policy'

type Tool = 'derivative' | 'source' | 'reverse'
interface ActiveTool {
  tool: Tool
  anchor: number | null
  revision: number
  owner: CanvasBoardOwner
  repoPath: string
}

export function useCanvasConnectMode(props: {
  mode: CanvasInternalMode
  owner: CanvasBoardOwner
  repoPath: string
  selectionRef: { current: Selection }
  run(action: () => Promise<unknown>): void
  validTarget(source: number, id: string): { valid: boolean; reason?: string }
  setError(message: string): void
}) {
  const current = useRef(props)
  current.current = props
  const [active, setActive] = useState<ActiveTool | null>(null)
  const activeRef = useRef<ActiveTool | null>(null)
  const setTool = useCallback((next: ActiveTool | null) => {
    activeRef.current = next
    setActive(next)
  }, [])
  const start = useCallback(
    (tool: Tool) => {
      const selection = current.current.selectionRef.current
      const anchor =
        selection.surface === 'canvas' && selection.ids.length === 1
          ? selection.ids[0]
          : null
      if (
        current.current.owner.getMode() !== 'edit' ||
        (tool !== 'reverse' && anchor === null)
      )
        return
      setTool({
        tool,
        anchor,
        revision: current.current.owner.getModeRevision(),
        owner: current.current.owner,
        repoPath: current.current.repoPath,
      })
    },
    [setTool]
  )
  useEffect(() => {
    const tool = activeRef.current
    const selection = props.selectionRef.current
    if (
      tool &&
      (props.mode !== 'edit' ||
        tool.owner !== props.owner ||
        tool.repoPath !== props.repoPath ||
        (tool.tool !== 'reverse' &&
          (selection.surface !== 'canvas' ||
            selection.ids.length !== 1 ||
            selection.ids[0] !== tool.anchor)))
    )
      setTool(null)
  }, [
    props.mode,
    props.owner,
    props.repoPath,
    props.selectionRef.current,
    setTool,
  ])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const element = event.target instanceof Element ? event.target : null
      if (event.key === 'Escape' && activeRef.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setTool(null)
        return
      }
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat ||
        event.isComposing
      )
        return
      if (
        !element?.closest('main[data-canvas-surface]') ||
        element.closest('button,input,textarea,select,[contenteditable=true]')
      )
        return
      if (current.current.owner.getMode() !== 'edit') return
      const key = event.key.toLowerCase()
      if (key !== 'd' && key !== 's' && key !== 'r') return
      const selection = current.current.selectionRef.current
      const anchor =
        selection.surface === 'canvas' && selection.ids.length === 1
          ? selection.ids[0]
          : null
      if (key !== 'r' && anchor === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      start(key === 'd' ? 'derivative' : key === 's' ? 'source' : 'reverse')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setTool, start])
  function complete(element: Element) {
    const tool = activeRef.current
    if (
      !tool ||
      tool.owner !== current.current.owner ||
      tool.repoPath !== current.current.repoPath ||
      current.current.owner.getMode() !== 'edit'
    )
      return false
    const node = element.closest<HTMLElement>('.react-flow__node[data-id]')
    const edge = element.closest<HTMLElement>('.react-flow__edge[data-id]')
    const target = tool.tool === 'reverse' ? edge?.dataset.id : node?.dataset.id
    if (!target) return false
    const { owner, repoPath, run, validTarget, setError } = current.current
    const source = tool.tool === 'source' ? Number(target) : tool.anchor
    const derived = tool.tool === 'source' ? tool.anchor : Number(target)
    if (tool.tool !== 'reverse' && source !== null && derived !== null) {
      const validation = validTarget(source, String(derived))
      if (!validation.valid) {
        setError(validation.reason ?? 'Cannot create this relationship')
        return true
      }
    }
    run(async () => {
      if (
        owner.getMode() !== 'edit' ||
        owner.getModeRevision() !== tool.revision ||
        activeRef.current !== tool
      )
        return
      const selection = current.current.selectionRef.current
      if (
        tool.tool !== 'reverse' &&
        (selection.surface !== 'canvas' ||
          selection.ids.length !== 1 ||
          selection.ids[0] !== tool.anchor)
      )
        return
      if (tool.tool === 'reverse')
        await ImageService.ReverseRelationship(repoPath, Number(target))
      else if (source !== null && derived !== null)
        await ImageService.LinkSource(repoPath, source, derived)
    })
    return true
  }
  return { active, complete, start, exit: () => setTool(null) }
}
