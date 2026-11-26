import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { isCanvasOperationPending } from './canvas-operation'
import { canvasEffects, runCanvasEffectBatch } from './canvas-operation-effects'
import { refreshBoard } from './canvas-operation-test-utils'

mock.module('@lingui/core/macro', () => ({
  plural: (count: number, messages: { one: string; other: string }) =>
    (count === 1 ? messages.one : messages.other).replace('#', String(count)),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (message, part, index) =>
        `${message}${part}${String(values[index] ?? '')}`,
      ''
    ),
}))
const { useCanvasActionSystem } = await import('./use-canvas-action-system')

afterEach(() => {
  cleanup()
  mock.restore()
})

for (const operation of [
  { id: 'archive-selection', name: 'archive', archived: false, trashed: false },
  {
    id: 'unarchive-selection',
    name: 'unarchive',
    archived: true,
    trashed: false,
  },
  { id: 'restore-from-trash', name: 'restore', archived: false, trashed: true },
] as const) {
  it(`${operation.name} waits for every started write before reconciliation and reports partial failure`, async () => {
    const repoPath = `/repo-batch-${operation.name}`
    const events: string[] = []
    const images = [1, 2].map((id) => ({
      id,
      fileName: `${id}.png`,
      filePath: `${id}.png`,
      archived: operation.archived,
      trashed: operation.trashed,
      placed: false,
      missing: false,
    }))
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
      images,
      relationships: [],
      groups: [],
    } as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
      revision: '1',
      images: [1, 2].map((id) => ({
        id,
        width: 640,
        height: 480,
        geometry: { imageId: id, x: id * 10, y: 0, w: 150, h: 110 },
      })),
      relationships: [],
    } as never)

    let releaseSlowWrite = () => {}
    let signalSlowWrite = () => {}
    const slowWriteStarted = new Promise<void>((resolve) => {
      signalSlowWrite = resolve
    })
    const slowWrite = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve
    })
    const write = (id: number) => {
      events.push(`write-${id}-start`)
      if (id === 1) {
        events.push('write-1-failed')
        return Promise.reject(new Error('controlled sibling failure'))
      }
      signalSlowWrite()
      return slowWrite.then(() => {
        events.push('write-2-settled')
      })
    }
    if (operation.id === 'restore-from-trash')
      spyOn(ImageService, 'RestoreImage').mockImplementation(
        (_path, id) => write(id) as never
      )
    else
      spyOn(ImageService, 'SetArchived').mockImplementation(
        (_path, id) => write(id) as never
      )

    const owner = createCanvasBoardOwner(repoPath)
    await refreshBoard(owner)
    const reload = spyOn(ImageService, 'LoadCanvas').mockImplementation(() => {
      events.push('reconcile')
      return Promise.resolve({ images, relationships: [], groups: [] }) as never
    })
    reload.mockClear()
    spyOn(console, 'error').mockImplementation(() => {})
    const report = mock()
    const selectedImageRecords = images
    const selection = {
      ...emptySelection,
      surface: 'assets' as const,
      ids: [1, 2],
    }
    const context = {
      owner,
      repoPath,
      importInput: { current: null },
      assetsOpen: false,
      assetsPinned: false,
      openAssets: mock(),
      toggleAssets: mock(),
      closeAssets: mock(),
      setAssetsPinned: mock(),
      inspectorOpen: false,
      inspectorPinned: false,
      openInspector: mock(),
      toggleInspector: mock(),
      closeInspector: mock(),
      setInspectorPinned: mock(),
      toggleFocusMode: mock(),
      openSettings: mock(),
      openPalette: mock(),
      setRepoOpenRequest: mock(),
      setNavigatorModeRequest: mock(),
      setSearchFocusRequest: mock(),
      displayNodes: [],
      canFitSelection: false,
      canArrangeSelection: false,
      fitAll: mock(async () => {}),
      fitSelection: mock(async () => {}),
      resetZoom: mock(async () => {}),
      zoomBy: mock(async () => {}),
      arrange: mock(async () => {}),
      selectedCanvasNodeIds: [],
      visible: { current: [1, 2] },
      selection,
      selectAssets: mock(),
      setSelection: mock(),
      data: { images, relationships: [], groups: [] },
      alignHorizontal: mock(async () => {}),
      alignVertical: mock(async () => {}),
      selectedIds: () => [1, 2],
      confirmTrash: mock(),
      remove: mock(async () => {}),
      selectedImageRecords,
      handlePreview: mock(),
      handleLocate: mock(),
      setReveal: mock(),
      go: mock(async () => {}),
      requestInspectorCommand: mock(),
      setCompressIds: mock(),
      setExpanded: mock(),
      expanded: null,
      canNavigateRelationship: false,
      relationshipActions: [],
      canRemoveRelationship: false,
      paste: mock(async () => {}),
      undoActions: { undo: mock(async () => {}), redo: mock(async () => {}) },
    } as unknown as CanvasActionsContext
    const { result } = renderHook(() =>
      useCanvasActionSystem({
        context,
        report,
        paletteOpen: false,
        setPaletteOpen: mock(),
        setRecentActionIds: mock(),
        pendingRecentAction: useRef(null),
        trashIds: null,
        purgeIds: null,
        host: useRef(null),
        paletteAssetRequest: 0,
        setPaletteAssets: mock(),
        setPaletteAssetsLoading: mock(),
        setPaletteAssetsError: mock(),
      })
    )
    const action = result.current.actionById.get(operation.id)
    if (!action) throw new Error(`missing ${operation.id} action`)
    const actionPromise = result.current.executeAction(action)
    await slowWriteStarted
    const followup = owner.submit(
      { kind: 'history', board: owner.getSnapshot() },
      async () => {
        events.push('history-followup')
      }
    )

    expect(events).not.toContain('reconcile')
    expect(events).not.toContain('history-followup')
    expect(report).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()

    releaseSlowWrite()
    await Promise.all([actionPromise, followup])

    expect(events.indexOf('write-2-settled')).toBeLessThan(
      events.indexOf('reconcile')
    )
    expect(events.indexOf('reconcile')).toBeLessThan(
      events.indexOf('history-followup')
    )
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining('may be incomplete'),
    })
    expect(reload).toHaveBeenCalledTimes(1)
    owner.dispose()
  })
}

