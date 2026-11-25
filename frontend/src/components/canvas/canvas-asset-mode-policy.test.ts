import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { createCanvasBoardOwner } from './canvas-board-owner'
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
  const { result } = renderHook(() => useCanvasAssetOperations(props))
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
  const blocker = owner.execute(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await Promise.resolve()
  const pending = result.current.paste([])
  owner.setMode('view')
  await act(async () => {
    release()
    await blocker
    await pending
  })
  expect(imported).toHaveBeenCalledWith('/repo', [], false, 10, 20)
  expect(setSelection).toHaveBeenCalledWith({
    surface: 'assets',
    ids: [1],
    edges: [],
    group: null,
  })
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
  await result.current.remove(false)
  await result.current.remove(true)
  expect(unlink).not.toHaveBeenCalled()
  expect(setPurgeIds).not.toHaveBeenCalled()
})

it('does not confirm a legacy Canvas purge after entering View', async () => {
  const owner = createCanvasBoardOwner('/repo')
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
