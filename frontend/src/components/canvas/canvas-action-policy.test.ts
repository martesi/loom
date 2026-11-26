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
import {
  createCanvasSelectionIntentRef,
  useCanvasSelectionAuthority,
} from './canvas-selection-intent'
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
    'connect-derivative',
    'connect-source',
    'reverse-relationship-tool',
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
    const setViewport = mock(async () => true)
    const hook = renderHook(
      ({ path }) => {
        const owner = useCanvasBoardOwner(path)
        const authority = useCanvasSelectionAuthority(path)
        const { selection, setSelection, selectionRef, intentRef } = authority
        const operations = useCanvasAssetOperations({
          owner,
          repoPath: path,
          selection,
          selectionRef,
          selectionIntentRef: intentRef,
          setSelection,
          host: {
            current: {
              getBoundingClientRect: () => ({ width: 800, height: 600 }),
            },
          } as never,
          flow: {
            getNode: () => ({
              position: { x: 200, y: 0 },
              width: 150,
              height: 110,
            }),
            getZoom: () => 1,
            setViewport,
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
          selectionIntentRef: intentRef,
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
      expect(setViewport).not.toHaveBeenCalled()
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
      expect(setViewport).toHaveBeenCalledTimes(1)
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
    expect(setViewport).toHaveBeenCalledTimes(1)
  })
}

it('rechecks the current mode when a previously enabled action reaches the queue', async () => {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  spyOn(owner, 'refresh').mockResolvedValue({
    snapshot: { revision: 'revision', images: [], relationships: [] },
    data: { images: [], relationships: [], groups: [] },
  } as never)
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
    selectionIntentRef: createCanvasSelectionIntentRef('/repo', emptySelection),
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
    const system = useCanvasActionSystem({
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
    return system
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
        unplace: '',
      },
      onAction: result.current.runDockAction,
    })
  )
  const selectionButton = dock.getByTestId(
    'dock-arrange-selection'
  ) as HTMLButtonElement
  expect(selectionButton.disabled).toBe(false)
  await act(async () => {
    await result.current.executeAction(selectionAction)
  })
  expect(arrange).toHaveBeenCalledTimes(1)
  arrange.mockClear()
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

it('cancels a queued selected-subgraph arrangement after selection changes', async () => {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  const arrange = mock(async () => {})
  const { result, rerender } = renderHook(() => {
    const authority = useCanvasSelectionAuthority('/repo')
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [, setRecentActionIds] = useState<string[]>([])
    const [, setPaletteAssets] = useState<PaletteAsset[]>([])
    const [, setPaletteAssetsLoading] = useState(false)
    const [, setPaletteAssetsError] = useState(false)
    const context = {
      owner,
      repoPath: '/repo',
      displayNodes: [{ id: '1' }, { id: '2' }, { id: '3' }],
      selectedCanvasNodeIds: authority.selection.ids.map(String),
      canArrangeSelection: authority.selection.ids.length > 0,
      selectedIds: () => authority.selectionRef.current.ids,
      selectedImageRecords: [],
      relationshipActions: [],
      visible: { current: [] },
      selection: authority.selection,
      selectionIntentRef: authority.intentRef,
      data: { images: [], relationships: [], groups: [] },
      arrange,
      undoActions: { undo: async () => {}, redo: async () => {} },
    } as unknown as CanvasActionsContext
    const system = useCanvasActionSystem({
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
    return { ...system, setSelection: authority.setSelection }
  })
  let release = () => {}
  const blocker = owner.execute(
    () => new Promise<void>((resolve) => (release = resolve))
  )
  await Promise.resolve()
  const action = result.current.actionById.get('auto-arrange-selection')
  if (!action) throw new Error('missing selection arrangement action')
  const queued = result.current.executeAction(action)
  act(() =>
    result.current.setSelection({
      surface: 'canvas',
      ids: [3],
      edges: [],
      group: null,
    })
  )
  rerender()
  await act(async () => {
    release()
    await blocker
    await queued
  })
  expect(arrange).not.toHaveBeenCalled()
  owner.dispose()
})

it('does not apply a queued D action to an image after selection changes', async () => {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  const setConnectionTool = mock()
  const setConnectionAnchorId = mock()
  const props = {
    report: mock(),
    paletteOpen: false,
    setPaletteOpen: mock(),
    setRecentActionIds: mock(),
    trashIds: null,
    purgeIds: null,
    host: { current: null },
    paletteAssetRequest: 0,
    setPaletteAssets: mock(),
    setPaletteAssetsLoading: mock(),
    setPaletteAssetsError: mock(),
  }
  const initialSelection = {
    surface: 'canvas' as const,
    ids: [1],
    edges: [],
    group: null,
  }
  const hook = renderHook(() => {
    const authority = useCanvasSelectionAuthority('/repo', initialSelection)
    const system = useCanvasActionSystem({
      ...props,
      context: {
        owner,
        repoPath: '/repo',
        selection: authority.selection,
        selectionIntentRef: authority.intentRef,
        connectionTool: null,
        setConnectionTool,
        setConnectionAnchorId,
        selectedIds: () => authority.selectionRef.current.ids,
        selectedImageRecords: [],
        relationshipActions: [],
        canNavigateRelationship: false,
        canRemoveRelationship: false,
        data: { images: [], relationships: [] },
        displayNodes: [],
        selectedCanvasNodeIds: authority.selection.ids.map(String),
        visible: { current: [] },
        undoActions: { undo: async () => {}, redo: async () => {} },
        setReveal: mock(),
        report: mock(),
      } as unknown as CanvasActionsContext,
      pendingRecentAction: useRef<string | null>(null),
    })
    return { ...system, setSelection: authority.setSelection }
  })
  let release = () => {}
  const blocker = owner.execute(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await Promise.resolve()
  const action = hook.result.current.actionById.get('connect-derivative')
  if (!action) throw new Error('missing derivative connection action')
  const pending = hook.result.current.executeAction(action)
  act(() => hook.result.current.setSelection({ ...initialSelection, ids: [2] }))
  await act(async () => {
    release()
    await blocker
    await pending
  })
  expect(setConnectionAnchorId).not.toHaveBeenCalled()
  expect(setConnectionTool).not.toHaveBeenCalled()
})

it('denies unknown actions in View and Edit, but preserves legacy behavior', () => {
  for (const id of ['future-mutation', 'toString', '__proto__']) {
    expect(canvasActionCapability(id)).toBeUndefined()
    expect(allowsCanvasAction('legacy', id)).toBe(true)
    expect(allowsCanvasAction('view', id)).toBe(false)
    expect(allowsCanvasAction('edit', id)).toBe(false)
  }
})
