import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import {
  createCanvasBoardOwner,
  useCanvasBoardOwner,
} from './canvas-board-owner'
import { useCanvasAssetOperations } from './use-canvas-asset-operations'

afterEach(() => {
  cleanup()
  mock.restore()
})

it('allows a retained direct navigation after an unrelated selection render', async () => {
  spyOn(ImageService, 'GetImage').mockResolvedValue({
    id: 1,
    placed: true,
    canvasX: 100,
    canvasY: 0,
  } as never)
  const setCenter = mock(async () => true)
  const hook = renderHook(() => {
    const owner = useCanvasBoardOwner('/repo')
    const [selection, setSelection] = useState(emptySelection)
    const operations = useCanvasAssetOperations({
      owner,
      repoPath: '/repo',
      selection,
      setSelection,
      flow: { getNode: () => undefined, getZoom: () => 1, setCenter },
      setExpanded: mock(),
      openAssets: mock(),
      selectAssets: mock(),
      setReveal: mock(),
    } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
    return { operations, selection, setSelection }
  })
  const retainedGo = hook.result.current.operations.go
  act(() =>
    hook.result.current.setSelection({
      surface: 'canvas',
      ids: [2],
      edges: [],
      group: null,
    })
  )
  await act(async () => retainedGo(1))
  expect(hook.result.current.selection.ids).toEqual([1])
  expect(setCenter).toHaveBeenCalledTimes(1)
})

it('does not let an older navigation replace a newer selection or viewport', async () => {
  const pending = new Map<number, (value: never) => void>()
  spyOn(ImageService, 'GetImage').mockImplementation(
    (_path, id) => new Promise((resolve) => pending.set(id, resolve))
  )
  const setCenter = mock(async () => true)
  const { result } = renderHook(() => {
    const owner = useCanvasBoardOwner('/repo')
    const [selection, setSelection] = useState(emptySelection)
    const operations = useCanvasAssetOperations({
      owner,
      repoPath: '/repo',
      selection,
      setSelection,
      flow: { getNode: () => undefined, getZoom: () => 1, setCenter },
      setExpanded: mock(),
      openAssets: mock(),
      selectAssets: mock(),
      setReveal: mock(),
    } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
    return { operations, selection }
  })
  let alpha: Promise<void>
  let beta: Promise<void>
  act(() => {
    alpha = result.current.operations.go(1)
    beta = result.current.operations.go(2)
  })
  await act(async () => {
    pending.get(2)?.({ id: 2, placed: true, canvasX: 200, canvasY: 0 } as never)
    await beta
  })
  await act(async () => {
    pending.get(1)?.({ id: 1, placed: true, canvasX: 100, canvasY: 0 } as never)
    await alpha
  })
  expect(result.current.selection.ids).toEqual([2])
  expect(setCenter).toHaveBeenCalledTimes(1)
  expect(setCenter).toHaveBeenCalledWith(275, 55, { zoom: 1 })
})

it('ignores a retained repository callback without interrupting current navigation', async () => {
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
        flow: { getNode: () => undefined, getZoom: () => 1, setCenter },
        setExpanded: mock(),
        openAssets: mock(),
        selectAssets: mock(),
        setReveal: mock(),
      } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
      return { operations, selection }
    },
    { initialProps: { path: '/a' } }
  )
  const retainedGo = hook.result.current.operations.go
  hook.rerender({ path: '/b' })
  const currentRequest = hook.result.current.operations.go(2)
  // The palette schedules its captured callback for a later animation frame.
  const staleRequest = retainedGo(1)
  expect(getImage).toHaveBeenCalledTimes(1)
  expect(getImage).toHaveBeenCalledWith('/b', 2)
  await staleRequest
  await act(async () => {
    resolveImage({ id: 2, placed: true, canvasX: 200, canvasY: 0 } as never)
    await currentRequest
  })
  expect(hook.result.current.selection.ids).toEqual([2])
  expect(setCenter).toHaveBeenCalledWith(275, 55, { zoom: 1 })
})

