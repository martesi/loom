import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  type ClipboardMedia,
  ImageService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { canvasEffects } from './canvas-operation-effects'
import { refreshBoard, reserveCanvasRead } from './canvas-operation-test-utils'
import { useCanvasAssetOperations } from './use-canvas-asset-operations'

afterEach(() => {
  cleanup()
  mock.restore()
})

it('navigates to live projected nodes and reveals hidden View assets', async () => {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('view')
  spyOn(ImageService, 'GetImage').mockImplementation(
    async (_path, id) =>
      ({
        id,
        placed: false,
        canvasX: 9000,
        canvasY: 9000,
        filePath: `/repo/${id}.png`,
      }) as never
  )
  const nodes = new Map([
    ['1', { id: '1', position: { x: 120, y: 240 }, width: 200, height: 100 }],
  ])
  const setCenter = mock(async () => true)
  const setSelection = mock()
  const selectAssets = mock()
  const setReveal = mock()
  const props = {
    owner,
    repoPath: '/repo',
    flow: {
      getNode: (id: string) => nodes.get(id),
      getZoom: () => 2,
      setCenter,
    },
    setSelection,
    selectAssets,
    setReveal,
    setExpanded: mock(),
    openAssets: mock(),
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result, rerender } = renderHook(() => useCanvasAssetOperations(props))
  await act(async () => result.current.go(1))
  expect(setCenter).toHaveBeenCalledWith(220, 290, { zoom: 2 })
  expect(setSelection).toHaveBeenCalledWith({
    surface: 'canvas',
    ids: [1],
    edges: [],
    group: null,
  })
  await act(async () => result.current.go(2))
  expect(selectAssets).toHaveBeenCalledWith([2])
  expect(setReveal).toHaveBeenCalledWith({ id: 2, folder: null })
  owner.setMode('edit')
  rerender()
  nodes.set('2', {
    id: '2',
    position: { x: 500, y: 600 },
    width: 300,
    height: 120,
  })
  await act(async () => result.current.go(2))
  expect(setCenter).toHaveBeenLastCalledWith(650, 660, { zoom: 2 })
})

it('rechecks mode after a delayed paste and imports without Canvas geometry in View', async () => {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  const imported = spyOn(ImageService, 'ImportMedia').mockResolvedValue([
    1,
  ] as never)
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [],
    relationships: [],
  } as never)
  await refreshBoard(owner)
  const setSelection = mock()
  const props = {
    owner,
    repoPath: '/repo',
    selection: { surface: 'canvas', ids: [], edges: [], group: null },
    center: () => ({ x: 10, y: 20 }),
    reload: async () => {},
    setSelection,
    setReveal: mock(),
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result } = renderHook(() => useCanvasAssetOperations(props))
  let release = () => {}
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const blocker = reserveCanvasRead(owner, async () => {
    signalStarted()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await started
  const pending = result.current.paste([
    { name: 'media.png', data: 'aGVsbG8=' },
  ])
  owner.setMode('view')
  await act(async () => {
    release()
    await blocker
    await pending
  })
  expect(imported).toHaveBeenCalledWith(
    '/repo',
    [{ name: 'media.png', data: 'aGVsbG8=' }],
    false,
    10,
    20
  )
  expect(setSelection).toHaveBeenCalledWith({
    surface: 'assets',
    ids: [1],
    edges: [],
    group: null,
  })
})

it('validates invalid clipboard text before a conflicting queued write', async () => {
  const owner = createCanvasBoardOwner('/repo-invalid-paste')
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [],
    relationships: [],
  } as never)
  const importMedia = spyOn(ImageService, 'ImportMedia').mockResolvedValue(
    [] as never
  )
  await refreshBoard(owner)
  let releaseWrite = () => {}
  let signalWriteStarted = () => {}
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve
  })
  const writeResponse = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  const archive = spyOn(ImageService, 'SetArchived').mockImplementation(() => {
    signalWriteStarted()
    return writeResponse as never
  })
  const props = {
    owner,
    repoPath: '/repo-invalid-paste',
    selection: { surface: 'assets', ids: [], edges: [], group: null },
    center: () => ({ x: 10, y: 20 }),
    setSelection: mock(),
    setReveal: mock(),
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result } = renderHook(() => useCanvasAssetOperations(props))
  const blocker = owner.submit(
    {
      kind: 'mutation',
      capability: 'metadata',
      board: owner.getSnapshot(),
    },
    (operation) =>
      canvasEffects.setArchived(operation, '/repo-invalid-paste', 1, true)
  )
  await writeStarted
  await expect(
    result.current.paste(() =>
      Promise.reject(new Error('Clipboard contains no media files'))
    )
  ).rejects.toThrow('Clipboard contains no media files')
  expect(importMedia).not.toHaveBeenCalled()
  expect(archive).toHaveBeenCalledTimes(1)

  releaseWrite()
  expect((await blocker).status).toBe('success')
  owner.dispose()
})

