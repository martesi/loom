import { describe, expect, it } from 'bun:test'
import type { RepoInfo } from '../../bindings/loom/internal/service'
import { enterRepo } from './enter-repo'

const repo = { id: '/repo', path: '/repo', openedElsewhere: false } as RepoInfo

describe('enterRepo', () => {
  it('does not update or navigate when opened elsewhere', () => {
    const update = () => calls.push('update')
    const navigate = () => calls.push('navigate')
    const calls: string[] = []
    enterRepo({ ...repo, openedElsewhere: true }, update, navigate)
    expect(calls).toEqual([])
  })

  it('updates the current repo and navigates for normal repo info', () => {
    const calls: string[] = []
    enterRepo(repo, () => calls.push('update'), () => calls.push('navigate'))
    expect(calls).toEqual(['update', 'navigate'])
  })
})