for (const strict of [false, true]) {
  for (const backToLegacy of [false, true]) {
    it(`ignores an old mode callback after ${backToLegacy ? 'an ABA transition' : 'entering View'} (StrictMode: ${strict})`, async () => {
      let resolveImage: (value: never) => void = () => {}
      const getImage = spyOn(ImageService, 'GetImage').mockImplementation(
        (_path, id) =>
          id === 2
            ? new Promise((resolve) => {
                resolveImage = resolve
              })
            : Promise.resolve({ id: 1, placed: true, canvasX: 100 } as never)
      )
      const setCenter = mock(async () => true)
      const hook = renderHook(
        () => {
          const owner = useCanvasBoardOwner('/repo')
          const [selection, setSelection] = useState(emptySelection)
          const operations = useCanvasAssetOperations({
            owner,
            repoPath: '/repo',
            selection,
            setSelection,
            flow: {
              getNode: () => ({
                position: { x: 200, y: 20 },
                width: 100,
                height: 80,
              }),
              getZoom: () => 1,
              setCenter,
            },
            setExpanded: mock(),
            openAssets: mock(),
            selectAssets: mock(),
            setReveal: mock(),
          } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
          return { owner, operations, selection }
        },
        { reactStrictMode: strict }
      )
      const retainedGo = hook.result.current.operations.go
      hook.result.current.owner.setMode('view')
      if (backToLegacy) hook.result.current.owner.setMode('legacy')
      hook.rerender()
      const currentRequest = hook.result.current.operations.go(2)
      await act(async () => retainedGo(1))
      expect(getImage).toHaveBeenCalledTimes(1)
      expect(getImage).toHaveBeenCalledWith('/repo', 2)
      await act(async () => {
        resolveImage({ id: 2, placed: true, canvasX: 200, canvasY: 0 } as never)
        await currentRequest
      })
      expect(hook.result.current.selection.ids).toEqual([2])
      expect(setCenter).toHaveBeenCalledTimes(1)
      expect(setCenter).toHaveBeenCalledWith(
        backToLegacy ? 275 : 250,
        backToLegacy ? 55 : 60,
        { zoom: 1 }
      )
    })
  }
}

it('does not start navigation from a retained callback after unmount', async () => {
  const getImage = spyOn(ImageService, 'GetImage').mockResolvedValue(
    null as never
  )
  const hook = renderHook(() => {
    const owner = useCanvasBoardOwner('/repo')
    return useCanvasAssetOperations({
      owner,
      repoPath: '/repo',
      selection: emptySelection,
    } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
  })
  const retainedGo = hook.result.current.go
  hook.unmount()
  await retainedGo(1)
  expect(getImage).not.toHaveBeenCalled()
})

it('rejects a replaced or inactive owner even when the repository path is unchanged', async () => {
  let resolveImage: (value: never) => void = () => {}
  const getImage = spyOn(ImageService, 'GetImage').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveImage = resolve
      })
  )
  const first = createCanvasBoardOwner('/repo')
  const second = createCanvasBoardOwner('/repo')
  const setCenter = mock(async () => true)
  const hook = renderHook(
    ({ owner }) => {
      const [selection, setSelection] = useState(emptySelection)
      const operations = useCanvasAssetOperations({
        owner,
        repoPath: '/repo',
        selection,
        setSelection,
        flow: { getNode: () => undefined, getZoom: () => 1, setCenter },
        setExpanded: mock(),
        openAssets: mock(),
        selectAssets: mock(),
        setReveal: mock(),
      } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
      return { operations, selection }
    },
    { initialProps: { owner: first } }
  )
  const retainedGo = hook.result.current.operations.go
  hook.rerender({ owner: second })
  const currentRequest = hook.result.current.operations.go(2)
  await retainedGo(1)
  expect(getImage).toHaveBeenCalledTimes(1)
  await act(async () => {
    resolveImage({ id: 2, placed: true, canvasX: 200, canvasY: 0 } as never)
    await currentRequest
  })
  expect(hook.result.current.selection.ids).toEqual([2])
  expect(setCenter).toHaveBeenCalledWith(275, 55, { zoom: 1 })
  second.dispose()
  await hook.result.current.operations.go(3)
  expect(getImage).toHaveBeenCalledTimes(1)
})

