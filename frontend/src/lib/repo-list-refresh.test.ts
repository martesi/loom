import { describe, expect, it } from 'bun:test'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { createRepoListRefresh } from './repo-list-refresh'

describe('repo list refresh', () => {
  it('refreshes on focus while open and detaches on close and disposal', () => {
    const originalWindow = globalThis.window
    const events = new EventTarget()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: events,
    })
    let calls = 0
    const controller = createRepoListRefresh(
      () => {
        calls++
        return Promise.resolve([])
      },
      () => {}
    )
    controller.setOpen(true)
    controller.setOpen(true)
    events.dispatchEvent(new Event('focus'))
    controller.setOpen(false)
    events.dispatchEvent(new Event('focus'))
    controller.setOpen(true)
    events.dispatchEvent(new Event('focus'))
    controller.dispose()
    events.dispatchEvent(new Event('focus'))
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
    expect(calls).toBe(2)
  })

  it('ignores an out-of-order stale response', async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: new EventTarget(),
    })
    const pending: Array<(repos: RepoInfo[]) => void> = []
    const updates: RepoInfo[][] = []
    const refresh = createRepoListRefresh(
      () => new Promise((resolve) => pending.push(resolve)),
      (repos) => updates.push(repos)
    )
    refresh.setOpen(true)
    const oldRequest = refresh.refresh()
    const newRequest = refresh.refresh()
    pending[1]([{ id: 'new' } as RepoInfo])
    await newRequest
    pending[0]([{ id: 'old' } as RepoInfo])
    await oldRequest
    expect(updates.map((repos) => repos[0].id)).toEqual(['new'])
    refresh.dispose()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
  })

  it('invalidates an in-flight response when closed', async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: new EventTarget(),
    })
    let resolveResponse: (repos: RepoInfo[]) => void = () => {}
    const updates: RepoInfo[][] = []
    const controller = createRepoListRefresh(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve
        }),
      (repos) => updates.push(repos)
    )
    controller.setOpen(true)
    const pending = controller.refresh()
    controller.setOpen(false)
    resolveResponse([{ id: 'stale' } as RepoInfo])
    await pending
    expect(updates).toEqual([])
    controller.dispose()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
  })
})
