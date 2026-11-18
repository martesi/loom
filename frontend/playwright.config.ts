import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
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

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalTeardown: './e2e/teardown.ts',
  testIgnore:
    process.env.LOOM_BENCHMARK === '1' ? undefined : '**/*-benchmark.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: !!process.env.CI,
  // Fixtures are mutable; retries would reuse state until attempts are isolated.
  retries: 0,
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
