import type { CanvasBoardOwner } from './canvas-board-owner'
import type { CanvasCapability } from './canvas-mode-policy'
import type { CanvasOperationContext } from './canvas-operation'

export function enqueueCanvasMutation(
  owner: CanvasBoardOwner,
  capability: CanvasCapability,
  action: (context: CanvasOperationContext) => Promise<void>,
  allowed: () => boolean = () => true
) {
  const board = owner.getSnapshot()
  return owner.submit(
    { kind: 'mutation', capability, board },
    async (context) => {
      context.assertCurrent()
      if (!allowed()) throw new Error('Canvas changed. Try the command again.')
      await action(context)
    }
  )
}