for (const target of ['canvas', 'assets'] as const) {
  it(`stops ${target} navigation when a side effect changes the mode`, async () => {
    spyOn(ImageService, 'GetImage').mockResolvedValue({
      id: 1,
      placed: target === 'canvas',
      canvasX: 10,
      canvasY: 20,
      filePath: '/repo/1.png',
    } as never)
    const setCenter = mock(async () => true)
    const selectAssets = mock()
    const setReveal = mock()
    const hook = renderHook(() => {
      const owner = useCanvasBoardOwner('/repo')
      const [selection, setSelection] = useState(emptySelection)
      const changeMode = () => owner.setMode('view')
      const operations = useCanvasAssetOperations({
        owner,
        repoPath: '/repo',
        selection,
        setSelection,
        flow: { getNode: () => undefined, getZoom: () => 1, setCenter },
        setExpanded: changeMode,
        openAssets: changeMode,
        selectAssets,
        setReveal,
      } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
      return { operations, selection }
    })
    await act(async () => hook.result.current.operations.go(1))
    expect(hook.result.current.selection.ids).toEqual([])
    expect(setCenter).not.toHaveBeenCalled()
    expect(selectAssets).not.toHaveBeenCalled()
    expect(setReveal).not.toHaveBeenCalled()
  })
}

for (const interruption of [
  'selection',
  'mode',
  'repository',
  'unmount',
] as const) {
  it(`cancels delayed navigation after ${interruption}`, async () => {
    let resolveImage: (value: never) => void = () => {}
    spyOn(ImageService, 'GetImage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve
        })
    )
    const setCenter = mock(async () => true)
    const openAssets = mock()
    const selectAssets = mock()
    const setReveal = mock()
    const hook = renderHook(
      ({ path }) => {
        const owner = useCanvasBoardOwner(path)
        const [selection, setSelection] = useState(emptySelection)
        const operations = useCanvasAssetOperations({
          owner,
          repoPath: path,
          selection,
          setSelection,
          flow: { getNode: () => undefined, getZoom: () => 1, setCenter },
          setExpanded: mock(),
          openAssets,
          selectAssets,
          setReveal,
        } as unknown as Parameters<typeof useCanvasAssetOperations>[0])
        return { owner, operations, selection, setSelection }
      },
      { initialProps: { path: '/repo' } }
    )
    const request = hook.result.current.operations.go(1)
    if (interruption === 'selection')
      act(() =>
        hook.result.current.setSelection({
          surface: 'assets',
          ids: [2],
          edges: [],
          group: null,
        })
      )
    if (interruption === 'mode') {
      hook.result.current.owner.setMode('view')
      hook.result.current.owner.setMode('legacy')
    }
    if (interruption === 'repository') hook.rerender({ path: '/other' })
    if (interruption === 'unmount') hook.unmount()
    await act(async () => {
      resolveImage({ id: 1, placed: false, filePath: '/repo/1.png' } as never)
      await request
    })
    expect(openAssets).not.toHaveBeenCalled()
    expect(selectAssets).not.toHaveBeenCalled()
    expect(setReveal).not.toHaveBeenCalled()
    expect(setCenter).not.toHaveBeenCalled()
    if (interruption !== 'unmount')
      expect(hook.result.current.selection.ids).toEqual(
        interruption === 'selection' ? [2] : []
      )
  })
}
