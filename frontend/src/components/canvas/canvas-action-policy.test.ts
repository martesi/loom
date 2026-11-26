import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from '@testing-library/react'
import { createElement, useRef, useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import {
  createCanvasBoardOwner,
  useCanvasBoardOwner,
} from './canvas-board-owner'
import {
  allowsCanvasAction,
  type CanvasCapability,
  canvasActionCapability,
} from './canvas-mode-policy'
import {
  mockCanvasObservationFromLegacyRPCs,
  refreshBoard,
  reserveCanvasRead,
} from './canvas-operation-test-utils.test'
import type { PaletteAsset } from './command-palette'
import { useCanvasAssetOperations } from './use-canvas-asset-operations'

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

beforeEach(() => {
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [],
    relationships: [],
  } as never)
  mockCanvasObservationFromLegacyRPCs()
})

const { useCanvasActionSystem } = await import('./use-canvas-action-system')
const { CanvasDock } = await import('./canvas-dock')

async function activateOwner(owner: ReturnType<typeof createCanvasBoardOwner>) {
  await refreshBoard(owner)
}

function blockQueue(owner: ReturnType<typeof createCanvasBoardOwner>) {
  let release = () => {}
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const blocked = reserveCanvasRead(owner, async () => {
    signalStarted()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  return { blocked, started, release: () => release() }
}

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

afterEach(() => {
  cleanup()
  mock.restore()
})

it('starts paste-media synchronously from the palette event', async () => {
  const owner = createCanvasBoardOwner('/palette-sync-paste')
  await activateOwner(owner)
  const paste = mock(async () => {})
  const context = {
    owner,
    repoPath: '/palette-sync-paste',
    selection: emptySelection,
    displayNodes: [],
    selectedCanvasNodeIds: [],
    canFitSelection: false,
    canArrangeSelection: false,
    fitAll: mock(async () => {}),
    fitSelection: mock(async () => {}),
    resetZoom: mock(async () => {}),
    zoomBy: mock(async () => {}),
    arrange: mock(async () => {}),
    alignHorizontal: mock(async () => {}),
    alignVertical: mock(async () => {}),
    selectedIds: () => [],
    selectedImageRecords: [],
    relationshipActions: [],
    visible: { current: [] },
    data: { images: [], relationships: [], groups: [] },
    paste,
    undoActions: { undo: async () => {}, redo: async () => {} },
  } as unknown as CanvasActionsContext
  const { result } = renderHook(() =>
    useCanvasActionSystem({
      context,
      report: mock(),
      paletteOpen: true,
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
  let frameScheduled = false
  spyOn(globalThis, 'requestAnimationFrame').mockImplementation((_callback) => {
    frameScheduled = true
    return 1
  })
  const pasteAction = result.current.actionById.get('paste-media')
  if (!pasteAction) throw new Error('paste-media action was not registered')
  act(() => result.current.runPaletteAction(pasteAction))
  expect(paste).toHaveBeenCalledTimes(1)
  expect(frameScheduled).toBe(false)
  owner.dispose()
})

for (const interruption of ['repository', 'mode'] as const) {
  it(`discards a scheduled palette choice after a ${interruption} change`, async () => {
    let frame: FrameRequestCallback = () => {}
    spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (callback) => {
        frame = callback
        return 1
      }
    )
    let resolveImage: (value: never) => void = () => {}
    const getImage = spyOn(ImageService, 'GetImage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve
        })
    )
    const setCenter = mock(async () => true)
    const hook = renderHook(
      ({ path }) => {
        const owner = useCanvasBoardOwner(path)
        const [selection, setSelection] = useState(emptySelection)
        const operations = useCanvasAssetOperations({
          owner,
          repoPath: path,
          selection,
          setSelection,
          flow: {
            getNode: () => ({
              position: { x: 200, y: 0 },
              width: 150,
              height: 110,
            }),
            getZoom: () => 1,
            setCenter,
          },
          setExpanded: mock(),
          openAssets: mock(),
          selectAssets: mock(),
          setReveal: mock(),
        } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
        const context = {
          owner,
          repoPath: path,
          go: operations.go,
          beginSelectionIntent: operations.beginSelectionIntent,
          selection,
          displayNodes: [],
          selectedCanvasNodeIds: [],
          selectedIds: () => [],
          selectedImageRecords: [],
          relationshipActions: [],
          visible: { current: [] },
          data: { images: [], relationships: [], groups: [] },
          undoActions: { undo: async () => {}, redo: async () => {} },
        } as unknown as CanvasActionsContext
        const actions = useCanvasActionSystem({
          context,
          report: mock(),
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
        return { actions, operations, owner, selection }
      },
      { initialProps: { path: '/a' } }
    )
    act(() =>
      hook.result.current.actions.choosePaletteAsset({
        id: 1,
        fileName: '1.png',
        filePath: '/a/1.png',
        tags: [],
      })
    )
    if (interruption === 'mode')
      hook.result.current.owner.beginModeTransition('view')
    hook.rerender({ path: interruption === 'repository' ? '/b' : '/a' })
    const currentRequest = hook.result.current.operations.go(2)
    act(() => frame(0))
    expect(getImage).toHaveBeenCalledTimes(1)
    expect(getImage).toHaveBeenCalledWith(
      interruption === 'repository' ? '/b' : '/a',
      2
    )
    await act(async () => {
      resolveImage({ id: 2, placed: true, canvasX: 200, canvasY: 0 } as never)
      await currentRequest
    })
    expect(hook.result.current.selection.ids).toEqual([2])
    expect(setCenter).toHaveBeenCalledWith(275, 55, { zoom: 1 })
  })
}

it('rechecks the current mode when a previously enabled action reaches the queue', async () => {
  const owner = createCanvasBoardOwner('/repo')
  await activateOwner(owner)
  owner.setMode('edit')
  const arrange = mock(async () => {})
  const context = {
    owner,
    repoPath: '/repo',
    displayNodes: [{ id: '1' }, { id: '2' }, { id: '3' }],
    selectedCanvasNodeIds: ['1', '2'],
    canArrangeSelection: true,
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
  const selectionAction = result.current.actionById.get(
    'auto-arrange-selection'
  )
  if (!selectionAction) throw new Error('missing selection action')
  expect(selectionAction.enabled).toBe(false)
  const dock = render(
    createElement(CanvasDock, {
      mode: 'multiple',
      selectionCount: 2,
      canFitAll: true,
      canFitSelection: true,
      canAutoArrange: true,
      canArrangeSelection: selectionAction.enabled,
      shortcuts: {
        fitAll: '',
        fitSelection: '',
        resetZoom: '',
        autoArrange: '',
        inspect: '',
        unplace: '',
      },
      onAction: result.current.runDockAction,
    })
  )
  const selectionButton = dock.getByTestId(
    'dock-arrange-selection'
  ) as HTMLButtonElement
  expect(selectionButton.disabled).toBe(true)
  await act(async () => {
    fireEvent.click(selectionButton)
    await result.current.executeAction(selectionAction)
    result.current.runDockAction('auto-arrange-selection')
  })
  expect(arrange).not.toHaveBeenCalled()
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
        !(mode === 'edit' && id === 'auto-arrange-selection') &&
          (mode !== 'view' ||
            (capability !== 'geometry' && capability !== 'relationship'))
      )
  }
  if (!action) throw new Error('missing arrange action')
  expect(action.enabled).toBe(true)
  const blocker = blockQueue(owner)
  await blocker.started
  owner.beginModeTransition('view')
  const view = owner.submit(
    { kind: 'mode', target: 'view' },
    async (operation) => operation.setMode('view')
  )
  const queued = result.current.executeAction(action)
  await act(async () => {
    blocker.release()
    expect((await blocker.blocked).status).toBe('success')
    expect((await view).status).toBe('success')
    await queued
  })
  expect(arrange).not.toHaveBeenCalled()
  expect(
    (
      await owner.submit({ kind: 'mode', target: 'edit' }, async (operation) =>
        operation.setMode('edit')
      )
    ).status
  ).toBe('success')
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

for (const change of [
  'pending transition',
  'mode ABA',
  'owner lifetime',
] as const) {
  it(`rejects queued geometry after ${change} and keeps the queue live`, async () => {
    const owner = createCanvasBoardOwner('/repo')
    await activateOwner(owner)
    owner.setMode('edit')
    const arrange = mock(async () => {})
    const report = mock()
    const context = {
      owner,
      repoPath: '/repo',
      displayNodes: [{ id: '1' }],
      selectedCanvasNodeIds: [],
      selectedIds: () => [],
      selectedImageRecords: [],
      relationshipActions: [],
      visible: { current: [] },
      selection: emptySelection,
      data: { images: [], relationships: [], groups: [] },
      arrange,
      undoActions: { undo: async () => {}, redo: async () => {} },
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
    const blocker = blockQueue(owner)
    await blocker.started
    const action = result.current.actionById.get('auto-arrange-active')
    if (!action) throw new Error('missing action')
    let queued: Promise<void>
    const transitions: Promise<unknown>[] = []
    if (change === 'pending transition') {
      queued = result.current.executeAction(action)
      owner.beginModeTransition('view')
      transitions.push(
        owner.submit({ kind: 'mode', target: 'view' }, async (operation) =>
          operation.setMode('view')
        )
      )
    } else if (change === 'mode ABA') {
      owner.beginModeTransition('view')
      transitions.push(
        owner.submit({ kind: 'mode', target: 'view' }, async (operation) =>
          operation.setMode('view')
        )
      )
      queued = result.current.executeAction(action)
      owner.beginModeTransition('edit')
      transitions.push(
        owner.submit({ kind: 'mode', target: 'edit' }, async (operation) =>
          operation.setMode('edit')
        )
      )
    } else {
      queued = result.current.executeAction(action)
      owner.dispose()
      transitions.push(owner.activate())
    }
    await act(async () => {
      blocker.release()
      expect((await blocker.blocked).status).toBe(
        change === 'owner lifetime' ? 'cancelled' : 'success'
      )
      await Promise.all([queued, ...transitions])
    })
    expect(arrange).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    if (change !== 'owner lifetime')
      await owner.submit({ kind: 'mode', target: 'edit' }, async (operation) =>
        operation.setMode('edit')
      )
    await act(async () => result.current.executeAction(action))
    expect(arrange).toHaveBeenCalledTimes(1)
    owner.dispose()
  })
}

it('rejects a palette geometry intent when mode changes before its frame', async () => {
  let frame: FrameRequestCallback = () => {}
  spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback
    return 1
  })
  const owner = createCanvasBoardOwner('/repo')
  await activateOwner(owner)
  owner.setMode('edit')
  const arrange = mock(async () => {})
  const report = mock()
  const context = {
    owner,
    repoPath: '/repo',
    displayNodes: [{ id: '1' }],
    selectedCanvasNodeIds: [],
    selectedIds: () => [],
    selectedImageRecords: [],
    relationshipActions: [],
    visible: { current: [] },
    selection: emptySelection,
    data: { images: [], relationships: [], groups: [] },
    arrange,
    undoActions: { undo: async () => {}, redo: async () => {} },
  } as unknown as CanvasActionsContext
  const { result } = renderHook(() =>
    useCanvasActionSystem({
      context,
      report,
      paletteOpen: true,
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
  const action = result.current.actionById.get('auto-arrange-active')
  if (!action) throw new Error('missing action')
  act(() => result.current.runPaletteAction(action))
  owner.beginModeTransition()
  act(() => frame(0))
  expect(arrange).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
  owner.dispose()
})
