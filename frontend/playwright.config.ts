import path from 'node:path'
import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? process.env.PLAYWRIGHT_PORT ?? 4173)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`E2E_PORT must be a valid TCP port, got ${port}`)
}

const baseURL = `http://127.0.0.1:${port}`
const chromiumBin = process.env.CHROMIUM_BIN
const cacheDir = path.resolve(import.meta.dirname, '../.cache/e2e')

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  testIgnore:
    process.env.LOOM_BENCHMARK === '1' ? undefined : '**/*-benchmark.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: path.join(cacheDir, 'playwright-report'), open: 'never' },
    ],
  ],
  outputDir: path.join(cacheDir, 'test-results'),
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
    },
  },
})
