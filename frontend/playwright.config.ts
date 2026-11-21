import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'
import { getE2ERunId } from './e2e/run-context'

const configuredPort = process.env.E2E_PORT ?? process.env.PLAYWRIGHT_PORT
const port = configuredPort ? Number(configuredPort) : await findAvailablePort()
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`E2E_PORT must be a valid TCP port, got ${port}`)
}

const runId = getE2ERunId(process.env.LOOM_E2E_RUN_ID ?? randomUUID())
process.env.LOOM_E2E_RUN_ID = runId
process.env.E2E_PORT = String(port)

const baseURL = `http://127.0.0.1:${port}`
const chromiumBin = process.env.CHROMIUM_BIN
const cacheDir = path.resolve(import.meta.dirname, '../.cache/e2e')
const runDir = path.join(cacheDir, 'runs', runId)
const workers = Math.max(
  1,
  Number(
    process.env.E2E_WORKERS ??
      Math.min(process.env.CI ? 2 : 4, os.availableParallelism())
  )
)
process.env.E2E_WORKERS = String(workers)

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // Benchmarks are measurement runs, not behavior tests. They have their own
  // config (playwright.benchmark.config.ts) and fixture set.
  testIgnore: '**/benchmarks/**',
  globalTeardown: './e2e/teardown.ts',
  // Each worker owns one app server, config root, and browser context, so
  // tests are isolated and can run in parallel.
  fullyParallel: true,
  workers,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: !!process.env.CI,
  // Fixtures are restored from immutable templates before each attempt.
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: path.join(runDir, 'playwright-report'), open: 'never' },
    ],
  ],
  outputDir: path.join(runDir, 'test-results'),
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: chromiumBin
      ? {
          executablePath: chromiumBin,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        }
      : undefined,
  },
  webServer: {
    command: 'bun run e2e/server-harness.ts',
    cwd: process.cwd(),
    url: `${baseURL}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      E2E_PORT: String(port),
      E2E_WORKERS: String(workers),
      LOOM_E2E_RUN_ID: runId,
    },
  },
})

async function findAvailablePort() {
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
