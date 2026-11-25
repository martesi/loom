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
import {
  ImageService,
  TagService,
} from '../../../bindings/loom/internal/service'
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

function renderEdge(
  canMutateRelationships: () => boolean,
  owner = createCanvasBoardOwner('/repo')
) {
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
    owner,
    canMutateRelationships,
  } as unknown as Parameters<typeof DetailPanel>[0]
  return { ...render(createElement(DetailPanel, props)), props, change }
}

it('serializes Inspector confirmation with pending board writes', async () => {
  const unlink = spyOn(ImageService, 'UnlinkSource').mockResolvedValue(
    undefined as never
  )
  const owner = createCanvasBoardOwner('/repo')
  owner.setMode('edit')
  let release = () => {}
  const pending = owner.execute(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await Promise.resolve()
  renderEdge(() => owner.allows('relationship'), owner)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Remove relationship' }))
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Remove relationship',
    })
  )
  await act(async () => {})
  const callsBeforeRelease = unlink.mock.calls.length
  await act(async () => {
    release()
    await pending
    await owner.execute(async () => {})
  })
  expect(callsBeforeRelease).toBe(0)
  expect(unlink).toHaveBeenCalledTimes(1)
  owner.dispose()
})

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

it('lists and navigates related images in projected graph order', async () => {
  const image = (id: number) => ({
    id,
    fileName: `${id}.png`,
    filePath: `/repo/${id}.png`,
    fullUrl: `/repo/${id}.png`,
    width: 100,
    height: 100,
    promptText: '',
    placed: false,
    trashed: false,
  })
  spyOn(TagService, 'GetImageTags').mockResolvedValue([] as never)
  const go = mock()
  const props = {
    open: true,
    path: '/repo',
    owner: createCanvasBoardOwner('/repo'),
    data: {
      images: [image(1), image(2), image(3)],
      relationships: [
        { id: 2, sourceImageId: 1, derivedImageId: 3 },
        { id: 1, sourceImageId: 1, derivedImageId: 2 },
      ],
    },
    selection: { surface: 'canvas', ids: [1], edges: [], group: null },
    graphOrder: [1, 2, 3],
    go,
    change: mock(),
    onError: mock(),
    commandRequest: null,
    onCommandRequestHandled: mock(),
    onAction: mock(),
    onSubmitField: mock(),
    selectionRevision: 0,
    restoreEnabled: false,
  } as unknown as Parameters<typeof DetailPanel>[0]
  render(createElement(DetailPanel, props))
  const buttons = await screen.findAllByRole('button', {
    name: /Go to derived asset/,
  })
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
    'Go to derived asset 2.png',
    'Go to derived asset 3.png',
  ])
  fireEvent.click(buttons[0])
  expect(go).toHaveBeenCalledWith(2)
})
