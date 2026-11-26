import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import { createCanvasBoardOwner } from './canvas-board-owner'
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
