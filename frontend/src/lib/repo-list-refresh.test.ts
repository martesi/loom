import { describe, expect, it } from 'bun:test'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { createRepoListRefresh } from './repo-list-refresh'

function installTestWindow() {
  const previous = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: new EventTarget(),
  })
  return () =>
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previous,
    })
}

describe('createRepoListRefresh', () => {
  it('refreshes on focus while open and stops after close', async () => {
    const restoreWindow = installTestWindow()
    const calls: number[] = []
    const controller = createRepoListRefresh(
      () => {
        calls.push(calls.length)
        return Promise.resolve([])
      },
      () => {}
    )
    controller.setOpen(true)
    await Promise.resolve()
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    controller.setOpen(false)
    window.dispatchEvent(new Event('focus'))
    expect(calls).toHaveLength(2)
    controller.dispose()
    restoreWindow()
  })

  it('ignores an out-of-order response', async () => {
    const restoreWindow = installTestWindow()
    const pending: Array<(repos: RepoInfo[]) => void> = []
    const updates: RepoInfo[][] = []
    const controller = createRepoListRefresh(
      () => new Promise((resolve) => pending.push(resolve)),
      (repos) => updates.push(repos)
    )
    controller.setOpen(true)
    const older = controller.refresh()
    const newer = controller.refresh()
    pending[2]([{ id: 'new' } as RepoInfo])
    await newer
    pending[1]([{ id: 'old' } as RepoInfo])
    await older
    expect(updates.map((repos) => repos[0]?.id)).toEqual(['new'])
    controller.dispose()
    restoreWindow()
  })

  it('does not publish a pending response after close', async () => {
    const restoreWindow = installTestWindow()
    let resolve: (repos: RepoInfo[]) => void = () => {}
    const updates: RepoInfo[][] = []
    const controller = createRepoListRefresh(
      () =>
        new Promise((complete) => {
          resolve = complete
        }),
      (repos) => updates.push(repos)
    )
    controller.setOpen(true)
    const request = controller.refresh()
    controller.setOpen(false)
    resolve([{ id: 'stale' } as RepoInfo])
    await request
    expect(updates).toEqual([])
    controller.dispose()
    restoreWindow()
  })
})
