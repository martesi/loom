import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Toast } from '@base-ui-components/react/toast'
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
import { Toaster } from './ui/toast'

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
function Trans({ children }: { children: unknown }) {
  return children
}
mock.module('@lingui/react/macro', () => ({
  Trans,
}))
const { RepositorySettings } = await import('./settings-repository')

const sectionRef = () => {}

function renderSettings(
  overrides: Partial<Parameters<typeof RepositorySettings>[0]> = {}
) {
  const props: Parameters<typeof RepositorySettings>[0] = {
    repoPath: '/repo',
    rescanRepository: mock(() => Promise.resolve(1)),
    invalidateRenditions: mock(() => Promise.resolve(1)),
    refreshRepository: mock(() => Promise.resolve()),
    onRenditionsInvalidated: mock(() => {}),
    sectionRef,
    ...overrides,
  }
  const view = render(
    createElement(
      Toast.Provider,
      null,
      createElement(RepositorySettings, props),
      createElement(Toaster)
    )
  )
  return { ...view, props }
}

async function confirmInvalidation() {
  fireEvent.click(screen.getByRole('button', { name: 'Invalidate cache' }))
  const confirmation = screen.getByRole('dialog', {
    name: 'Invalidate generated renditions?',
  })
  fireEvent.click(
    within(confirmation).getByRole('button', { name: 'Invalidate cache' })
  )
  await waitFor(() => expect(document.body.contains(confirmation)).toBe(false))
}

afterEach(cleanup)

describe('RepositorySettings', () => {
  it('reports a successful rescan count and refreshes the repository', async () => {
    const { props } = renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Rescan repository' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '1 new or changed asset found.'
      )
    )
    expect(props.rescanRepository).toHaveBeenCalledWith('/repo')
    expect(props.refreshRepository).toHaveBeenCalledTimes(1)
  })

  it('shows an explicit zero result', async () => {
    const { props } = renderSettings({
      rescanRepository: mock(() => Promise.resolve(0)),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rescan repository' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '0 new or changed assets found.'
      )
    )
    expect(props.refreshRepository).toHaveBeenCalledTimes(1)
  })

  it('reports rescan rejection without refreshing', async () => {
    const { props } = renderSettings({
      rescanRepository: mock(() =>
        Promise.reject(new Error('scan unavailable'))
      ),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rescan repository' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Rescan failed: scan unavailable'
      )
    )
    expect(props.refreshRepository).not.toHaveBeenCalled()
  })

  it('reports successful invalidation and refreshes', async () => {
    const { props } = renderSettings()
    await confirmInvalidation()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '1 generated rendition removed.'
      )
    )
    expect(props.invalidateRenditions).toHaveBeenCalledWith('/repo')
    expect(props.onRenditionsInvalidated).toHaveBeenCalledTimes(1)
    expect(props.refreshRepository).toHaveBeenCalledTimes(1)
  })

  it('reports invalidation rejection without refreshing or changing the generation', async () => {
    const { props } = renderSettings({
      invalidateRenditions: mock(() =>
        Promise.reject(new Error('cache unavailable'))
      ),
    })
    await confirmInvalidation()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Cache invalidation failed: cache unavailable'
      )
    )
    expect(props.refreshRepository).not.toHaveBeenCalled()
    expect(props.onRenditionsInvalidated).not.toHaveBeenCalled()
  })

  it('disables both operations and explains when no repository is open', () => {
    const { props } = renderSettings({ repoPath: null })
    expect(screen.getByRole('status').textContent).toContain(
      'Open a repository to use repository actions.'
    )
    expect(
      screen
        .getByRole('button', { name: 'Rescan repository' })
        .matches(':disabled')
    ).toBe(true)
    expect(
      screen
        .getByRole('button', { name: 'Invalidate cache' })
        .matches(':disabled')
    ).toBe(true)
    expect(props.rescanRepository).not.toHaveBeenCalled()
    expect(props.invalidateRenditions).not.toHaveBeenCalled()
  })

  it('guards concurrent rescan clicks and disables the other action while pending', async () => {
    let resolveScan: (count: number) => void = () => {}
    const rescanRepository = mock(
      () =>
        new Promise<number>((resolve) => {
          resolveScan = resolve
        })
    )
    const { props } = renderSettings({ rescanRepository })
    const rescan = screen.getByRole('button', { name: 'Rescan repository' })
    fireEvent.click(rescan)
    fireEvent.click(rescan)
    expect(rescanRepository).toHaveBeenCalledTimes(1)
    expect(rescan.matches(':disabled')).toBe(true)
    expect(
      screen
        .getByRole('button', { name: 'Invalidate cache' })
        .matches(':disabled')
    ).toBe(true)
    await act(async () => resolveScan(2))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '2 new or changed assets found.'
      )
    )
    expect(props.refreshRepository).toHaveBeenCalledTimes(1)
  })

  it('distinguishes refresh failure after service success', async () => {
    const { props } = renderSettings({
      refreshRepository: mock(() => Promise.reject(new Error('view offline'))),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rescan repository' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '1 new or changed asset found. The operation succeeded, but the repository view could not be refreshed: view offline'
      )
    )
    expect(props.rescanRepository).toHaveBeenCalledTimes(1)
    expect(props.refreshRepository).toHaveBeenCalledTimes(1)
  })

  it('does not call invalidation when confirmation is cancelled', () => {
    const { props } = renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Invalidate cache' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.invalidateRenditions).not.toHaveBeenCalled()
    expect(props.refreshRepository).not.toHaveBeenCalled()
  })
})
