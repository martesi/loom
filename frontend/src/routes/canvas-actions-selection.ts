import { t } from '@lingui/core/macro'
import {
  canvasEffects,
  runCanvasEffectBatch,
} from '../components/canvas/canvas-operation-effects'
import type { CanvasAction } from '../lib/action-catalog'
import { emptySelection } from '../lib/selection'
import type { CanvasActionsContext } from './canvas-actions-context'

export function canvasSelectionActions(
  context: CanvasActionsContext
): CanvasAction[] {
  const {
    displayNodes,
    selectedCanvasNodeIds,
    handlePreview,
    handleLocate,
    visible,
    selection,
    selectAssets,
    setSelection,
    data,
    alignHorizontal,
    alignVertical,
    selectedIds,
    remove,
    selectedImageRecords,
    repoPath,
  } = context
  return [
    {
      id: 'select-all',
      label: t`Select all in active surface`,
      description: t`Select all visible Assets or placed Canvas items`,
      category: t`Selection`,
      aliases: [t`select everything`],
      shortcut: 'Mod+A',
      context: t`Active surface`,
      enabled: visible.current.length > 0 || displayNodes.length > 0,
      disabledReason: t`There are no selectable items`,
      execute: () => {
        if (selection.surface === 'assets') selectAssets(visible.current)
        else
          setSelection({
            surface: 'canvas',
            ids:
              context.owner.getMode() === 'legacy'
                ? (data.images ?? [])
                    .filter((image) => image.placed && !image.trashed)
                    .map((image) => image.id)
                : displayNodes.map((node) => Number(node.id)),
            edges: [],
            group: null,
          })
      },
    },
    {
      id: 'select-all-canvas',
      label: t`Select all`,
      description: t`Select every placed Canvas item`,
      category: t`Selection`,
      aliases: [t`select all canvas items`],
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: () =>
        setSelection({
          surface: 'canvas',
          ids:
            context.owner.getMode() === 'legacy'
              ? (data.images ?? [])
                  .filter((image) => image.placed && !image.trashed)
                  .map((image) => image.id)
              : displayNodes.map((node) => Number(node.id)),
          edges: [],
          group: null,
        }),
    },
    {
      id: 'clear-selection',
      label: t`Clear selection`,
      description: t`Clear the active selection`,
      category: t`Selection`,
      aliases: [t`deselect`],
      shortcut: 'Escape',
      context: t`Active surface`,
      enabled:
        selection.ids.length > 0 ||
        selection.edges.length > 0 ||
        !!selection.group,
      disabledReason: t`There is no active selection`,
      execute: () => setSelection(emptySelection),
    },
    {
      id: 'preview-selection',
      label: t`Preview`,
      description: t`Open the selected Canvas image in the preview viewer`,
      category: t`Selection`,
      aliases: [t`lightbox`, t`view image`],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length === 1,
      disabledReason: t`Select one Canvas item`,
      execute: () => {
        const node = displayNodes.find((candidate) => candidate.selected)
        if (node) handlePreview(node)
      },
    },
    {
      id: 'locate-selection',
      label: t`Locate in Assets`,
      description: t`Reveal the selected Canvas item in Assets`,
      category: t`Selection`,
      aliases: [t`find in assets`, t`show in library`],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length === 1,
      disabledReason: t`Select one Canvas item`,
      execute: () => {
        const node = displayNodes.find((candidate) => candidate.selected)
        if (node) handleLocate(node)
      },
    },
    {
      id: 'align-horizontal',
      label: t`Align horizontally`,
      description: t`Align selected Canvas items along one row`,
      category: t`Selection`,
      aliases: [t`align row`],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length > 1,
      disabledReason: t`Select at least two Canvas items`,
      execute: (operation) => {
        if (!operation) throw new Error('Canvas operation context is required.')
        return alignHorizontal(operation)
      },
    },
    {
      id: 'align-vertical',
      label: t`Align vertically`,
      description: t`Align selected Canvas items along one column`,
      category: t`Selection`,
      aliases: [t`align column`],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length > 1,
      disabledReason: t`Select at least two Canvas items`,
      execute: (operation) => {
        if (!operation) throw new Error('Canvas operation context is required.')
        return alignVertical(operation)
      },
    },
    {
      id: 'trash-selection',
      label: t`Trash selected Assets`,
      description: t`Move selected Assets to the repository trash`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`delete assets`],
      shortcut: 'Delete',
      shortcuts: ['Delete', 'Backspace'],
      context: t`Assets selection`,
      enabled: selection.surface === 'assets' && selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      dangerous: true,
      execute: () => remove(false),
    },
    {
      id: 'archive-selection',
      label: t`Archive`,
      description: t`Hide selected assets from the active catalog`,
      category: t`Asset metadata and file`,
      aliases: [t`hide assets`],
      context: t`Assets selection`,
      enabled: selectedImageRecords.some((image) => !image.archived),
      disabledReason: t`Select an unarchived Asset`,
      execute: () =>
        context.owner.submit(
          {
            kind: 'mutation',
            capability: 'metadata',
            board: context.owner.getSnapshot(),
          },
          async (operation) => {
            const ids = selectedIds()
            await runCanvasEffectBatch('archive', ids, (id) =>
              canvasEffects.setArchived(operation, repoPath, id, true)
            )
          }
        ),
    },
    {
      id: 'unarchive-selection',
      label: t`Unarchive`,
      description: t`Return selected assets to the active catalog`,
      category: t`Asset metadata and file`,
      aliases: [t`show archived assets`],
      context: t`Assets selection`,
      enabled: selectedImageRecords.some((image) => image.archived),
      disabledReason: t`Select an archived Asset`,
      execute: () =>
        context.owner.submit(
          {
            kind: 'mutation',
            capability: 'metadata',
            board: context.owner.getSnapshot(),
          },
          async (operation) => {
            const ids = selectedIds()
            await runCanvasEffectBatch('unarchive', ids, (id) =>
              canvasEffects.setArchived(operation, repoPath, id, false)
            )
          }
        ),
    },
  ]
}
