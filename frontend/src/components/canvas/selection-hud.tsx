import { t } from '@lingui/core/macro'
import { type Node, useReactFlow, useViewport } from '@xyflow/react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  Boxes,
  Eye,
  MapPin,
  MinusCircle,
  MoreHorizontal,
  Sparkles,
} from 'lucide-react'
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

export interface SelectionHudProps {
  selectedNodes: Node[]
  hostRef: RefObject<HTMLDivElement | null>
  canCreateSet: boolean
  onCreateSet: () => void
  onAlignHorizontal: () => void
  onAlignVertical: () => void
  onArrangeSubgraph: () => void
  onUnplace: (nodeIds: string[]) => void
  onPreview: (node: Node) => void
  onLocate: (node: Node) => void
  onMore: (nodes: Node[]) => void
}

interface HudButtonProps {
  label: string
  icon: React.ReactNode
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  testId?: string
}

function HudButton({
  label,
  icon,
  disabled = false,
  danger = false,
  onClick,
  testId,
}: HudButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-all active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${
        danger
          ? 'text-danger hover:bg-danger-soft active:bg-danger-soft'
          : 'text-ink hover:bg-black/[0.06]'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

export function SelectionHud({
  selectedNodes,
  hostRef,
  canCreateSet,
  onCreateSet,
  onAlignHorizontal,
  onAlignVertical,
  onArrangeSubgraph,
  onUnplace,
  onPreview,
  onLocate,
  onMore,
}: SelectionHudProps) {
  const flow = useReactFlow()
  // Subscribe to viewport changes so the HUD follows pan/zoom seamlessly
  useViewport()

  const hudRef = useRef<HTMLDivElement>(null)
  const [hudSize, setHudSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    if (hudRef.current) {
      const rect = hudRef.current.getBoundingClientRect()
      if (rect.width !== hudSize.width || rect.height !== hudSize.height) {
        setHudSize({ width: rect.width, height: rect.height })
      }
    }
  })

  if (selectedNodes.length === 0) return null

  // Calculate selection bounding box in canvas coordinates
  const minX = Math.min(...selectedNodes.map((n) => n.position.x))
  const minY = Math.min(...selectedNodes.map((n) => n.position.y))
  const maxX = Math.max(
    ...selectedNodes.map(
      (n) => n.position.x + (n.measured?.width ?? n.width ?? 150)
    )
  )
  const maxY = Math.max(
    ...selectedNodes.map(
      (n) => n.position.y + (n.measured?.height ?? n.height ?? 110)
    )
  )

  // Convert to screen positions
  const screenTopPos = flow.flowToScreenPosition({
    x: (minX + maxX) / 2,
    y: minY,
  })
  const screenBottomPos = flow.flowToScreenPosition({
    x: (minX + maxX) / 2,
    y: maxY,
  })

  // Convert from screen to container coordinates
  const hostRect = hostRef.current?.getBoundingClientRect()
  const hostLeft = hostRect?.left ?? 0
  const hostTop = hostRect?.top ?? 0
  const hostWidth = hostRect?.width ?? window.innerWidth
  const hostHeight = hostRect?.height ?? window.innerHeight

  const localTopX = screenTopPos.x - hostLeft
  const localTopY = screenTopPos.y - hostTop
  const localBottomY = screenBottomPos.y - hostTop

  const currentWidth = hudSize.width || (selectedNodes.length === 1 ? 240 : 480)
  const currentHeight = hudSize.height || 40

  const padding = 16 // 2 * 8pt
  const minAllowedX = currentWidth / 2 + padding
  const maxAllowedX = hostWidth - currentWidth / 2 - padding
  const clampedX = Math.max(minAllowedX, Math.min(localTopX, maxAllowedX))

  const gap = 12
  let clampedY: number
  if (localTopY - gap - currentHeight < padding) {
    // Not enough space above selection; flip to render below selection
    const flippedY = localBottomY + gap + currentHeight
    clampedY = Math.min(flippedY, hostHeight - padding)
  } else {
    // Normal position: snapping directly above selection
    clampedY = Math.max(
      currentHeight + padding,
      Math.min(localTopY - gap, hostHeight - padding)
    )
  }

  const isSingle = selectedNodes.length === 1
  const singleNode = selectedNodes[0]

  return (
    <div
      ref={hudRef}
      data-testid="selection-hud"
      role="toolbar"
      aria-label={t`Selection Actions`}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        left: `${clampedX}px`,
        top: `${clampedY}px`,
        transform: 'translate(-50%, -100%)',
      }}
      className="absolute z-20 flex items-center gap-1 rounded-full border border-border bg-card/90 p-1.5 shadow-2xl backdrop-blur-xl transition-[left,top] duration-75"
    >
      {isSingle ? (
        <>
          <HudButton
            testId="hud-preview"
            label={t`Preview`}
            icon={<Eye className="h-3.5 w-3.5" />}
            onClick={() => onPreview(singleNode)}
          />
          <HudButton
            testId="hud-locate"
            label={t`Locate`}
            icon={<MapPin className="h-3.5 w-3.5" />}
            onClick={() => onLocate(singleNode)}
          />
          <HudButton
            testId="hud-more"
            label={t`More`}
            icon={<MoreHorizontal className="h-3.5 w-3.5" />}
            onClick={() => onMore(selectedNodes)}
          />
          <div className="my-auto h-4 w-px bg-border" />
          <HudButton
            testId="hud-unplace"
            label={t`Unplace`}
            danger
            icon={<MinusCircle className="h-3.5 w-3.5" />}
            onClick={() => onUnplace([singleNode.id])}
          />
        </>
      ) : (
        <>
          <HudButton
            testId="hud-create-set"
            label={t`Create Set (${selectedNodes.length})`}
            icon={<Boxes className="h-3.5 w-3.5" />}
            disabled={!canCreateSet}
            onClick={onCreateSet}
          />
          <div className="my-auto h-4 w-px bg-border" />
          <HudButton
            testId="hud-align-horizontally"
            label={t`Align Horizontally`}
            icon={<AlignCenterHorizontal className="h-3.5 w-3.5" />}
            onClick={onAlignHorizontal}
          />
          <HudButton
            testId="hud-align-vertically"
            label={t`Align Vertically`}
            icon={<AlignCenterVertical className="h-3.5 w-3.5" />}
            onClick={onAlignVertical}
          />
          <HudButton
            testId="hud-arrange-subgraph"
            label={t`Auto-arrange Subgraph`}
            icon={<Sparkles className="h-3.5 w-3.5" />}
            onClick={onArrangeSubgraph}
          />
          <HudButton
            testId="hud-more"
            label={t`More`}
            icon={<MoreHorizontal className="h-3.5 w-3.5" />}
            onClick={() => onMore(selectedNodes)}
          />
          <div className="my-auto h-4 w-px bg-border" />
          <HudButton
            testId="hud-unplace-selection"
            label={t`Unplace Selection`}
            danger
            icon={<MinusCircle className="h-3.5 w-3.5" />}
            onClick={() => onUnplace(selectedNodes.map((n) => n.id))}
          />
        </>
      )}
    </div>
  )
}
