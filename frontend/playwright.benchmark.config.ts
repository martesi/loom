import path from 'node:path'
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'
import baseConfig from './playwright.config'

// Benchmarks answer "how fast is it?" and write measurement artifacts. They
// are not behavior tests: they run serially, never retry, need the 1,000-photo
// fixture set, and keep their own artifacts so a normal `test:e2e` run never
// pays for them.
const cacheDir = path.resolve(import.meta.dirname, '../.cache/e2e')
const webServer = baseConfig.webServer as Extract<
  PlaywrightTestConfig['webServer'],
  { command: string }
>

export default defineConfig({
  ...baseConfig,
  testDir: './e2e/benchmarks',
  testMatch: '**/*.spec.ts',
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: path.join(cacheDir, 'benchmark-report'), open: 'never' },
    ],
  ],
  outputDir: path.join(cacheDir, 'benchmark-results'),
  webServer: {
    ...webServer,
    env: {
      ...webServer.env,
      E2E_WORKERS: '1',
      LOOM_BENCHMARK: '1',
    },
  },
})
