import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnBuildProcess, terminateBuildProcessTree } from './process-tree.ts'

test('cancelling a build waits for its ready child process to exit', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'loom-process-tree-'))
  let parent: ReturnType<typeof spawnBuildProcess> | undefined
  context.after(async () => {
    if (parent) {
      await terminateBuildProcessTree(parent, true).catch(() => undefined)
    }
    await rm(temporaryRoot, { recursive: true, force: true })
  })
  const readyFile = path.join(temporaryRoot, 'child-ready.txt')
  const childScript = `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid)); setInterval(() => {}, 1000)`
  const parentScript = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
  const buildParent = spawnBuildProcess(
    process.execPath,
    ['-e', parentScript],
    process.cwd()
  )
  parent = buildParent
  await once(buildParent, 'spawn')

  const ready = await waitForChildReady(readyFile)
  const childPid = Number(ready)
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
  assert.equal(await isProcessAlive(childPid), true)

  const parentExit = once(buildParent, 'exit')
  await terminateBuildProcessTree(buildParent)
  await parentExit

  assert.equal(await isProcessAlive(childPid), false)
})

async function waitForChildReady(readyFile: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const pid = await readFile(readyFile, 'utf8').then(
      (contents) => contents.trim(),
      () => ''
    )
    if (pid) return pid
    await delay(20)
  }
  throw new Error('build child did not signal readiness')
}

function isProcessAlive(pid: number) {
  return Promise.resolve()
    .then(() => {
      process.kill(pid, 0)
      return true
    })
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return false
      }
      throw error
    })
}
