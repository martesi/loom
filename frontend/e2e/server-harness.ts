import { type ChildProcess, spawn } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import { computeBuildKey } from './build-cache'
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
const binDir = path.join(cacheDir, 'bin')
const buildStateFile = path.join(cacheDir, 'build-state.json')
const runId = getE2ERunId()
const runDir = path.join(cacheDir, 'runs', runId)
const fixtureDir = path.join(runDir, 'fixtures')
const fixtureRootFile = path.join(runDir, 'fixture-root.json')
const buildLockFile = path.join(cacheDir, 'build.lock')
const serverCount = Math.max(1, Number(process.env.E2E_WORKERS ?? '1'))
const basePort = Number(process.env.E2E_PORT ?? '4173')
let activeBuildCommand: ChildProcess | undefined
let activeBuildTermination: Promise<void> | undefined

type BuildState = { key: string }

type FixtureServer = {
  url: string
  port: number
  configRoot: string
}

// Keep the browser fixtures outside the repository checkout. The files are
// deliberately created here rather than copied from a fixture directory so
// ignored/generated workspace assets can never affect the server-mode suite.
// Every test attempt gets a fresh copy of each repo so .loom state and
// filesystem mutations cannot leak across attempts.
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

// Solid-gray PNGs with real dimensions. The 1x1 fixture locks the lightbox
// Zoom plugin at minZoom === maxZoom, so zoom gestures are no-ops on it;
// the lightbox fixtures need a bitmap larger than the slide area instead.
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function solidPng(width: number, height: number, gray = 128): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1), gray)
  for (let y = 0; y < height; y++) raw[y * (stride + 1)] = 0
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type, 'ascii')
    const header = Buffer.alloc(8)
    header.writeUInt32BE(data.length, 0)
    typeBytes.copy(header, 4)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
    return Buffer.concat([header, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const lightboxPng = solidPng(1600, 1200)
const previewPng = solidPng(2400, 1200, 96)

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
  { name: 'import-empty-fixtures', files: [] },
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
  {
    name: 'rescan-fixtures',
    files: [
      'rescan-alpha.png',
      ...Array.from(
        { length: 79 },
        (_, index) => `rescan-added-${String(index + 1).padStart(3, '0')}.png`
      ),
    ],
  },
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
    files: [
      'lightbox-alpha.png',
      'lightbox-beta.png',
      'lightbox-gamma.png',
      // Same-folder traversal set for folder-opened preview coverage:
      // three images isolated in a subfolder so the folder carousel can be
      // asserted across >=3 slides while root images must never appear.
      'album/lightbox-delta.png',
      'album/lightbox-epsilon.png',
      'album/lightbox-zeta.png',
    ],
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
  { name: 'preview-fixtures', files: ['preview-alpha.png'] },
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
          // Lightbox fixtures need real dimensions for zoom (see above).
          await writeFile(
            filePath,
            fileName.startsWith('lightbox-') || fileName.includes('/lightbox-')
              ? lightboxPng
              : name === 'preview-fixtures'
                ? previewPng
                : fixturePng
          )
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

async function fileExists(filePath: string) {
  return stat(filePath).then(
    () => true,
    () => false
  )
}

async function readBuildState(): Promise<BuildState | null> {
  return readFile(buildStateFile, 'utf8').then(
    (contents) => JSON.parse(contents) as BuildState,
    () => null
  )
}

async function buildServer(binaryPath: string) {
  const [key, state] = await Promise.all([
    computeBuildKey(repoDir),
    readBuildState(),
  ])
  const cached =
    state?.key === key &&
    (await fileExists(binaryPath)) &&
    (await fileExists(path.join(frontendDir, 'dist', 'index.html'))) &&
    (await fileExists(
      path.join(
        frontendDir,
        'bindings',
        'loom',
        'internal',
        'service',
        'index.ts'
      )
    ))

  if (cached) {
    console.log(
      'E2E build cache hit; reusing frontend bundle and server binary'
    )
    return
  }

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
  await writeFile(buildStateFile, JSON.stringify({ key } satisfies BuildState))
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate an E2E server port')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}

async function waitForHealth(port: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const healthy = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    }).then(
      (response) => response.ok,
      () => false
    )
    if (healthy) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`E2E server on port ${port} did not become healthy`)
}

