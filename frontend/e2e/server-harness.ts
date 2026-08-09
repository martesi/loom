import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const frontendDir = path.resolve(import.meta.dirname, '..')
const repoDir = path.resolve(frontendDir, '..')
const port = process.env.E2E_PORT ?? '4173'
const token =
  process.env.E2E_TOKEN ?? process.env.LOOM_TOKEN ?? 'loom-e2e-token'

// Keep the browser fixtures outside the repository checkout. The files are
// deliberately created here rather than copied from a fixture directory so
// ignored/generated workspace assets can never affect the server-mode suite.
// Every test gets its own repo so .loom state and settings cannot leak across
// tests even though the Playwright web server is shared by the worker.
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const fixtureRepos = [
  { name: 'e2e-repo', files: ['auth-fixture.png'] },
  {
    name: 'canvas-fixtures',
    files: ['canvas-alpha.png', 'canvas-beta.png'],
  },
  { name: 'remove-fixtures', files: ['remove-me.png'] },
  { name: 'context-menu-fixtures', files: ['context-menu.png'] },
  { name: 'menu-linux-fixtures', files: ['menu-alpha.png', 'menu-beta.png'] },
  { name: 'menu-mac-fixtures', files: ['menu-alpha.png', 'menu-beta.png'] },
  { name: 'filename-fixtures', files: ['hover-target.png'] },
  {
    name: 'explorer-fixtures',
    files: ['canvas-trash.png', 'library-trash.png'],
  },
] as const

async function seedFixtureRepos(browseRoot: string) {
  await Promise.all(
    fixtureRepos.map(async ({ name, files }) => {
      const repoPath = path.join(browseRoot, name)
      await mkdir(repoPath, { recursive: true })
      await Promise.all(
        files.map((fileName) =>
          writeFile(path.join(repoPath, fileName), fixturePng)
        )
      )
    })
  )
}

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
  await seedFixtureRepos(browseRoot)

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
