import { describe, expect, it, mock, spyOn } from 'bun:test'
import { act, render, waitFor } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { useRepoListRefresh } from './use-repo-list-refresh'

interface ProbeProps {
  openRequest: number
  revision?: number
  fetchRepos: () => Promise<RepoInfo[] | null>
  update: (repos: RepoInfo[]) => void
  exposeOpen?: (setOpen: (open: boolean) => void) => void
}

function Probe({
  openRequest,
  revision,
  fetchRepos,
  update,
  exposeOpen,
}: ProbeProps) {
  const { open, setOpen } = useRepoListRefresh(openRequest, fetchRepos, update)
  useEffect(() => exposeOpen?.(setOpen), [exposeOpen, setOpen])
  return createElement('div', { 'data-open': open, 'data-revision': revision })
}

const repo = { id: '/repo' } as RepoInfo

describe('useRepoListRefresh', () => {
  it('fetches when opened by openRequest and once per focus event', async () => {
    const fetchRepos = mock(() => Promise.resolve([repo]))
    const update = mock(() => {})
    const view = render(
      createElement(Probe, { openRequest: 1, fetchRepos, update })
    )

    await waitFor(() => expect(fetchRepos).toHaveBeenCalledTimes(1))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(fetchRepos).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('does not refresh on focus while closed', async () => {
    const fetchRepos = mock(() => Promise.resolve([repo]))
    const view = render(
      createElement(Probe, { openRequest: 0, fetchRepos, update: () => {} })
    )
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(fetchRepos).not.toHaveBeenCalled()
    view.unmount()
  })

  it('ignores an in-flight response after the popup closes', async () => {
    let resolveFetch: (repos: RepoInfo[]) => void = () => {}
    const fetchRepos = mock(
      () =>
        new Promise<RepoInfo[]>((resolve) => {
          resolveFetch = resolve
        })
    )
    const update = mock(() => {})
    let setOpen: (open: boolean) => void = () => {}
    const exposeOpen = (setter: (open: boolean) => void) => {
      setOpen = setter
    }
    render(
      createElement(Probe, { openRequest: 1, fetchRepos, update, exposeOpen })
    )
    await waitFor(() => expect(fetchRepos).toHaveBeenCalledTimes(1))
    act(() => setOpen(false))
    await act(async () => {
      resolveFetch([repo])
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('removes its focus listener on unmount', async () => {
    const fetchRepos = mock(() => Promise.resolve([repo]))
    const removeListener = spyOn(window, 'removeEventListener')
    const view = render(
      createElement(Probe, { openRequest: 1, fetchRepos, update: () => {} })
    )
    await waitFor(() => expect(fetchRepos).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(
      removeListener.mock.calls.filter(([type]) => type === 'focus')
    ).toHaveLength(1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(fetchRepos).toHaveBeenCalledTimes(1)
    removeListener.mockRestore()
  })

  it('does not add another listener when rerendered while open', async () => {
    const fetchRepos = mock(() => Promise.resolve([repo]))
    const addListener = spyOn(window, 'addEventListener')
    const props = { openRequest: 1, fetchRepos, update: () => {} }
    const view = render(createElement(Probe, props))
    await waitFor(() => expect(fetchRepos).toHaveBeenCalledTimes(1))
    view.rerender(
      createElement(Probe, { ...props, openRequest: 2, revision: 1 })
    )
    await waitFor(() =>
      expect(
        addListener.mock.calls.filter(([type]) => type === 'focus')
      ).toHaveLength(1)
    )
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(fetchRepos).toHaveBeenCalledTimes(2)
    view.unmount()
    addListener.mockRestore()
  })

  it('keeps the newest result when responses arrive out of order', async () => {
    const pending: Array<(repos: RepoInfo[]) => void> = []
    const fetchRepos = mock(
      () => new Promise<RepoInfo[]>((resolve) => pending.push(resolve))
    )
    const update = mock((_repos: RepoInfo[]) => {})
    render(createElement(Probe, { openRequest: 1, fetchRepos, update }))
    await waitFor(() => expect(fetchRepos).toHaveBeenCalledTimes(1))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(fetchRepos).toHaveBeenCalledTimes(2)
    await act(async () => pending[1]([{ id: 'new' } as RepoInfo]))
    await act(async () => pending[0]([{ id: 'old' } as RepoInfo]))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]?.[0][0]?.id).toBe('new')
  })
})