it('rejects valid prepared media against a snapshot replaced during preparation', async () => {
  const owner = createCanvasBoardOwner('/repo-stale-paste')
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [],
    relationships: [],
  } as never)
  const importMedia = spyOn(ImageService, 'ImportMedia').mockResolvedValue(
    [] as never
  )
  await refreshBoard(owner)
  let releaseWrite = () => {}
  let signalWriteStarted = () => {}
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve
  })
  const writeResponse = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  spyOn(ImageService, 'SetArchived').mockImplementation(() => {
    signalWriteStarted()
    return writeResponse as never
  })
  const props = {
    owner,
    repoPath: '/repo-stale-paste',
    selection: { surface: 'assets', ids: [], edges: [], group: null },
    center: () => ({ x: 10, y: 20 }),
    setSelection: mock(),
    setReveal: mock(),
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result } = renderHook(() => useCanvasAssetOperations(props))
  const previous = owner.getSnapshot()
  const priorWrite = owner.submit(
    {
      kind: 'mutation',
      capability: 'metadata',
      board: previous,
    },
    (operation) =>
      canvasEffects.setArchived(operation, '/repo-stale-paste', 1, true)
  )
  await writeStarted
  let resolveMedia!: (media: ClipboardMedia[]) => void
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const prepared = new Promise<ClipboardMedia[]>((resolve) => {
    resolveMedia = resolve
  })
  const paste = result.current.paste(() => {
    signalStarted()
    return prepared
  })
  await started
  releaseWrite()
  expect((await priorWrite).status).toBe('success')
  expect(owner.getSnapshot()).not.toBe(previous)

  resolveMedia([{ name: 'valid.png', data: 'aGVsbG8=' }])
  await expect(paste).rejects.toThrow('Canvas changed')
  expect(importMedia).not.toHaveBeenCalled()
  owner.dispose()
})

it('does not import prepared media after selection intent changes and returns to its prior value', async () => {
  const owner = createCanvasBoardOwner('/repo-selection-prep')
  const importMedia = spyOn(ImageService, 'ImportMedia').mockResolvedValue([
    7,
  ] as never)
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
  await refreshBoard(owner)
  const original: Selection = {
    surface: 'assets',
    ids: [1],
    edges: [],
    group: null,
  }
  let currentProps = {
    owner,
    repoPath: '/repo-selection-prep',
    selection: original,
    center: () => ({ x: 10, y: 20 }),
    setSelection: mock(),
    setReveal: mock(),
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result, rerender } = renderHook(() =>
    useCanvasAssetOperations(currentProps)
  )
  let resolveMedia!: (media: ClipboardMedia[]) => void
  const prepared = new Promise<ClipboardMedia[]>((resolve) => {
    resolveMedia = resolve
  })
  const paste = result.current.paste(() => prepared)
  currentProps = {
    ...currentProps,
    selection: { ...original, ids: [2] },
  }
  rerender()
  currentProps = { ...currentProps, selection: original }
  rerender()
  resolveMedia([{ name: 'fresh.png', data: 'aGVsbG8=' }])
  await expect(paste).resolves.toBeUndefined()
  expect(importMedia).not.toHaveBeenCalled()
  owner.dispose()
})

it('does not queue file import after selection changes during preparation', async () => {
  const owner = createCanvasBoardOwner('/repo-file-selection')
  const importMedia = spyOn(ImageService, 'ImportMedia').mockResolvedValue([
    8,
  ] as never)
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
  await refreshBoard(owner)
  let currentProps = {
    owner,
    repoPath: '/repo-file-selection',
    selection: {
      surface: 'assets' as const,
      ids: [1],
      edges: [],
      group: null,
    },
    center: () => ({ x: 0, y: 0 }),
    setSelection: mock(),
    setReveal: mock(),
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result, rerender } = renderHook(() =>
    useCanvasAssetOperations(currentProps)
  )
  let resolveMedia!: (media: ClipboardMedia[]) => void
  const prepared = new Promise<ClipboardMedia[]>((resolve) => {
    resolveMedia = resolve
  })
  const pending = result.current.importMedia(() => prepared)
  currentProps = {
    ...currentProps,
    selection: { ...currentProps.selection, ids: [2] },
  }
  rerender()
  resolveMedia([{ name: 'dropped.png', data: 'aGVsbG8=' }])
  await pending
  expect(importMedia).not.toHaveBeenCalled()
  owner.dispose()
})

