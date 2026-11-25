import type { NodeChange } from '@xyflow/react'

export function filterBlockedResizeChanges(
  changes: NodeChange[],
  isBlocked: (imageId: number) => boolean
) {
  const completed = new Set<number>()
  const accepted = changes.filter((change) => {
    if (!('id' in change) || !isBlocked(Number(change.id))) return true
    if (change.type === 'dimensions' && change.resizing === false)
      completed.add(Number(change.id))
    return change.type !== 'position' && change.type !== 'dimensions'
  })
  return { changes: accepted, completed: [...completed] }
}
