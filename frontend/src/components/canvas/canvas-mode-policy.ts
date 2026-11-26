export type CanvasInternalMode = 'legacy' | 'view' | 'edit'

export type CanvasCapability =
  | 'navigate'
  | 'select'
  | 'copy'
  | 'history'
  | 'metadata'
  | 'lifecycle'
  | 'relationship'
  | 'geometry'
  | 'canvas-drop'

export function allowsCanvasCapability(
  mode: CanvasInternalMode,
  capability: CanvasCapability
): boolean {
  return (
    mode !== 'view' ||
    (capability !== 'relationship' &&
      capability !== 'geometry' &&
      capability !== 'canvas-drop')
  )
}

const actionCapabilities: Readonly<Record<string, CanvasCapability>> = {
  'open-assets': 'navigate',
  'toggle-assets': 'navigate',
  'close-assets': 'navigate',
  'pin-assets': 'navigate',
  'unpin-assets': 'navigate',
  'open-inspector': 'navigate',
  'toggle-inspector': 'navigate',
  'close-inspector': 'navigate',
  'pin-inspector': 'navigate',
  'unpin-inspector': 'navigate',
  'toggle-focus-canvas': 'navigate',
  'show-shortcuts': 'navigate',
  'open-settings': 'navigate',
  'open-appearance-settings': 'navigate',
  'show-commands': 'navigate',
  'rescan-repository': 'lifecycle',
  'switch-repository': 'navigate',
  'import-media': 'lifecycle',
  'show-all-assets': 'navigate',
  'show-folders': 'navigate',
  'assets-gallery-view': 'navigate',
  'assets-list-view': 'navigate',
  'assets-gallery-smaller': 'navigate',
  'assets-gallery-larger': 'navigate',
  'focus-asset-search': 'navigate',
  'search-assets': 'navigate',
  'fit-all': 'navigate',
  'fit-selection': 'navigate',
  'reset-zoom': 'navigate',
  'zoom-in': 'navigate',
  'zoom-out': 'navigate',
  'auto-arrange-active': 'geometry',
  'auto-arrange-selection': 'geometry',
  'select-all': 'select',
  'select-all-canvas': 'select',
  'clear-selection': 'select',
  'preview-selection': 'navigate',
  'locate-selection': 'navigate',
  'align-horizontal': 'geometry',
  'align-vertical': 'geometry',
  'trash-selection': 'lifecycle',
  'archive-selection': 'metadata',
  'unarchive-selection': 'metadata',
  'find-in-assets': 'navigate',
  'show-in-folders': 'navigate',
  'move-rename-file': 'metadata',
  'add-tag': 'metadata',
  'save-prompt': 'metadata',
  'restore-from-trash': 'lifecycle',
  'compress-selection': 'metadata',
  'go-to-source': 'navigate',
  'go-to-derived': 'navigate',
  'remove-selected-relationships': 'relationship',
  'reverse-relationship': 'relationship',
  'remove-relationship': 'relationship',
  'connect-derivative': 'relationship',
  'connect-source': 'relationship',
  'reverse-relationship-tool': 'relationship',
  'purge-selection': 'lifecycle',
  'copy-original': 'copy',
  'copy-converted': 'copy',
  'paste-media': 'lifecycle',
  undo: 'history',
  redo: 'history',
}

export function allowsCanvasAction(mode: CanvasInternalMode, id: string) {
  const capability = canvasActionCapability(id)
  return capability
    ? allowsCanvasCapability(mode, capability)
    : mode === 'legacy'
}

export function canvasActionCapability(
  id: string
): CanvasCapability | undefined {
  // The frontend targets ES2021, before Object.hasOwn was added.
  // biome-ignore lint/suspicious/noPrototypeBuiltins: use the safe prototype call for this target.
  return Object.prototype.hasOwnProperty.call(actionCapabilities, id)
    ? actionCapabilities[id]
    : undefined
}
