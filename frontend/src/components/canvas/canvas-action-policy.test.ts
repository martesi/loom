import { afterEach, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import { createCanvasBoardOwner } from './canvas-board-owner'
import {
  allowsCanvasAction,
  type CanvasCapability,
  canvasActionCapability,
} from './canvas-mode-policy'
import type { PaletteAsset } from './command-palette'

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

const expectedCapabilities: Record<
  Exclude<CanvasCapability, 'canvas-drop'>,
  string[]
> = {
  navigate: [
    'open-assets',
    'toggle-assets',
    'close-assets',
    'pin-assets',
    'unpin-assets',
    'open-inspector',
    'toggle-inspector',
    'close-inspector',
    'pin-inspector',
    'unpin-inspector',
    'toggle-focus-canvas',
    'show-shortcuts',
    'open-settings',
    'open-appearance-settings',
    'show-commands',
    'switch-repository',
    'show-all-assets',
    'show-folders',
    'assets-gallery-view',
    'assets-list-view',
    'assets-gallery-smaller',
    'assets-gallery-larger',
    'focus-asset-search',
    'search-assets',
    'fit-all',
    'fit-selection',
    'reset-zoom',
    'zoom-in',
    'zoom-out',
    'preview-selection',
    'locate-selection',
    'find-in-assets',
    'show-in-folders',
    'go-to-source',
    'go-to-derived',
  ],
  select: ['select-all', 'select-all-canvas', 'clear-selection'],
  copy: ['copy-original', 'copy-converted'],
  history: ['undo', 'redo'],
  metadata: [
    'archive-selection',
    'unarchive-selection',
    'move-rename-file',
    'add-tag',
    'save-prompt',
    'compress-selection',
  ],
  lifecycle: [
    'rescan-repository',
    'import-media',
    'trash-selection',
    'restore-from-trash',
    'purge-selection',
    'paste-media',
  ],
  geometry: [
    'auto-arrange-active',
    'auto-arrange-selection',
    'align-horizontal',
    'align-vertical',
  ],
  relationship: [
    'remove-selected-relationships',
    'reverse-relationship',
    'remove-relationship',
  ],
}

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
  const expected = new Map(
    Object.entries(expectedCapabilities).flatMap(([capability, ids]) =>
      ids.map((id) => [id, capability] as const)
    )
  )
  expect(result.current.actionCatalog.map((item) => item.id).sort()).toEqual(
    [...expected.keys()].sort()
  )
  for (const { id } of result.current.actionCatalog) {
    const capability = expected.get(id)
    expect(canvasActionCapability(id)).toBe(capability)
    for (const mode of ['legacy', 'view', 'edit'] as const)
      expect(allowsCanvasAction(mode, id)).toBe(
        mode !== 'view' ||
          (capability !== 'geometry' && capability !== 'relationship')
      )
  }
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

it('denies unknown actions in View and Edit, but preserves legacy behavior', () => {
  for (const id of ['future-mutation', 'toString', '__proto__']) {
    expect(canvasActionCapability(id)).toBeUndefined()
    expect(allowsCanvasAction('legacy', id)).toBe(true)
    expect(allowsCanvasAction('view', id)).toBe(false)
    expect(allowsCanvasAction('edit', id)).toBe(false)
  }
})
