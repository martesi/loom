import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireFileLock } from './file-lock.ts'

test('holds the lock until release', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loom-file-lock-'))
  const lockPath = path.join(dir, 'clipboard.lock')
  const release = await acquireFileLock(lockPath)
  try {
    assert.match(
      await readFile(lockPath, 'utf8'),
      new RegExp(`^${process.pid}\\n`)
    )
    await assert.rejects(acquireFileLock(lockPath, { timeoutMs: 150 }))
  } finally {
    await release()
    await rm(dir, { recursive: true, force: true })
  }
})

test('reclaims a lock whose owner is gone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loom-file-lock-'))
  const lockPath = path.join(dir, 'clipboard.lock')
  // A PID this high is not a live process on supported platforms.
  await writeFile(lockPath, '999999999\nstale-token\n')
  try {
    const release = await acquireFileLock(lockPath, { timeoutMs: 1_000 })
    assert.match(
      await readFile(lockPath, 'utf8'),
      new RegExp(`^${process.pid}\\n`)
    )
    await release()
    await assert.rejects(stat(lockPath))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
