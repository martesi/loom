import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { emptySelection } from '../../lib/selection'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { useCanvasAssetOperations } from './use-canvas-asset-operations'
import { useCanvasDropHandlers } from './use-canvas-drop-handlers'

afterEach(() => {
  cleanup()
  mock.restore()
})

function assetIntentHarness() {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  const hook = renderHook(
    ({
      repoPath,
      boardOwner,
    }: {
      repoPath: string
      boardOwner: typeof owner
    }) =>
      useCanvasAssetOperations({
        owner: boardOwner,
        repoPath,
        selection: emptySelection,
        center: () => ({ x: 0, y: 0 }),
        flow: { getNode: () => undefined, getZoom: () => 1, setCenter: mock() },
        reload: mock(async () => {}),
        setSelection: mock(),
        setReveal: mock(),
        setExpanded: mock(),
        openAssets: mock(),
        selectAssets: mock(),
      } as never),
    { initialProps: { repoPath: '/repo', boardOwner: owner } }
  )
  return { owner, hook }
}

function dropProps(
  owner: ReturnType<typeof createCanvasBoardOwner>,
  assetOps: ReturnType<typeof assetIntentHarness>['hook']['result']['current'],
  paste = mock(async () => {})
) {
  return {
    repoPath: '/repo',
    owner,
    flow: { screenToFlowPosition: (point: { x: number; y: number }) => point },
    paste,
    captureIntent: assetOps.captureIntent,
    isCurrentIntent: assetOps.isCurrentIntent,
    reloadForData: mock(async () => null),
    report: mock(),
    assetsPinned: true,
    closeAssets: mock(),
    host: { current: document.createElement('div') },
    setSelection: mock(),
  } as never
}

function fileDrop() {
  const dataTransfer = {
    getData: () => '',
    files: [new File(['image'], 'drop.png', { type: 'image/png' })],
  }
  return {
    preventDefault: mock(),
    dataTransfer,
    clientX: 100,
    clientY: 120,
  } as never
}

it('rejects a file drop whose View intent changes during asynchronous file reading', async () => {
  const { owner, hook } = assetIntentHarness()
  const paste = mock(async () => {})
  const drops = useCanvasDropHandlers(
    dropProps(owner, hook.result.current, paste)
  )
  const original = globalThis.FileReader
  let completeRead: (() => void) | undefined
  class DeferredFileReader {
    onload: ((event: ProgressEvent<FileReader>) => void) | null = null
    onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
    result: string | ArrayBuffer | null = null
    error: DOMException | null = null
    readAsDataURL() {
      completeRead = () => {
        this.result = 'data:image/png;base64,aW1hZ2U='
        this.onload?.({ target: this } as ProgressEvent<FileReader>)
      }
    }
  }
  globalThis.FileReader = DeferredFileReader as unknown as typeof FileReader
  try {
    drops.onDrop(fileDrop())
    owner.setMode('view')
    completeRead?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(paste).not.toHaveBeenCalled()
  } finally {
    globalThis.FileReader = original
  }
})

it('rejects a delayed asset placement after its owner is disposed', async () => {
  const { owner, hook } = assetIntentHarness()
  const getImage = spyOn(ImageService, 'GetImage')
  let resolveImage: ((image: unknown) => void) | undefined
  getImage.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveImage = resolve
      }) as never
  )
  const place = spyOn(ImageService, 'PlaceImages').mockResolvedValue(undefined)
  const setSelection = mock()
  const drops = useCanvasDropHandlers({
    ...dropProps(owner, hook.result.current),
    setSelection,
  })
  const event = {
    preventDefault: mock(),
    dataTransfer: {
      getData: () => JSON.stringify({ repoPath: '/repo', ids: [1] }),
      files: [],
    },
    clientX: 100,
    clientY: 120,
  } as never
  drops.onDrop(event)
  await Promise.resolve()
  owner.dispose()
  resolveImage?.({ id: 1, missing: false, trashed: false })
  await Promise.resolve()
  await Promise.resolve()
  expect(place).not.toHaveBeenCalled()
  expect(setSelection).not.toHaveBeenCalled()
})

it('rejects a delayed asset placement after mode intent changes', async () => {
  const { owner, hook } = assetIntentHarness()
  let resolveImage: ((image: unknown) => void) | undefined
  spyOn(ImageService, 'GetImage').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveImage = resolve
      }) as never
  )
  const place = spyOn(ImageService, 'PlaceImages').mockResolvedValue(undefined)
  const drops = useCanvasDropHandlers(dropProps(owner, hook.result.current))
  drops.onDrop({
    preventDefault: mock(),
    dataTransfer: {
      getData: () => JSON.stringify({ repoPath: '/repo', ids: [1] }),
      files: [],
    },
    clientX: 100,
    clientY: 120,
  } as never)
  await Promise.resolve()
  owner.setMode('view')
  resolveImage?.({ id: 1, missing: false, trashed: false })
  await Promise.resolve()
  await Promise.resolve()
  expect(place).not.toHaveBeenCalled()
})

it('rejects a delayed file drop after repository navigation', async () => {
  const { owner, hook } = assetIntentHarness()
  const paste = mock(async () => {})
  const drops = useCanvasDropHandlers(
    dropProps(owner, hook.result.current, paste)
  )
  const original = globalThis.FileReader
  let completeRead: (() => void) | undefined
  class DeferredFileReader {
    onload: ((event: ProgressEvent<FileReader>) => void) | null = null
    onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
    result: string | ArrayBuffer | null = null
    error: DOMException | null = null
    readAsDataURL() {
      completeRead = () => {
        this.result = 'data:image/png;base64,aW1hZ2U='
        this.onload?.({ target: this } as ProgressEvent<FileReader>)
      }
    }
  }
  globalThis.FileReader = DeferredFileReader as unknown as typeof FileReader
  try {
    drops.onDrop(fileDrop())
    const nextOwner = createCanvasBoardOwner('/other')
    nextOwner.setMode('edit')
    hook.rerender({ repoPath: '/other', boardOwner: nextOwner })
    completeRead?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(paste).not.toHaveBeenCalled()
  } finally {
    globalThis.FileReader = original
  }
})
