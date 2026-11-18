import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const malformedLockGraceMs = 10_000

export async function acquireBuildLock(
  lockPath: string,
  isStopping: () => boolean
) {
  await mkdir(path.dirname(lockPath), { recursive: true })

  while (!isStopping()) {
    const attempt = await open(lockPath, 'wx').then(
      (handle) => ({ handle }) as const,
      (error: unknown) => ({ error }) as const
    )
    if ('handle' in attempt) {
      const token = randomUUID()
      const initialized = await attempt.handle
        .writeFile(`${process.pid}\n${token}\n`)
        .then(
          () => attempt.handle.close().then(() => true),
          () =>
            attempt.handle
              .close()
              .then(() => unlink(lockPath))
              .then(() => false)
        )
      if (!initialized) throw new Error('Could not initialize E2E build lock')

      return async () => {
        const contents = await readFile(lockPath, 'utf8').then(
          (value) => value,
          () => ''
        )
        if (contents.split('\n')[1] === token) {
          await unlink(lockPath).catch(() => undefined)
        }
      }
    }

    if (!isAlreadyExists(attempt.error)) throw attempt.error
    const contention = await inspectContention(lockPath)
    if (contention.kind === 'missing') continue
    if (contention.kind === 'stale') {
      throw new Error(
        `Found a stale E2E build lock at ${lockPath} (owner PID ${contention.pid} is not running). ` +
          'Confirm no E2E build is active, remove this lock file, then rerun.'
      )
    }
    if (contention.kind === 'malformed' && contention.expired) {
      throw new Error(
        `Found an unreadable E2E build lock at ${lockPath}. ` +
          'Confirm no E2E build is active, remove this lock file, then rerun.'
      )
    }
    await delay(100)
  }

  throw new Error('E2E build lock acquisition was cancelled')
}

async function inspectContention(lockPath: string) {
  const details = await stat(lockPath).then(
    (value) => value,
    () => null
  )
  if (!details) return { kind: 'missing' } as const

  const contents = await readFile(lockPath, 'utf8').then(
    (value) => value,
    () => ''
  )
  const pid = Number(contents.split('\n')[0])
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return {
      kind: 'malformed',
      expired: Date.now() - details.mtimeMs > malformedLockGraceMs,
    } as const
  }

  const ownerIsAlive = await isProcessAlive(pid)
  return ownerIsAlive
    ? ({ kind: 'active' } as const)
    : ({ kind: 'stale', pid } as const)
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
