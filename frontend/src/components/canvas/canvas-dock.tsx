import { t } from '@lingui/core/macro'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  Eye,
  Focus,
  MapPin,
  Maximize2,
  PanelRight,
  RotateCcw,
  Sparkles,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { memo } from 'react'
import { Tooltip } from '../ui/tooltip'
import type { CanvasInternalMode } from './canvas-mode-policy'
import type { CanvasConnectionTool } from './use-canvas-workspace-state'

export type CanvasDockMode = 'idle' | 'single' | 'multiple'

export interface CanvasDockProps {
  mode: CanvasDockMode
  canvasMode: CanvasInternalMode
  connectionTool: CanvasConnectionTool
  canConnect: boolean
  selectionCount: number
  canFitAll: boolean
  canFitSelection: boolean
  canAutoArrange: boolean
  canArrangeSelection?: boolean
  canMutateGeometry?: boolean
  shortcuts: {
    fitAll: string
    fitSelection: string
    resetZoom: string
    autoArrange: string
    inspect: string
    unplace: string
    connectDerivative: string
    connectSource: string
    reverseRelationship: string
  }
  onAction: (id: string) => void
}

interface DockButtonProps {
  label: string
  shortcut?: string
  icon: ReactNode
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  testId: string
}

function DockButton({
  label,
  shortcut,
  icon,
  disabled = false,
  danger = false,
  onClick,
  testId,
}: DockButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40 ${
          danger ? 'text-danger hover:bg-danger-soft' : 'text-ink'
        }`}
      >
        <span className="shrink-0">{icon}</span>
      </button>
    </Tooltip>
  )
}

export const CanvasDock = memo(function CanvasDock({
  mode,
  canvasMode,
  connectionTool,
  canConnect,
  selectionCount,
  canFitAll,
  canFitSelection,
  canAutoArrange,
  canArrangeSelection = true,
  canMutateGeometry = true,
  shortcuts,
  onAction,
}: CanvasDockProps) {
  return (
    <div
      data-testid="canvas-dock"
      data-mode={mode}
      data-selection-count={selectionCount}
      role="toolbar"
      aria-label={t`Canvas Actions`}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full border border-border bg-card/90 p-1.5 shadow-2xl backdrop-blur-xl"
    >
      {canvasMode === 'edit' && (
        <>
          <ToolButton
            testId="dock-connect-derivative"
            label={t`Connect to derivative`}
            letter="D"
            shortcut={shortcuts.connectDerivative}
            active={connectionTool === 'connect-derivative'}
            disabled={!canConnect}
            onClick={() => onAction('connect-derivative')}
          />
          <ToolButton
            testId="dock-connect-source"
            label={t`Connect to source`}
            letter="S"
            shortcut={shortcuts.connectSource}
            active={connectionTool === 'connect-source'}
            disabled={!canConnect}
            onClick={() => onAction('connect-source')}
          />
          <ToolButton
            testId="dock-reverse-relationship"
            label={t`Reverse relationship tool`}
            letter="R"
            shortcut={shortcuts.reverseRelationship}
            active={connectionTool === 'reverse-relationship'}
            onClick={() => onAction('reverse-relationship-tool')}
          />
        </>
      )}
      {mode === 'idle' && (
        <>
          <DockButton
            testId="dock-fit-all"
            label={t`Fit all`}
            shortcut={shortcuts.fitAll}
            icon={<Maximize2 className="h-3.5 w-3.5" />}
            disabled={!canFitAll}
            onClick={() => onAction('fit-all')}
          />
          <DockButton
            testId="dock-fit-selection"
            label={t`Fit selection`}
            shortcut={shortcuts.fitSelection}
            icon={<Focus className="h-3.5 w-3.5" />}
            disabled={!canFitSelection}
            onClick={() => onAction('fit-selection')}
          />
          <DockButton
            testId="dock-reset-zoom"
            label={t`Reset 100%`}
            shortcut={shortcuts.resetZoom}
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={() => onAction('reset-zoom')}
          />
        </>
      )}
      {mode === 'single' && (
        <>
          <DockButton
            testId="dock-preview"
            label={t`Preview`}
            icon={<Eye className="h-3.5 w-3.5" />}
            onClick={() => onAction('preview-selection')}
          />
          <DockButton
            testId="dock-locate"
            label={t`Locate`}
            icon={<MapPin className="h-3.5 w-3.5" />}
            onClick={() => onAction('locate-selection')}
          />
          <DockButton
            testId="dock-inspect"
            label={t`Inspect`}
            shortcut={shortcuts.inspect}
            icon={<PanelRight className="h-3.5 w-3.5" />}
            onClick={() => onAction('open-inspector')}
          />
          <DockButton
            testId="dock-fit-selection"
            label={t`Fit selection`}
            shortcut={shortcuts.fitSelection}
            icon={<Focus className="h-3.5 w-3.5" />}
            disabled={!canFitSelection}
            onClick={() => onAction('fit-selection')}
          />
        </>
      )}
      {mode === 'multiple' && canvasMode !== 'view' && (
        <>
          <DockButton
            testId="dock-align-horizontal"
            label={t`Align Horizontally`}
            icon={<AlignCenterHorizontal className="h-3.5 w-3.5" />}
            disabled={!canMutateGeometry}
            onClick={() => onAction('align-horizontal')}
          />
          <DockButton
            testId="dock-align-vertical"
            label={t`Align Vertically`}
            icon={<AlignCenterVertical className="h-3.5 w-3.5" />}
            disabled={!canMutateGeometry}
            onClick={() => onAction('align-vertical')}
          />
          <DockButton
            testId="dock-arrange-selection"
            label={t`Arrange Subgraph`}
            icon={<Sparkles className="h-3.5 w-3.5" />}
            disabled={!canArrangeSelection}
            onClick={() => onAction('auto-arrange-selection')}
          />
        </>
      )}
      {canvasMode !== 'view' && (
        <DockButton
          testId="dock-auto-arrange"
          label={t`Auto-arrange`}
          shortcut={shortcuts.autoArrange}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          disabled={!canAutoArrange}
          onClick={() => onAction('auto-arrange-active')}
        />
      )}
    </div>
  )
}, areDockPropsEqual)

function areDockPropsEqual(previous: CanvasDockProps, next: CanvasDockProps) {
  return (
    previous.mode === next.mode &&
    previous.canvasMode === next.canvasMode &&
    previous.connectionTool === next.connectionTool &&
    previous.canConnect === next.canConnect &&
    previous.selectionCount === next.selectionCount &&
    previous.canFitAll === next.canFitAll &&
    previous.canFitSelection === next.canFitSelection &&
    previous.canAutoArrange === next.canAutoArrange &&
    previous.canArrangeSelection === next.canArrangeSelection &&
    previous.canMutateGeometry === next.canMutateGeometry &&
    previous.onAction === next.onAction &&
    Object.keys(previous.shortcuts).every(
      (key) =>
        previous.shortcuts[key as keyof CanvasDockProps['shortcuts']] ===
        next.shortcuts[key as keyof CanvasDockProps['shortcuts']]
    )
  )
}

function ToolButton({
  testId,
  label,
  letter,
  shortcut,
  active,
  disabled = false,
  onClick,
}: {
  testId: string
  label: string
  letter: string
  shortcut: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className={`inline-flex h-8 shrink-0 items-center justify-center rounded-full px-2 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40 ${active ? 'bg-primary-soft text-ink' : 'text-ink hover:bg-accent'}`}
      >
        {letter}
      </button>
    </Tooltip>
  )
}
