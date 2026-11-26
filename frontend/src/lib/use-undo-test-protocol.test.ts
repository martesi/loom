import { spyOn } from 'bun:test'
import { UndoService } from '../../bindings/loom/internal/service'

export function installUndoProtocolMocks() {
  const directions = new Map<string, string>()
  spyOn(UndoService, 'SelectHistoryReplay').mockImplementation(
    async (_repoPath, direction) =>
      ({
        repoPath: '/test',
        direction,
        revision: 1,
        cursor: 1,
        processEpoch: 'test-epoch',
        sequence: 1,
        kind: 'test',
        forward: '{}',
        inverse: '{}',
        createdAt: 'test',
        noOp: false,
        selectionHash: 'test-selection',
      }) as never
  )
  spyOn(UndoService, 'ReserveHistoryReplay').mockImplementation(
    async (_repoPath, requestID, selection) => {
      directions.set(requestID, selection.direction)
      return { state: 'reserved' } as never
    }
  )
  spyOn(UndoService, 'ExecuteHistoryReplay').mockImplementation(
    async (repoPath, requestID) => {
      const direction = directions.get(requestID)
      const result =
        direction === 'redo'
          ? await UndoService.RedoWithRequest(repoPath, requestID)
          : await UndoService.UndoWithRequest(repoPath, requestID)
      return { state: 'complete', result } as never
    }
  )
  spyOn(UndoService, 'SettleHistoryReplay').mockResolvedValue({
    state: 'sealed',
    result: { applied: false, error: 'sealed' },
  } as never)
  spyOn(UndoService, 'UndoWithRequest').mockResolvedValue({
    applied: false,
  } as never)
  spyOn(UndoService, 'RedoWithRequest').mockResolvedValue({
    applied: false,
  } as never)
}