it('keeps dispatched import authoritative but does not replace newer selection', async () => {
  const owner = createCanvasBoardOwner('/repo-selection-response')
  const imported: number[] = []
  let signalImportStarted!: () => void
  const importStarted = new Promise<void>((resolve) => {
    signalImportStarted = resolve
  })
  let resolveImport!: (ids: number[]) => void
  spyOn(ImageService, 'ImportMedia').mockImplementation(() => {
    signalImportStarted()
    return new Promise<number[]>((resolve) => {
      resolveImport = (ids) => {
        imported.push(...ids)
        resolve(ids)
      }
    }) as never
  })
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
  await refreshBoard(owner)
  const setSelection = mock()
  const setReveal = mock()
  const initial: Selection = {
    surface: 'assets',
    ids: [1],
    edges: [],
    group: null,
  }
  let currentProps = {
    owner,
    repoPath: '/repo-selection-response',
    selection: initial,
    center: () => ({ x: 10, y: 20 }),
    setSelection,
    setReveal,
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result, rerender } = renderHook(() =>
    useCanvasAssetOperations(currentProps)
  )
  const paste = result.current.paste([
    { name: 'persisted.png', data: 'aGVsbG8=' },
  ])
  await importStarted
  currentProps = {
    ...currentProps,
    selection: { ...initial, ids: [2] },
  }
  rerender()
  resolveImport([9])
  await paste
  expect(imported).toEqual([9])
  expect(setSelection).not.toHaveBeenCalled()
  expect(setReveal).not.toHaveBeenCalled()
  owner.dispose()
})

it('consumes prepared media without importing after a repository owner switch', async () => {
  const owner = createCanvasBoardOwner('/repo-disposed-paste')
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
  const importMedia = spyOn(ImageService, 'ImportMedia').mockResolvedValue(
    [] as never
  )
  await refreshBoard(owner)
  const props = {
    owner,
    repoPath: '/repo-disposed-paste',
    selection: { surface: 'assets', ids: [], edges: [], group: null },
    center: () => ({ x: 10, y: 20 }),
    setSelection: mock(),
    setReveal: mock(),
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result } = renderHook(() => useCanvasAssetOperations(props))
  let resolveMedia!: (media: ClipboardMedia[]) => void
  let signalStarted = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const prepared = new Promise<ClipboardMedia[]>((resolve) => {
    resolveMedia = resolve
  })
  const paste = result.current.paste(() => {
    signalStarted()
    return prepared
  })
  await started
  const replacementOwner = createCanvasBoardOwner('/repo-replacement')
  expect((await replacementOwner.activate()).status).toBe('success')
  owner.dispose()
  resolveMedia([{ name: 'valid.png', data: 'aGVsbG8=' }])
  await expect(paste).resolves.toBeUndefined()
  expect(importMedia).not.toHaveBeenCalled()
  await expect(
    result.current.paste(() =>
      Promise.reject(new Error('Clipboard read was cancelled'))
    )
  ).resolves.toBeUndefined()
  replacementOwner.dispose()
})

it('does not unlink or open purge from a Canvas selection in View', async () => {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('view')
  const unlink = spyOn(ImageService, 'UnlinkSources').mockResolvedValue(
    undefined as never
  )
  const setPurgeIds = mock()
  const selection: Selection = {
    surface: 'canvas',
    ids: [1],
    edges: [2],
    group: null,
  }
  const props = {
    owner,
    repoPath: '/repo',
    selection,
    selectedIds: () => [1],
    setPurgeIds,
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result } = renderHook(() => useCanvasAssetOperations(props))
  if (result.error) throw result.error
  await result.current.remove(false)
  await result.current.remove(true)
  expect(unlink).not.toHaveBeenCalled()
  expect(setPurgeIds).not.toHaveBeenCalled()
})

it('does not confirm a legacy Canvas purge after entering View', async () => {
  const owner = createCanvasBoardOwner('/repo')
  spyOn(ImageService, 'LoadCanvas').mockResolvedValue({
    images: [{ id: 1 }],
    relationships: [],
    groups: [],
  } as never)
  spyOn(ImageService, 'GetLayoutSnapshot').mockResolvedValue({
    revision: '1',
    images: [
      {
        id: 1,
        width: 640,
        height: 480,
        geometry: { imageId: 1, x: 0, y: 0, w: 150, h: 110 },
      },
    ],
    relationships: [],
  } as never)
  await refreshBoard(owner)
  const purge = spyOn(ImageService, 'PurgeImages').mockResolvedValue(
    undefined as never
  )
  const props = {
    owner,
    repoPath: '/repo',
    selection: { surface: 'canvas', ids: [1], edges: [], group: null },
    selectedIds: () => [1],
    setPurgeIds: mock(),
    purgeIds: null as number[] | null,
    lifecyclePendingRef: { current: false },
  } as unknown as Parameters<typeof useCanvasAssetOperations>[0]
  const { result, rerender } = renderHook(() => useCanvasAssetOperations(props))
  await result.current.remove(true)
  props.purgeIds = [1]
  owner.setMode('view')
  rerender()
  await result.current.confirmPurge()
  expect(purge).not.toHaveBeenCalled()
})
