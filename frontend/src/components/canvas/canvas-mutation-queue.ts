import type { CanvasBoardOwner } from './canvas-board-owner'
import { allowsCanvasCapability } from './canvas-mode-policy'

export function enqueueCanvasMutation(
  owner: CanvasBoardOwner,
  capability: 'geometry' | 'relationship',
  action: () => Promise<void>,
  allowed: () => boolean = () => true
) {
  const revision = owner.getModeRevision()
  const lifetime = owner.getLifetimeRevision()
  const board = owner.getSnapshot()
  owner.cancelGesture()
  return owner.admit(async () => {
    if (owner.isActive?.() === false) return
    if (
      revision !== owner.getModeRevision() ||
      lifetime !== owner.getLifetimeRevision() ||
      board !== owner.getSnapshot() ||
      !allowsCanvasCapability(owner.getMode(), capability) ||
      !allowed()
    )
      throw new Error('Canvas changed. Try the command again.')
    await action()
  })
}
