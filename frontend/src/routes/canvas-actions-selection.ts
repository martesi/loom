import { t } from '@lingui/core/macro'
import {
  GroupService,
  ImageService,
} from '../../bindings/loom/internal/service'
import type { CanvasAction } from '../lib/action-catalog'
import { emptySelection } from '../lib/selection'
import type { CanvasActionsContext } from './canvas-actions-context'

export function canvasSelectionActions(
  context: CanvasActionsContext
): CanvasAction[] {
  const {
    reload,
    displayNodes,
    selectedCanvasNodeIds,
    handlePreview,
    handleLocate,
    visible,
    selection,
    selectAssets,
    setSelection,
    data,
    canCreateSet,
    createSet,
    alignHorizontal,
    alignVertical,
    selectedIds,
    confirmTrash,
    remove,
    selectedImageRecords,
    repoPath,
  } = context
  return [
    {
      id: 'select-all',
      label: t`Select all in active surface`,
      description: t`Select all visible Assets or placed Canvas items`,
      category: t`Selection and sets`,
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
            ids: (data.images ?? [])
              .filter((image) => image.placed && !image.trashed)
              .map((image) => image.id),
            edges: [],
            group: null,
          })
      },
    },
    {
      id: 'select-all-canvas',
      label: t`Select all`,
      description: t`Select every placed Canvas item`,
      category: t`Selection and sets`,
      aliases: [t`select all canvas items`],
      context: t`Canvas`,
      enabled: displayNodes.length > 0,
      disabledReason: t`There are no placed items`,
      execute: () =>
        setSelection({
          surface: 'canvas',
          ids: (data.images ?? [])
            .filter((image) => image.placed && !image.trashed)
            .map((image) => image.id),
          edges: [],
          group: null,
        }),
    },
    {
      id: 'clear-selection',
      label: t`Clear selection`,
      description: t`Clear the active selection`,
      category: t`Selection and sets`,
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
      category: t`Selection and sets`,
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
      category: t`Selection and sets`,
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
      id: 'create-set',
      label: t`Create set`,
      description: t`Create a semantic set from selected Canvas items`,
      category: t`Selection and sets`,
      aliases: [t`group`, t`collection`],
      shortcut: 'Mod+G',
      context: t`Canvas selection`,
      enabled: canCreateSet,
      disabledReason: t`Select at least two ungrouped Canvas items`,
      execute: createSet,
    },
    {
      id: 'align-horizontal',
      label: t`Align horizontally`,
      description: t`Align selected Canvas items along one row`,
      category: t`Selection and sets`,
      aliases: [t`align row`],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length > 1,
      disabledReason: t`Select at least two Canvas items`,
      execute: alignHorizontal,
    },
    {
      id: 'align-vertical',
      label: t`Align vertically`,
      description: t`Align selected Canvas items along one column`,
      category: t`Selection and sets`,
      aliases: [t`align column`],
      context: t`Canvas selection`,
      enabled: selectedCanvasNodeIds.length > 1,
      disabledReason: t`Select at least two Canvas items`,
      execute: alignVertical,
    },
    {
      id: 'unplace-selection',
      label: t`Unplace selected Canvas items`,
      description: t`Remove selected nodes while keeping their assets`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`remove from canvas`],
      shortcut: 'Delete',
      shortcuts: ['Delete', 'Backspace'],
      context: t`Canvas selection`,
      enabled:
        selection.surface === 'canvas' &&
        (selectedIds().length > 0 || selection.edges.length > 0),
      disabledReason: t`Select Canvas items`,
      execute: () =>
        selection.surface === 'assets'
          ? confirmTrash(selectedIds())
          : remove(false),
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
      id: 'trash-canvas-selection',
      label: t`Trash selection`,
      description: t`Move selected Canvas assets to repository trash`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`trash canvas items`],
      context: t`Canvas selection`,
      enabled: selection.surface === 'canvas' && selectedIds().length > 0,
      disabledReason: t`Select Canvas items`,
      dangerous: true,
      execute: () => confirmTrash(selectedIds()),
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
        Promise.all(
          selectedIds().map((id) =>
            ImageService.SetArchived(repoPath, id, true)
          )
        ).then(() => reload()),
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
        Promise.all(
          selectedIds().map((id) =>
            ImageService.SetArchived(repoPath, id, false)
          )
        ).then(() => reload()),
    },
    {
      id: 'dissolve-set',
      label: t`Dissolve set`,
      description: t`Remove the selected set while keeping its assets`,
      category: t`Selection and sets`,
      aliases: [t`ungroup`],
      context: t`Set selection`,
      enabled: selection.group !== null,
      disabledReason: t`Select a set`,
      execute: () =>
        selection.group
          ? GroupService.Ungroup(repoPath, selection.group).then(() => reload())
          : undefined,
    },
  ]
}
