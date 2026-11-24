import { t } from '@lingui/core/macro'
import type { CanvasData } from '../../../bindings/loom/internal/service'
import type { CanvasAction } from '../../lib/action-catalog'
import type { MenuAction } from '../menu'

export interface CanvasMenuState {
  kind: 'pane' | 'node' | 'selection' | 'edge'
  x: number
  y: number
  nodeId?: string
}

interface Props {
  menu: CanvasMenuState | null
  actions: ReadonlyMap<string, CanvasAction>
  data: CanvasData
  execute: (action: CanvasAction) => Promise<unknown>
}

export function createCanvasMenuItems({
  menu,
  actions,
  data,
  execute,
}: Props): MenuAction[] {
  function menuAction(
    id: string,
    key = id,
    label?: string,
    separatorBefore = false
  ): MenuAction {
    const action = actions.get(id)
    return {
      key,
      label: label ?? action?.label ?? id,
      disabled: !action?.enabled,
      danger: action?.dangerous,
      separatorBefore,
      onSelect: () => {
        if (action) void execute(action)
      },
    }
  }

  if (!menu) return []
  const showCommands = menuAction('show-commands')
  if (menu.kind === 'edge')
    return [
      menuAction('reverse-relationship'),
      menuAction('remove-selected-relationships'),
      showCommands,
    ]
  if (menu.kind === 'pane')
    return [
      menuAction('select-all-canvas'),
      menuAction('auto-arrange-active', 'auto-arrange'),
      showCommands,
    ]
  if (menu.kind === 'selection')
    return [
      menuAction('create-set'),
      menuAction('auto-arrange-selection'),
      menuAction(
        'unplace-selection',
        'remove-from-canvas',
        t`Remove from canvas`,
        true
      ),
      menuAction('trash-canvas-selection', 'trash', t`Trash selection`),
      showCommands,
    ]
  const nodeId = menu.nodeId
  if (!nodeId) return [showCommands]
  if (nodeId.startsWith('set-'))
    return [menuAction('dissolve-set'), showCommands]
  const image = (data.images ?? []).find(
    (candidate) => candidate.id === Number(nodeId)
  )
  if (!image) return [showCommands]
  return [
    menuAction('find-in-assets', 'find-assets', t`Find in Assets`),
    menuAction('unplace-selection', 'remove', t`Remove from canvas`, true),
    image.archived
      ? menuAction('unarchive-selection', 'archive')
      : menuAction('archive-selection', 'archive'),
    menuAction('trash-canvas-selection', 'trash', t`Trash`),
    showCommands,
  ]
}
