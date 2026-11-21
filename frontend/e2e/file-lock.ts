import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const malformedLockGraceMs = 2_000

/**
 * Cross-process mutex for resources that all workers share but the app treats
 * as global, such as the OS clipboard. Unlike the E2E build lock, a crashed
 * owner is reclaimed automatically: the work it guarded has already stopped.
 */
export async function acquireFileLock(
  lockPath: string,
  options: { timeoutMs?: number } = {}
) {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)

  while (Date.now() < deadline) {
    const handle = await open(lockPath, 'wx').then(
      (value) => value,
      (error: unknown) => {
        if (!isAlreadyExists(error)) throw error
        return null
      }
    )
    if (handle) {
      const token = randomUUID()
      await handle.writeFile(`${process.pid}\n${token}\n`)
      await handle.close()
      return async () => {
        const contents = await readFile(lockPath, 'utf8').catch(() => '')
        if (contents.split('\n')[1] === token) {
          await unlink(lockPath).catch(() => undefined)
        }
      }
    }

    const owner = await readOwner(lockPath)
    if (owner === 'missing') continue
    if (owner === 'stale' || owner === 'malformed-expired') {
      await unlink(lockPath).catch(() => undefined)
      continue
    }
    await delay(50)
  }

  throw new Error(`Timed out waiting for the shared test lock at ${lockPath}`)
}

async function readOwner(lockPath: string) {
  const details = await stat(lockPath).catch(() => null)
  if (!details) return 'missing' as const
  const contents = await readFile(lockPath, 'utf8').catch(() => '')
  const pid = Number(contents.split('\n')[0])
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return Date.now() - details.mtimeMs > malformedLockGraceMs
      ? ('malformed-expired' as const)
      : ('active' as const)
  }
  return (await isProcessAlive(pid)) ? ('active' as const) : ('stale' as const)
}

function isProcessAlive(pid: number) {
  return Promise.resolve()
    .then(() => {
      process.kill(pid, 0)
      return true
    })
    .catch((error: unknown) => !isNoSuchProcess(error))
}

function isAlreadyExists(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isNoSuchProcess(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}
