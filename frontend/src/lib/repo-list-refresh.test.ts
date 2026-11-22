import { describe, expect, it } from 'bun:test'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { createRepoListRefresh, listenForWindowFocus } from './repo-list-refresh'

describe('repo list refresh', () => {
  it('refreshes on window focus only while the popup is open', () => {
    const originalWindow = globalThis.window
    const events = new EventTarget()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
    let calls = 0
    const cleanup = listenForWindowFocus(true, () => calls++)
    events.dispatchEvent(new Event('focus'))
    cleanup()
    events.dispatchEvent(new Event('focus'))
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    expect(calls).toBe(1)
  })

  it('ignores an out-of-order stale response', async () => {
    const pending: Array<(repos: RepoInfo[]) => void> = []
    const updates: RepoInfo[][] = []
    const refresh = createRepoListRefresh(() => new Promise((resolve) => pending.push(resolve)), (repos) => updates.push(repos))
    const oldRequest = refresh()
    const newRequest = refresh()
    pending[1]([{ id: 'new' } as RepoInfo])
    await newRequest
    pending[0]([{ id: 'old' } as RepoInfo])
    await oldRequest
    expect(updates.map((repos) => repos[0].id)).toEqual(['new'])
  })
})
