import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { acquireBuildLock } from './build-lock'
import {
  spawnBuildProcess,
  terminateBuildProcessTree,
  waitForBuildProcessTree,
} from './process-tree'
import { getE2ERunId } from './run-context'

const frontendDir = path.resolve(import.meta.dirname, '..')
const repoDir = path.resolve(frontendDir, '..')
const cacheDir = path.join(repoDir, '.cache', 'e2e')
const runId = getE2ERunId()
const runDir = path.join(cacheDir, 'runs', runId)
const fixtureDir = path.join(runDir, 'fixtures')
const fixtureRootFile = path.join(runDir, 'fixture-root.json')
const buildLockFile = path.join(cacheDir, 'build.lock')
const port = process.env.E2E_PORT ?? '4173'
let activeBuildCommand: ChildProcess | undefined
let activeBuildTermination: Promise<void> | undefined

// Keep the browser fixtures outside the repository checkout. The files are
// deliberately created here rather than copied from a fixture directory so
// ignored/generated workspace assets can never affect the server-mode suite.
// Every test attempt gets a fresh copy of each repo so .loom state and
// filesystem mutations cannot leak across attempts.
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const benchmarkRepos =
  process.env.LOOM_BENCHMARK === '1'
    ? [
        {
          name: 'benchmark-10-fixtures',
          files: Array.from(
            { length: 10 },
            (_, index) => `benchmark-${String(index + 1).padStart(2, '0')}.png`
          ),
        },
        {
          name: 'benchmark-1k-fixtures',
          files: Array.from(
            { length: 1000 },
            (_, index) => `benchmark-${String(index + 1).padStart(4, '0')}.png`
          ),
        },
      ]
    : []

const fixtureRepos = [
  { name: 'e2e-repo', files: ['auth-fixture.png'] },
  {
    name: 'canvas-fixtures',
    files: ['canvas-alpha.png', 'canvas-beta.png'],
  },
  { name: 'remove-fixtures', files: ['remove-me.png'] },
  { name: 'context-menu-fixtures', files: ['context-menu.png'] },
  { name: 'menu-linux-fixtures', files: ['menu-alpha.png', 'menu-beta.png'] },
  {
    name: 'canvas-menu-actions-fixtures',
    files: ['context-alpha.png', 'context-beta.png'],
  },
  {
    name: 'partial-set-fixtures',
    files: ['partial-alpha.png', 'partial-beta.png'],
  },
  { name: 'menu-mac-fixtures', files: ['menu-alpha.png', 'menu-beta.png'] },
  { name: 'filename-fixtures', files: ['hover-target.png'] },
  { name: 'clipboard-fixtures', files: ['hover-target.png'] },
  {
    name: 'set-fixtures',
    files: ['set-alpha.png', 'set-beta.png', 'set-gamma.png'],
  },
  {
    name: 'explorer-fixtures',
    files: ['canvas-trash.png', 'library-trash.png'],
  },
  {
    name: 'library-fixtures',
    files: [
      'root-alpha.png',
      'root-beta.png',
      'nested/folder-gamma.png',
      'nested/deeper/folder-delta.png',
    ],
  },
  {
    name: 'library-selection-fixtures',
    files: [
      'root-alpha.png',
      'root-beta.png',
      'nested/folder-gamma.png',
      'nested/deeper/folder-delta.png',
    ],
  },
  {
    name: 'folders-fixtures',
    files: ['nested/deeper/folder-delta.png'],
  },
  {
    name: 'inspector-fixtures',
    files: ['inspect-alpha.png', 'inspect-beta.png'],
  },
  {
    name: 'gallery-keyboard-fixtures',
    files: [
      'gallery-alpha.png',
      'gallery-beta.png',
      'gallery-gamma.png',
      'gallery-delta.png',
    ],
  },
  {
    name: 'relationship-fixtures',
    files: ['relation-alpha.png', 'relation-beta.png', 'relation-gamma.png'],
  },
  {
    name: 'relationship-self-link-fixtures',
    files: ['relation-alpha.png'],
  },
  {
    name: 'set-source-fixtures',
    files: ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
  },
  {
    name: 'sources-nav-fixtures',
    files: ['relation-alpha.png', 'relation-beta.png'],
  },
  {
    name: 'arrange-resize-fixtures',
    files: ['arrange-alpha.png', 'arrange-beta.png', 'arrange-gamma.png'],
  },
  {
    name: 'group-fixtures',
    files: ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
  },
  {
    name: 'group-drop-fixtures',
    files: ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
  },
  { name: 'resize-fixtures', files: ['resize-alpha.png'] },
  { name: 'rescan-fixtures', files: ['rescan-alpha.png'] },
  { name: 'recent-fixtures', files: ['recent-alpha.png'] },
  { name: 'switch-a-fixtures', files: ['switch-a.png'] },
  { name: 'switch-b-fixtures', files: ['switch-b.png'] },
  { name: 'direct-fixtures', files: ['direct-alpha.png'] },
  { name: 'responsive-fixtures', files: ['responsive-alpha.png'] },
  {
    name: 'shortcut-fixtures',
    files: ['shortcut-alpha.png', 'shortcut-beta.png'],
  },
  { name: 'media-fixtures', files: ['media-alpha.png'] },
  { name: 'image-tools-fixtures', files: ['image-tools-alpha.png'] },
  // Dedicated fixtures for the contextual Canvas Dock
  { name: 'dock-fixtures', files: ['dock-alpha.png', 'dock-beta.png'] },
  { name: 'dock-rel-fixtures', files: ['rel-alpha.png', 'rel-beta.png'] },
  {
    name: 'dock-arrange-fixtures',
    files: ['arrange-alpha.png', 'arrange-beta.png', 'arrange-gamma.png'],
  },
  {
    name: 'dock-group-fixtures',
    files: ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
  },
  { name: 'dock-resize-fixtures', files: ['resize-alpha.png'] },
  {
    name: 'dock-shortcut-fixtures',
    files: ['shortcut-alpha.png', 'shortcut-beta.png'],
  },
  // Dedicated fixtures for the Lightbox preview viewer
  {
    name: 'lightbox-fixtures',
    files: ['lightbox-alpha.png', 'lightbox-beta.png'],
  },
  // Dedicated fixtures for Card & Deck Stacks
  { name: 'card-fixtures', files: ['card-alpha.png', 'card-beta.png'] },
  { name: 'card-hover-fixtures', files: ['hover-alpha.png'] },
  {
    name: 'deck-group-fixtures',
    files: ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
  },
  {
    name: 'deck-drop-fixtures',
    files: ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
  },
  { name: 'deck-theme-fixtures', files: ['theme-alpha.png'] },
  // Dedicated fixtures for Shelves
  { name: 'shelves-fixtures', files: ['shelf-alpha.png', 'shelf-beta.png'] },
  {
    name: 'shelves-inspector-fixtures',
    files: ['shelf-alpha.png', 'shelf-beta.png'],
  },
  {
    name: 'shelves-resize-fixtures',
    files: ['shelf-alpha.png', 'shelf-beta.png'],
  },
  ...benchmarkRepos,
] as const

