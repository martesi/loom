import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { emptySelection, type Selection } from '../../lib/selection'
import type { CanvasOperationIntent } from './canvas-board-owner'
import { createCanvasBoardOwner } from './canvas-board-owner'
import { useCanvasSelectionAuthority } from './canvas-selection-intent'
import { useCanvasConnectionTool } from './use-canvas-connection-tool'

afterEach(() => {
  cleanup()
  mock.restore()
})

function setup(valid = true, initiallyInactive = false) {
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  const initialSelection: Selection = {
    surface: 'canvas',
    ids: [1],
    edges: [],
    group: null,
  }
  const queued: Array<{
    action: () => Promise<unknown>
    guard?: () => boolean
    intent?: CanvasOperationIntent
  }> = []
  const setError = mock()
  const exitTool = mock()
  let tool = initiallyInactive ? null : 'connect-derivative'
  const hook = renderHook(() => {
    const authority = useCanvasSelectionAuthority('/repo', initialSelection)
    const connectionTool = useCanvasConnectionTool({
      tool,
      anchorId: 1,
      mode: 'edit',
      owner,
      repoPath: '/repo',
      data: { images: [], relationships: [] } as never,
      host: { current: document.createElement('main') },
      targetAt: () => null,
      validTarget: () =>
        valid ? { valid: true } : { valid: false, reason: 'Invalid target' },
      run: (action, guard, intent) => queued.push({ action, guard, intent }),
      setError,
      setPreview: mock(),
      updateTarget: mock(),
      exitTool,
      getSelection: () => authority.selectionRef.current,
      selectionIntentRef: authority.intentRef,
    })
    return { ...connectionTool, authority }
  })
  return {
    ...hook,
    owner,
    queued,
    setError,
    exitTool,
    changeSelection(next: Selection) {
      act(() => hook.result.current.authority.setSelection(next))
    },
    activateTool() {
      tool = 'connect-derivative'
      act(() => hook.rerender())
    },
  }
}

function enterOnNode(id: number) {
  const node = document.createElement('div')
  node.className = 'react-flow__node'
  node.dataset.id = String(id)
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, 'target', { value: node })
  return event
}

it('queues a keyboard link and rejects execution after selection intent changes', async () => {
  const state = setup()
  spyOn(ImageService, 'LinkSource').mockResolvedValue(undefined as never)
  const event = enterOnNode(2)
  act(() => state.result.current.onKeyDownCapture(event as never))
  expect(event.defaultPrevented).toBe(true)
  expect(state.queued).toHaveLength(1)
  expect(state.queued[0].intent?.userIntentRevision).toBe(
    state.result.current.authority.intentRef.current.revision
  )
  expect(state.queued[0].guard?.()).toBe(true)

  state.changeSelection({ ...emptySelection, ids: [3] })
  expect(state.queued[0].guard?.()).toBe(false)
})

it('uses selection authority revision after the connection tool changes interaction state', () => {
  const state = setup(true, true)
  state.activateTool()
  const event = enterOnNode(2)

  act(() => state.result.current.onKeyDownCapture(event as never))

  expect(state.queued).toHaveLength(1)
  expect(state.queued[0].intent?.userIntentRevision).toBe(0)
  expect(state.queued[0].guard?.()).toBe(true)
})

it('rejects a queued keyboard link after an A→B→A intent change', () => {
  const state = setup()
  const event = enterOnNode(2)
  act(() => state.result.current.onKeyDownCapture(event as never))
  expect(state.queued).toHaveLength(1)
  expect(state.queued[0].guard?.()).toBe(true)

  state.changeSelection({ ...emptySelection, ids: [3] })
  state.changeSelection({ ...emptySelection, ids: [1] })
  expect(state.queued[0].guard?.()).toBe(false)
})

it('reports invalid keyboard targets without queuing a backend operation', () => {
  const state = setup(false)
  const event = enterOnNode(2)
  act(() => state.result.current.onKeyDownCapture(event as never))
  expect(event.defaultPrevented).toBe(true)
  expect(state.queued).toHaveLength(0)
  expect(state.setError).toHaveBeenCalledWith('Invalid target')
})

it('cancels the active target workflow with Escape', () => {
  const state = setup()
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  act(() => state.result.current.onKeyDownCapture(event as never))
  expect(event.defaultPrevented).toBe(true)
  expect(state.exitTool).toHaveBeenCalledTimes(1)
})
