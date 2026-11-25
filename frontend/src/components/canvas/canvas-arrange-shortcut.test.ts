import { afterEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import type { CanvasActionsContext } from '../../routes/canvas-actions-context'
import { useCanvasKeyboardShortcuts } from './use-canvas-keyboard-shortcuts'

mock.module('@lingui/core/macro', () => ({
  plural: (count: number, messages: { one: string; other: string }) =>
    (count === 1 ? messages.one : messages.other).replace('#', String(count)),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => text + part + String(values[index] ?? ''),
      ''
    ),
}))
const { canvasViewActions } = await import('../../routes/canvas-actions-view')

afterEach(cleanup)

it('Shift+A invokes whole-canvas arrangement with and without selection', () => {
  const arrange = mock(async (_ids?: string[]) => {})
  let selection: string[] = []
  const context = () =>
    ({
      displayNodes: [{ id: '1' }, { id: '2' }],
      selectedCanvasNodeIds: selection,
      arrange,
    }) as unknown as CanvasActionsContext
  const { rerender } = renderHook(() => {
    const actions = canvasViewActions(context())
    const actionRef = useRef(actions)
    actionRef.current = actions
    useCanvasKeyboardShortcuts({
      actionRef,
      executeAction: async (action) => action.execute(),
      selection: {
        surface: 'canvas',
        ids: selection.map(Number),
        edges: [],
        group: null,
      },
      selectedIds: () => selection.map(Number),
      previewImageId: null,
    } as Parameters<typeof useCanvasKeyboardShortcuts>[0])
  })
  act(() =>
    fireEvent.keyDown(document.body, { key: 'A', code: 'KeyA', shiftKey: true })
  )
  selection = ['1']
  rerender()
  act(() =>
    fireEvent.keyDown(document.body, { key: 'A', code: 'KeyA', shiftKey: true })
  )
  expect(arrange).toHaveBeenCalledTimes(2)
  expect(arrange.mock.calls).toEqual([[], []])
})
