import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireBuildLock } from './build-lock.ts'

test('contenders wait for the active owner and acquire only after release', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'loom-build-lock-'))
  const lockPath = path.join(temporaryRoot, 'build.lock')

  const releaseFirst = await acquireBuildLock(lockPath, () => false)
  const firstOwner = await readFile(lockPath, 'utf8')
  let cancelSecond = false
  const secondAcquisition = acquireBuildLock(lockPath, () => cancelSecond)
  context.after(async () => {
    cancelSecond = true
    await releaseFirst()
    await secondAcquisition.then(
      (release) => release(),
      () => undefined
    )
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  await delay(200)
  assert.equal(await readFile(lockPath, 'utf8'), firstOwner)

  await releaseFirst()
  const releaseSecond = await secondAcquisition
  assert.notEqual(await readFile(lockPath, 'utf8'), firstOwner)
  await releaseSecond()
})

test('a stale owner fails safely and leaves the lock for explicit recovery', async (context) => {
  if (process.platform === 'win32') {
    context.skip('uses an out-of-range POSIX process ID')
    return
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'loom-stale-lock-'))
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const lockPath = path.join(temporaryRoot, 'build.lock')
  const staleContents = '2147483647\nstale-token\n'
  await writeFile(lockPath, staleContents)

  await assert.rejects(
    acquireBuildLock(lockPath, () => false),
    /Confirm no E2E build is active/
  )
  assert.equal(await readFile(lockPath, 'utf8'), staleContents)
})
