import { afterEach, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import { createCanvasBoardOwner } from './canvas-board-owner'
import type { PaletteAsset } from './command-palette'

mock.module('@lingui/core/macro', () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (message, part, index) =>
        `${message}${part}${String(values[index] ?? '')}`,
      ''
    ),
}))
const { useCanvasActionSystem } = await import('./use-canvas-action-system')

afterEach(cleanup)

it('rechecks the current mode when a previously enabled action reaches the queue', async () => {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  const arrange = mock(async () => {})
  const context = {
    owner,
    repoPath: '/repo',
    displayNodes: [{ id: '1' }],
    selectedCanvasNodeIds: [],
    selectedIds: () => [],
    selectedImageRecords: [],
    relationshipActions: [],
    visible: { current: [] },
    selection: { surface: 'canvas', ids: [], edges: [], group: null },
    data: { images: [], relationships: [], groups: [] },
    arrange,
    undoActions: { undo: async () => {}, redo: async () => {} },
  } as unknown as CanvasActionsContext
  const { result } = renderHook(() => {
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [, setRecentActionIds] = useState<string[]>([])
    const [, setPaletteAssets] = useState<PaletteAsset[]>([])
    const [, setPaletteAssetsLoading] = useState(false)
    const [, setPaletteAssetsError] = useState(false)
    return useCanvasActionSystem({
      context,
      report: mock(),
      paletteOpen,
      setPaletteOpen,
      setRecentActionIds,
      pendingRecentAction: useRef(null),
      trashIds: null,
      purgeIds: null,
      host: useRef(null),
      paletteAssetRequest: 0,
      setPaletteAssets,
      setPaletteAssetsLoading,
      setPaletteAssetsError,
    })
  })
  const action = result.current.actionById.get('auto-arrange-active')
  if (!action) throw new Error('missing arrange action')
  expect(action.enabled).toBe(true)
  let release = () => {}
  const blocker = owner.execute(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await Promise.resolve()
  const queued = result.current.executeAction(action)
  owner.setMode('view')
  await act(async () => {
    release()
    await blocker
    await queued
  })
  expect(arrange).not.toHaveBeenCalled()
  owner.setMode('edit')
  await act(async () => {
    await result.current.executeAction(action)
  })
  expect(arrange).toHaveBeenCalledTimes(1)
})
