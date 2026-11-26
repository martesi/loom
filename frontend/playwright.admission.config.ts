import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import path from 'node:path'
import { defineConfig } from '@playwright/test'
import { getE2ERunId } from './e2e/run-context'

const port = await findAvailablePort()
const runId = getE2ERunId(process.env.LOOM_E2E_RUN_ID ?? randomUUID())
process.env.LOOM_E2E_RUN_ID = runId
process.env.E2E_PORT = String(port)
process.env.E2E_WORKERS = '1'
const runDir = path.resolve(import.meta.dirname, '../.cache/e2e/runs', runId)

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/admission-facade.spec.ts',
  globalTeardown: './e2e/teardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: path.join(runDir, 'admission-results'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.CHROMIUM_BIN
      ? {
          executablePath: process.env.CHROMIUM_BIN,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        }
      : undefined,
  },
  webServer: {
    command: 'bun run e2e/server-harness.ts',
    cwd: process.cwd(),
    url: `http://127.0.0.1:${port}/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      E2E_PORT: String(port),
      E2E_WORKERS: '1',
      LOOM_E2E_RUN_ID: runId,
      LOOM_E2E_BINDING_PROFILE: 'admissiontest',
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
    throw new Error('Could not allocate an admission-test port')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}
