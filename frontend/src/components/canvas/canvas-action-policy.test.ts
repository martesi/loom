import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, render, renderHook } from '@testing-library/react'
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
const { useCanvasActionSystem } = await import('./use-canvas-action-system')
const { CanvasDock } = await import('./canvas-dock')

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

for (const interruption of [
  'repository',
  'mode',
  'selection',
  'selection-aba',
  'unchanged',
  'superseded',
] as const) {
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
        return { actions, operations, owner, selection, setSelection }
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
    if (interruption === 'superseded') {
      const oldFrame = frame
      act(() =>
        hook.result.current.actions.choosePaletteAsset({
          id: 2,
          fileName: '2.png',
          filePath: '/a/2.png',
          tags: [],
        })
      )
      act(() => oldFrame(0))
      expect(getImage).not.toHaveBeenCalled()
      act(() => frame(0))
      expect(getImage).toHaveBeenCalledWith('/a', 2)
      await act(async () => {
        resolveImage({ id: 2, placed: true, canvasX: 200, canvasY: 0 } as never)
        await Promise.resolve()
      })
      expect(hook.result.current.selection.ids).toEqual([2])
      return
    }
    if (interruption === 'mode') hook.result.current.owner.setMode('view')
    if (interruption === 'selection' || interruption === 'selection-aba') {
      const focus = document.createElement('button')
      document.body.append(focus)
      focus.focus()
      act(() =>
        hook.result.current.setSelection({
          surface: 'canvas',
          ids: [2],
          edges: [],
          group: null,
        })
      )
      if (interruption === 'selection-aba')
        act(() => hook.result.current.setSelection(emptySelection))
      act(() => frame(0))
      expect(getImage).not.toHaveBeenCalled()
      expect(setCenter).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(focus)
      focus.remove()
      expect(hook.result.current.selection.ids).toEqual(
        interruption === 'selection' ? [2] : []
      )
      return
    }
    if (interruption === 'unchanged') {
      act(() =>
        hook.result.current.setSelection({
          ...emptySelection,
          ids: [],
          edges: [],
        })
      )
      hook.rerender({ path: '/a' })
      act(() => frame(0))
      expect(getImage).toHaveBeenCalledTimes(1)
      expect(getImage).toHaveBeenCalledWith('/a', 1)
      await act(async () => {
        resolveImage({ id: 1, placed: true, canvasX: 200, canvasY: 0 } as never)
        await Promise.resolve()
      })
      expect(hook.result.current.selection.ids).toEqual([1])
      expect(setCenter).toHaveBeenCalledTimes(1)
      return
    }
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

it('does not run a delayed palette camera command after a newer camera intent', () => {
  let frame: FrameRequestCallback = () => {}
  spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback
    return 1
  })
  let revision = 0
  const cameraIntent = { reserve: () => ++revision, version: () => revision }
  const fitAll = mock(async () => {})
  const go = mock(async () => {})
  const owner = createCanvasBoardOwner('/repo')
  const context = {
    owner,
    repoPath: '/repo',
    cameraIntent,
    fitAll,
    go,
    displayNodes: [{ id: '1' }],
    selectedCanvasNodeIds: [],
    selectedIds: () => [],
    selectedImageRecords: [],
    relationshipActions: [],
    visible: { current: [] },
    selection: emptySelection,
    data: { images: [], relationships: [], groups: [] },
    undoActions: { undo: async () => {}, redo: async () => {} },
  } as unknown as CanvasActionsContext
  const { result } = renderHook(() =>
    useCanvasActionSystem({
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
  )
  const fit = result.current.actionById.get('fit-all')
  if (!fit) throw new Error('missing Fit action')
  act(() => result.current.runPaletteAction(fit))
  cameraIntent.reserve()
  act(() => frame(0))
  expect(fitAll).not.toHaveBeenCalled()
  act(() =>
    result.current.choosePaletteAsset({
      id: 1,
      fileName: 'a',
      filePath: '/a',
      tags: [],
    })
  )
  cameraIntent.reserve()
  act(() => frame(0))
  expect(go).not.toHaveBeenCalled()
})

it('rechecks the current mode when a previously enabled action reaches the queue', async () => {
  const owner = createCanvasBoardOwner('/repo')
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
  expect(selectionAction.enabled).toBe(true)
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
      },
      onAction: result.current.runDockAction,
    })
  )
  const selectionButton = dock.getByTestId(
    'dock-arrange-selection'
  ) as HTMLButtonElement
  expect(selectionButton.disabled).toBe(false)
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
