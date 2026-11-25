import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { createElement } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import { createCanvasBoardOwner } from './canvas-board-owner'

mock.module('@lingui/core/macro', () => ({
  plural: (count: number, messages: { one: string; other: string }) =>
    (count === 1 ? messages.one : messages.other).replace('#', String(count)),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${part}${String(values[index] ?? '')}`,
      ''
    ),
}))
function Trans({ children }: { children: unknown }) {
  return children
}
function Plural({
  value,
  one,
  other,
}: {
  value: number
  one: string
  other: string
}) {
  return (value === 1 ? one : other).replace('#', String(value))
}
mock.module('@lingui/react/macro', () => ({ Trans, Plural }))
const { DetailPanel } = await import('./detail-panel')

afterEach(() => {
  cleanup()
  mock.restore()
})

function renderEdge(canMutateRelationships: () => boolean) {
  const change = mock(async () => {})
  const props = {
    open: true,
    path: '/repo',
    data: {
      images: [],
      relationships: [{ id: 7, sourceImageId: 1, derivedImageId: 2 }],
    },
    selection: { surface: 'canvas', ids: [], edges: [7], group: null },
    change,
    go: mock(),
    onError: mock(),
    commandRequest: null,
    onCommandRequestHandled: mock(),
    onAction: mock(),
    onSubmitField: mock(async () => {}),
    selectionRevision: 0,
    restoreEnabled: false,
    canMutateRelationships,
  } as unknown as Parameters<typeof DetailPanel>[0]
  return { ...render(createElement(DetailPanel, props)), props, change }
}

it('Escape cancels edge removal without mutation', async () => {
  const unlink = spyOn(ImageService, 'UnlinkSource').mockResolvedValue(
    undefined as never
  )
  renderEdge(() => true)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Remove relationship' }))
  const dialog = screen.getByRole('dialog', { name: 'Remove relationship?' })
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(dialog.hasAttribute('data-closed')).toBe(true))
  expect(unlink).not.toHaveBeenCalled()
})

it('confirms exactly one unlink', async () => {
  const unlink = spyOn(ImageService, 'UnlinkSource').mockResolvedValue(
    undefined as never
  )
  const { change } = renderEdge(() => true)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Remove relationship' }))
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Remove relationship',
    })
  )
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1))
  expect(unlink).toHaveBeenCalledTimes(1)
  expect(unlink).toHaveBeenCalledWith('/repo', 7)
})

it('rechecks the current hidden mode at confirmation', async () => {
  const unlink = spyOn(ImageService, 'UnlinkSource').mockResolvedValue(
    undefined as never
  )
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  renderEdge(() => owner.allows('relationship'))
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Remove relationship' }))
  const confirm = within(screen.getByRole('dialog')).getByRole('button', {
    name: 'Remove relationship',
  })
  owner.setMode('view')
  fireEvent.click(confirm)
  expect(unlink).not.toHaveBeenCalled()
})