for (const operation of [
  { name: 'archive', restore: false },
  { name: 'unarchive', restore: false },
  { name: 'restore', restore: true },
] as const) {
  it(`${operation.name} disposal preserves partial failure and releases the replacement gate`, async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    const repoPath = `/repo-disposed-batch-${operation.name}`
    const images = [1, 2].map((id) => ({ id }))
    spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
      images,
      relationships: [],
      groups: [],
    } as never)
    spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
      revision: '1',
      images: [],
      relationships: [],
    } as never)
    let releaseCommitted!: () => void
    let signalCommitted!: () => void
    const committed = new Promise<void>((resolve) => {
      releaseCommitted = resolve
    })
    const started = new Promise<void>((resolve) => {
      signalCommitted = resolve
    })
    const serviceWrite = (_path: string, id: number) => {
      if (id === 1) return Promise.reject(new Error('first write failed'))
      signalCommitted()
      return committed
    }
    if (operation.restore)
      spyOn(ImageService, 'RestoreImage').mockImplementation(
        serviceWrite as never
      )
    else
      spyOn(ImageService, 'SetArchived').mockImplementation(
        serviceWrite as never
      )

    const owner = createCanvasBoardOwner(repoPath, true)
    expect((await owner.activate()).status).toBe('success')
    const board = owner.getSnapshot()
    if (!board) throw new Error('expected an active board')
    const action = owner.submit(
      { kind: 'mutation', capability: 'lifecycle', board },
      (context) =>
        runCanvasEffectBatch(operation.name, [1, 2], (id) =>
          operation.restore
            ? canvasEffects.restoreImage(context, repoPath, id)
            : canvasEffects.setArchived(
                context,
                repoPath,
                id,
                operation.name === 'archive'
              )
        )
    )
    await started
    owner.dispose()
    releaseCommitted()
    expect(await action).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining('Asset 1: first write failed'),
      },
    })
    expect(isCanvasOperationPending(repoPath)).toBe(false)

    const replacement = createCanvasBoardOwner(repoPath, true)
    expect((await replacement.activate()).status).toBe('success')
    expect(replacement.isLayoutPending()).toBe(false)
    const freshBoard = replacement.getSnapshot()
    if (!freshBoard) throw new Error('expected replacement board')
    const subsequent = await replacement.submit(
      { kind: 'mutation', capability: 'lifecycle', board: freshBoard },
      (context) => context.effect(async () => {})
    )
    expect(subsequent.status).toBe('success')
    expect(replacement.isLayoutPending()).toBe(false)
    replacement.dispose()
  })
}
