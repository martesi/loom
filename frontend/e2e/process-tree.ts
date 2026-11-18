import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export function spawnBuildProcess(
  command: string,
  args: string[],
  cwd: string
) {
  return spawn(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })
}

export async function terminateBuildProcessTree(
  child: ChildProcess,
  force = false
) {
  const pid = child.pid
  if (!pid) {
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
    return
  }

  if (process.platform === 'win32') {
    await runTaskkill(pid, force)
    return
  }

  await Promise.resolve()
    .then(() => process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'))
    .catch((error: unknown) => {
      if (!isNoSuchProcess(error)) throw error
    })
  await waitForBuildProcessTree(pid)
}

export async function waitForBuildProcessTree(pid: number | undefined) {
  if (!pid || process.platform === 'win32') return

  while (await isProcessGroupAlive(pid)) {
    await delay(25)
  }
}

function isProcessGroupAlive(pid: number) {
  return Promise.resolve()
    .then(() => {
      process.kill(-pid, 0)
      return true
    })
    .catch((error: unknown) => !isNoSuchProcess(error))
}

function runTaskkill(pid: number, force: boolean) {
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
  const killer = spawn('taskkill.exe', args, { stdio: 'ignore' })
  return new Promise<void>((resolve, reject) => {
    killer.once('error', reject)
    killer.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`taskkill.exe exited with status ${code}`))
      }
    })
  })
}

function isNoSuchProcess(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}
