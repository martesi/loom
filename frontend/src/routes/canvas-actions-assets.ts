import { t } from '@lingui/core/macro'
import { ImageService } from '../../bindings/loom/internal/service'
import type { CanvasAction } from '../lib/action-catalog'
import { copyMedia } from '../lib/clipboard'
import type { CanvasActionsContext } from './canvas-actions-context'

export function canvasAssetActions(
  context: CanvasActionsContext
): CanvasAction[] {
  const {
    openAssets,
    reload,
    selection,
    selectAssets,
    selectedIds,
    remove,
    selectedImageRecords,
    setReveal,
    go,
    requestInspectorCommand,
    setCompressIds,
    canNavigateRelationship,
    relationshipActions,
    canRemoveRelationship,
    paste,
    undoActions,
    repoPath,
    data,
  } = context
  const selectedRelationships = (data.relationships ?? []).filter(
    (relationship) => selection.edges.includes(relationship.id)
  )
  return [
    {
      id: 'find-in-assets',
      label: t`Find in Assets`,
      description: t`Select and reveal the active asset in Assets`,
      category: t`Assets navigation`,
      aliases: [t`locate file`],
      context: t`Canvas selection`,
      enabled: selection.surface === 'canvas' && selectedIds().length > 0,
      disabledReason: t`Select a Canvas item`,
      execute: () => {
        const firstId = selectedIds()[0]
        if (firstId) {
          selectAssets([firstId])
          setReveal({ id: firstId, folder: null })
          openAssets()
        }
      },
    },
    {
      id: 'show-in-folders',
      label: t`Show in Folders`,
      description: t`Reveal the selected Asset in its physical directory`,
      category: t`Asset metadata and file`,
      aliases: [t`show file location`, t`browse path`],
      context: t`Asset selection`,
      enabled: selectedIds().length === 1,
      disabledReason: t`Select one Asset`,
      execute: () => {
        const id = selectedIds()[0]
        if (id) return go(id, true)
      },
    },
    {
      id: 'move-rename-file',
      label: t`Move or rename file path`,
      description: t`Open the Inspector file path field`,
      category: t`Asset metadata and file`,
      aliases: [t`rename asset`, t`move file`],
      context: t`Single Asset`,
      enabled: selectedIds().length === 1,
      disabledReason: t`Select one Asset`,
      execute: () => requestInspectorCommand('move-rename-file'),
    },
    {
      id: 'add-tag',
      label: t`Add tag`,
      description: t`Focus the Inspector tag field for the active selection`,
      category: t`Asset metadata and file`,
      aliases: [t`tag assets`, t`metadata`],
      context: t`Asset selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      execute: () => requestInspectorCommand('add-tag'),
    },
    {
      id: 'save-prompt',
      label: t`Save prompt`,
      description: t`Save the current prompt from the Inspector`,
      category: t`Asset metadata and file`,
      aliases: [t`edit prompt`, t`prompt text`],
      context: t`Asset selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      execute: () => requestInspectorCommand('save-prompt'),
    },
    {
      id: 'restore-from-trash',
      label: t`Restore from trash`,
      description: t`Return selected trashed assets to the repository`,
      category: t`Asset metadata and file`,
      aliases: [t`restore assets`],
      context: t`Asset selection`,
      enabled: selectedImageRecords.some((image) => image.trashed),
      disabledReason: t`Select a trashed Asset`,
      execute: () =>
        Promise.all(
          selectedImageRecords
            .filter((image) => image.trashed)
            .map((image) => ImageService.RestoreImage(repoPath, image.id))
        ).then(() => reload()),
    },
    {
      id: 'compress-selection',
      label: t`Compress selected assets`,
      description: t`Open compression settings for selected Assets`,
      category: t`Asset metadata and file`,
      aliases: [t`compress`, t`optimize media`],
      context: t`Asset selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select Assets`,
      execute: () => setCompressIds(selectedIds()),
    },
    {
      id: 'go-to-source',
      label: t`Go to source`,
      description: t`Navigate to the source asset of the selected relationship`,
      category: t`Relationships`,
      aliases: [t`source image`],
      context: t`Relationship or image`,
      enabled: canNavigateRelationship,
      disabledReason: t`Select a related image or relationship`,
      execute: () => {
        const relationship = relationshipActions[0]
        if (relationship) return go(relationship.sourceImageId)
      },
    },
    {
      id: 'go-to-derived',
      label: t`Go to derived`,
      description: t`Navigate to the derived asset of the selected relationship`,
      category: t`Relationships`,
      aliases: [t`derived image`],
      context: t`Relationship or image`,
      enabled: canNavigateRelationship,
      disabledReason: t`Select a related image or relationship`,
      execute: () => {
        const relationship = relationshipActions[0]
        if (relationship) return go(relationship.derivedImageId)
      },
    },
    {
      id: 'remove-selected-relationships',
      label: t`Remove selected relationships`,
      description: t`Unlink the selected Canvas relationships`,
      category: t`Relationships`,
      aliases: [t`unlink`],
      shortcut: 'Delete',
      shortcuts: ['Delete', 'Backspace'],
      context: t`Canvas relationships`,
      enabled:
        selection.surface === 'canvas' && selectedRelationships.length > 0,
      disabledReason: t`Select Canvas relationships`,
      dangerous: true,
      execute: () => remove(false),
    },
    {
      id: 'reverse-relationship',
      label: t`Reverse relationship`,
      description: t`Reverse the selected relationship`,
      category: t`Relationships`,
      aliases: [t`reverse edge`],
      context: t`One Canvas relationship`,
      enabled:
        selection.surface === 'canvas' && selectedRelationships.length === 1,
      disabledReason: t`Select one Canvas relationship`,
      execute: () => {
        const relationship = selectedRelationships[0]
        if (selectedRelationships.length !== 1 || !relationship) return
        return ImageService.ReverseRelationship(repoPath, relationship.id).then(
          () => reload()
        )
      },
    },
    {
      id: 'remove-relationship',
      label: t`Remove relationship`,
      description: t`Unlink the selected relationship`,
      category: t`Relationships`,
      aliases: [t`unlink`],
      context: t`One relationship`,
      enabled: canRemoveRelationship,
      disabledReason: t`Select one relationship`,
      dangerous: true,
      execute: () => {
        const relationship = relationshipActions[0]
        return relationship
          ? ImageService.UnlinkSource(repoPath, relationship.id).then(() =>
              reload()
            )
          : undefined
      },
    },
    {
      id: 'purge-selection',
      label: t`Permanently purge selected assets`,
      description: t`Permanently remove selected files and metadata`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`permanent delete`],
      shortcut: 'Shift+Delete',
      shortcuts: ['Shift+Delete', 'Shift+Backspace'],
      context: t`Active selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select assets to purge`,
      dangerous: true,
      execute: () => remove(true),
    },
    {
      id: 'copy-original',
      label: t`Copy original media`,
      description: t`Copy original files for the active selection`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`copy assets`],
      shortcut: 'Mod+C',
      context: t`Active selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select assets to copy`,
      execute: () => copyMedia(repoPath, selectedIds(), false),
    },
    {
      id: 'copy-converted',
      label: t`Copy converted media`,
      description: t`Copy converted output when a converter is available`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`convert and copy`],
      shortcut: 'Mod+Shift+C',
      context: t`Active selection`,
      enabled: selectedIds().length > 0,
      disabledReason: t`Select assets to copy`,
      execute: () => copyMedia(repoPath, selectedIds(), true),
    },
    {
      id: 'paste-media',
      label: t`Paste media`,
      description: t`Import copied or native clipboard media`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`paste files`],
      shortcut: 'Mod+V',
      context: t`Active surface`,
      enabled: true,
      execute: () => paste(),
    },
    {
      id: 'undo',
      label: t`Undo`,
      description: t`Undo the last repository operation`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`revert`],
      shortcut: 'Mod+Z',
      context: t`Workspace`,
      enabled: true,
      execute: undoActions.undo,
    },
    {
      id: 'redo',
      label: t`Redo`,
      description: t`Redo the last undone repository operation`,
      category: t`Clipboard and lifecycle`,
      aliases: [t`reapply`],
      shortcut: 'Mod+Shift+Z',
      shortcuts: ['Mod+Shift+Z', 'Ctrl+Y'],
      context: t`Workspace`,
      enabled: true,
      execute: undoActions.redo,
    },
  ]
}
