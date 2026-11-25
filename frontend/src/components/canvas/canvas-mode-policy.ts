export type CanvasInternalMode = 'legacy' | 'view' | 'edit'

export type CanvasCapability =
  | 'navigate'
  | 'select'
  | 'copy'
  | 'history'
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
  'auto-arrange-active': 'geometry',
  'auto-arrange-selection': 'geometry',
  'align-horizontal': 'geometry',
  'align-vertical': 'geometry',
  'remove-selected-relationships': 'relationship',
  'reverse-relationship': 'relationship',
  'remove-relationship': 'relationship',
}

export function allowsCanvasAction(mode: CanvasInternalMode, id: string) {
  const capability = actionCapabilities[id]
  return !capability || allowsCanvasCapability(mode, capability)
}

export function canvasActionCapability(
  id: string
): CanvasCapability | undefined {
  return actionCapabilities[id]
}
