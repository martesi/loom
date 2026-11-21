import { t } from '@lingui/core/macro'
import type { CanvasAction } from '../lib/action-catalog'
import type { CanvasActionsContext } from './canvas-actions-context'

export function canvasViewActions(
  context: CanvasActionsContext
): CanvasAction[] {
  const {
    displayNodes,
    canFitSelection,
    canArrangeSelection,
    fitAll,
    fitSelection,
    resetZoom,
    zoomBy,
    arrange,
    selectedCanvasNodeIds,
  } = context
  return [
    {
      id: 'fit-all',
      label: t`Fit all`,
      description: t`Frame every placed item in the Canvas`,
      category: t`Canvas view`,
      aliases: [t`zoom extents`, t`frame canvas`],
      shortcut: 'Shift+1',
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: fitAll,
    },
    {
      id: 'fit-selection',
      label: t`Fit selection`,
      description: t`Frame the selected Canvas items`,
      category: t`Canvas view`,
      aliases: [t`zoom to selection`, t`selection bounds`],
      shortcut: 'Shift+2',
      context: t`Canvas selection`,
      enabled: canFitSelection,
      disabledReason: t`Select a Canvas item`,
      execute: fitSelection,
    },
    {
      id: 'reset-zoom',
      label: t`Reset zoom to 100%`,
      description: t`Set Canvas zoom to its original scale`,
      category: t`Canvas view`,
      aliases: [t`actual size`, t`zoom reset`],
      shortcut: 'Mod+0',
      context: t`Canvas`,
      enabled: true,
      execute: resetZoom,
    },
    {
      id: 'zoom-in',
      label: t`Zoom in`,
      description: t`Increase Canvas zoom`,
      category: t`Canvas view`,
      aliases: [t`magnify`],
      shortcut: 'Mod+=',
      context: t`Canvas`,
      enabled: true,
      execute: () => zoomBy(1.2),
    },
    {
      id: 'zoom-out',
      label: t`Zoom out`,
      description: t`Decrease Canvas zoom`,
      category: t`Canvas view`,
      aliases: [t`shrink`],
      shortcut: 'Mod+-',
      context: t`Canvas`,
      enabled: true,
      execute: () => zoomBy(1 / 1.2),
    },
    {
      id: 'auto-arrange-canvas',
      label: t`Auto-arrange Canvas`,
      description: t`Reposition all placed items using their relationships`,
      category: t`Canvas view`,
      aliases: [t`layout`, t`tidy all`],
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: () => arrange(),
    },
    {
      id: 'auto-arrange-active',
      label: t`Auto-arrange Canvas or selection`,
      description: t`Arrange the selected subgraph, or the full Canvas when fewer than two items are selected`,
      category: t`Canvas view`,
      aliases: [t`layout`, t`tidy selection`, t`tidy all`],
      shortcut: 'Shift+A',
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: () =>
        arrange(
          selectedCanvasNodeIds.length >= 2 ? selectedCanvasNodeIds : undefined
        ),
    },
    {
      id: 'auto-arrange-selection',
      label: t`Auto-arrange selection`,
      description: t`Reposition selected items as a connected subgraph`,
      category: t`Canvas view`,
      aliases: [t`arrange subgraph`, t`tidy selection`],
      context: t`Canvas selection`,
      enabled: canArrangeSelection,
      disabledReason: t`Select Canvas items`,
      execute: () => arrange(selectedCanvasNodeIds),
    },
  ]
}
