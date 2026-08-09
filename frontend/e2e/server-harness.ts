import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const frontendDir = path.resolve(import.meta.dirname, '..')
const repoDir = path.resolve(frontendDir, '..')
const port = process.env.E2E_PORT ?? '4173'
const token =
  process.env.E2E_TOKEN ?? process.env.LOOM_TOKEN ?? 'loom-e2e-token'

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    })
    let settled = false

    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${
            signal ? `signal ${signal}` : `status ${code}`
          }`
        )
      )
    })
  })
}

function waitForExit(child: ChildProcess): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
}> {
  return new Promise((resolve, reject) => {
    let settled = false

    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    })
  })
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loom-e2e-'))
  const browseRoot = path.join(tempRoot, 'browse-root')
  const repoPath = path.join(browseRoot, 'e2e-repo')
  const binaryPath = path.join(
    tempRoot,
    process.platform === 'win32' ? 'loom-server.exe' : 'loom-server'
  )

  await mkdir(repoPath, { recursive: true })

  let server: ChildProcess | undefined
  let stopping = false
  const stop = () => {
    stopping = true
    server?.kill('SIGTERM')
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    await run('bun', ['run', 'build'], frontendDir)
    await run(
      'go',
      [
        'build',
        '-tags',
        'server,production',
        '-trimpath',
        '-buildvcs=false',
        '-ldflags=-w -s',
        '-o',
        binaryPath,
        '.',
      ],
      repoDir
    )

    server = spawn(binaryPath, [], {
      cwd: repoDir,
      env: {
        ...process.env,
        LOOM_TOKEN: token,
        LOOM_BROWSE_ROOT: browseRoot,
        ...(process.platform === 'win32'
          ? { APPDATA: path.join(tempRoot, 'config') }
          : { XDG_CONFIG_HOME: path.join(tempRoot, 'config') }),
        WAILS_SERVER_HOST: '127.0.0.1',
        WAILS_SERVER_PORT: port,
      },
      stdio: 'inherit',
    })

    const result = await waitForExit(server)
    if (!stopping) {
      throw new Error(
        `loom server exited before the test run completed with ${
          result.signal ? `signal ${result.signal}` : `status ${result.code}`
        }`
      )
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    if (server && !stopping) {
      server.kill('SIGTERM')
      await waitForExit(server).catch(() => undefined)
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