async function startServers(
  binaryPath: string,
  browseRoot: string,
  configRoots: string[]
): Promise<Array<{ child: ChildProcess; info: FixtureServer }>> {
  const started: Array<{ child: ChildProcess; info: FixtureServer }> = []
  try {
    for (const [index, configRoot] of configRoots.entries()) {
      const port = index === 0 ? basePort : await freePort()
      const child = spawn(binaryPath, [], {
        cwd: repoDir,
        env: {
          ...process.env,
          LOOM_BROWSE_ROOT: browseRoot,
          ...(process.platform === 'win32'
            ? { APPDATA: configRoot }
            : { XDG_CONFIG_HOME: configRoot }),
          WAILS_SERVER_HOST: '127.0.0.1',
          WAILS_SERVER_PORT: String(port),
        },
        stdio: 'inherit',
      })
      started.push({
        child,
        info: { url: `http://127.0.0.1:${port}`, port, configRoot },
      })
    }
    for (const { info } of started) await waitForHealth(info.port)
    return started
  } catch (error) {
    for (const { child } of started) child.kill('SIGTERM')
    throw error
  }
}

async function main() {
  await mkdir(fixtureDir, { recursive: true })
  const tempRoot = await mkdtemp(path.join(fixtureDir, 'run-'))
  const browseRoot = path.join(tempRoot, 'browse-root')
  const templateRoot = path.join(tempRoot, 'fixture-templates')
  const binaryPath = path.join(
    tempRoot,
    process.platform === 'win32' ? 'loom-server.exe' : 'loom-server'
  )
  const builtBinaryPath = path.join(
    binDir,
    process.platform === 'win32' ? 'loom-server.exe' : 'loom-server'
  )
  const configRoots = Array.from({ length: serverCount }, (_, index) =>
    path.join(tempRoot, `config-${index}`)
  )

  await seedFixtureRepos(templateRoot)
  await mkdir(browseRoot, { recursive: true })
  await Promise.all(
    configRoots.map((configRoot) => mkdir(configRoot, { recursive: true }))
  )

  let servers: Array<{ child: ChildProcess; info: FixtureServer }> = []
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
    for (const { child } of servers) child.kill('SIGTERM')
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
      for (const { child } of servers) child.kill('SIGKILL')
    }, 5_000)
    forceStop.unref()
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    await mkdir(binDir, { recursive: true })
    const releaseBuildLock = await acquireBuildLock(
      buildLockFile,
      () => stopping
    )
    try {
      if (stopping) throw new Error('E2E server startup cancelled')
      await buildServer(builtBinaryPath)
      // Run from a per-run copy so a concurrent run cannot replace the binary
      // while this run's servers are alive.
      await copyFile(builtBinaryPath, binaryPath)
    } finally {
      if (activeBuildTermination) await activeBuildTermination
      await releaseBuildLock()
    }
    if (stopping) throw new Error('E2E server startup cancelled')

    servers = await startServers(binaryPath, browseRoot, configRoots)
    await writeFile(
      fixtureRootFile,
      JSON.stringify({
        browseRoot,
        templateRoot,
        servers: servers.map(({ info }) => info),
      })
    )

    const firstExit = await Promise.race(
      servers.map(async ({ child, info }) => ({
        info,
        result: await waitForExit(child),
      }))
    )
    if (!stopping) {
      throw new Error(
        `loom server on port ${firstExit.info.port} exited before the test run completed with ${
          firstExit.result.signal
            ? `signal ${firstExit.result.signal}`
            : `status ${firstExit.result.code}`
        }`
      )
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    if (forceStop) clearTimeout(forceStop)
    if (!stopping) for (const { child } of servers) child.kill('SIGTERM')
    await Promise.all(
      servers.map(({ child }) => waitForExit(child).catch(() => undefined))
    )
    await rm(fixtureRootFile, { force: true })
    await rm(fixtureDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
