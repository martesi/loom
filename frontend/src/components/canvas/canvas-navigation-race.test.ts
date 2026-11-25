import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { useCanvasBoardOwner } from './canvas-board-owner'
import { useCanvasAssetOperations } from './use-canvas-asset-operations'

afterEach(() => {
  cleanup()
  mock.restore()
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