async function seedFixtureRepos(browseRoot: string) {
  await Promise.all(
    fixtureRepos.map(async ({ name, files }) => {
      const repoPath = path.join(browseRoot, name)
      await mkdir(repoPath, { recursive: true })
      await Promise.all(
        files.map(async (fileName) => {
          const filePath = path.join(repoPath, fileName)
          await mkdir(path.dirname(filePath), { recursive: true })
          await writeFile(filePath, fixturePng)
        })
      )
    })
  )
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnBuildProcess(command, args, cwd)
    activeBuildCommand = child
    let settled = false

    const settle = (
      result:
        | { error: Error }
        | { code: number | null; signal: NodeJS.Signals | null }
    ) => {
      if (settled) return
      settled = true
      void Promise.all([
        waitForBuildProcessTree(child.pid),
        activeBuildTermination ?? Promise.resolve(),
      ]).then(
        () => {
          if (activeBuildCommand === child) activeBuildCommand = undefined
          if ('error' in result) {
            reject(result.error)
            return
          }
          if (result.code === 0) {
            resolve()
            return
          }
          reject(
            new Error(
              `${command} ${args.join(' ')} exited with ${
                result.signal
                  ? `signal ${result.signal}`
                  : `status ${result.code}`
              }`
            )
          )
        },
        (error: unknown) => {
          if (activeBuildCommand === child) activeBuildCommand = undefined
          reject(error)
        }
      )
    }

    child.once('error', (error) => void settle({ error }))
    child.once('exit', (code, signal) => {
      void settle({ code, signal })
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
  await mkdir(fixtureDir, { recursive: true })
  const tempRoot = await mkdtemp(path.join(fixtureDir, 'run-'))
  const browseRoot = path.join(tempRoot, 'browse-root')
  const templateRoot = path.join(tempRoot, 'fixture-templates')
  const configRoot = path.join(tempRoot, 'config')
  const binaryPath = path.join(
    tempRoot,
    process.platform === 'win32' ? 'loom-server.exe' : 'loom-server'
  )

  await seedFixtureRepos(templateRoot)
  await mkdir(browseRoot, { recursive: true })
  await writeFile(
    fixtureRootFile,
    JSON.stringify({ browseRoot, configRoot, templateRoot })
  )

  let server: ChildProcess | undefined
  let forceStop: NodeJS.Timeout | undefined
  let stopping = false
  const stop = () => {
    stopping = true
    if (activeBuildCommand) {
      activeBuildTermination = terminateBuildProcessTree(activeBuildCommand)
      void activeBuildTermination.catch((error: unknown) => {
        console.error('Could not terminate E2E build process tree', error)
      })
    }
    server?.kill('SIGTERM')
    forceStop ??= setTimeout(() => {
      if (activeBuildCommand) {
        activeBuildTermination = terminateBuildProcessTree(
          activeBuildCommand,
          true
        )
        void activeBuildTermination.catch((error: unknown) => {
          console.error('Could not force-stop E2E build process tree', error)
        })
      }
      server?.kill('SIGKILL')
    }, 5_000)
    forceStop.unref()
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    const releaseBuildLock = await acquireBuildLock(
      buildLockFile,
      () => stopping
    )
    try {
      if (stopping) throw new Error('E2E server startup cancelled')
      await run(
        'wails3',
        [
          'generate',
          'bindings',
          '-f',
          '-tags server,production',
          '-clean=true',
          '-ts',
          '-i',
        ],
        repoDir
      )
      if (stopping) throw new Error('E2E server startup cancelled')
      await run('bun', ['run', 'build'], frontendDir)
      if (stopping) throw new Error('E2E server startup cancelled')
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
    } finally {
      if (activeBuildTermination) await activeBuildTermination
      await releaseBuildLock()
    }
    if (stopping) throw new Error('E2E server startup cancelled')

    server = spawn(binaryPath, [], {
      cwd: repoDir,
      env: {
        ...process.env,
        LOOM_BROWSE_ROOT: browseRoot,
        ...(process.platform === 'win32'
          ? { APPDATA: configRoot }
          : { XDG_CONFIG_HOME: configRoot }),
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
    if (forceStop) clearTimeout(forceStop)
    if (server && !stopping) {
      server.kill('SIGTERM')
      await waitForExit(server).catch(() => undefined)
    }
    await rm(fixtureRootFile, { force: true })
    await rm(fixtureDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
