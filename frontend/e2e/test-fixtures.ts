import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import { acquireFileLock } from './file-lock'
import { getAttemptDirectory, restoreFixtureRepos } from './fixture-isolation'
import { getE2ERunId } from './run-context'

export type FixtureServer = {
  url: string
  port: number
  configRoot: string
}

type FixtureRoots = {
  browseRoot: string
  templateRoot: string
  servers: FixtureServer[]
}

const runId = getE2ERunId()
const runDir = path.resolve(
  import.meta.dirname,
  `../../.cache/e2e/runs/${runId}`
)
const fixtureRootFile = path.join(runDir, 'fixture-root.json')
// parallelIndex is the stable worker slot (0..workers-1); workerIndex increases
// every time Playwright restarts a worker process after a failure.
const parallelIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
const fixtureAttemptFile = path.join(
  runDir,
  `fixture-attempt-${parallelIndex}.json`
)

// One app server per Playwright worker: the server reads its config root once
// at boot, so separate config roots (and therefore separate recents and
// preferences) require separate server processes.
export const test = base.extend<
  { restoreFixtures: undefined; clipboardAccess: undefined },
  { fixtureServer: FixtureServer }
>({
  fixtureServer: [
    // biome-ignore lint/correctness/noEmptyPattern: worker fixture has no dependencies
    async ({}, use, workerInfo) => {
      const roots = JSON.parse(
        await readFile(fixtureRootFile, 'utf8')
      ) as FixtureRoots
      const server = roots.servers[workerInfo.parallelIndex]
      if (!server) {
        throw new Error(
          `No E2E server was started for worker slot ${workerInfo.parallelIndex}`
        )
      }
      await use(server)
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ fixtureServer }, use) => {
    await use(fixtureServer.url)
  },
  restoreFixtures: [
    async ({ browserName, fixtureServer }, use, testInfo) => {
      const roots = JSON.parse(
        await readFile(fixtureRootFile, 'utf8')
      ) as FixtureRoots
      const attemptDirectory = getAttemptDirectory(
        `${testInfo.project.name}-${browserName}-${testInfo.testId}`,
        testInfo.retry
      )
      await restoreFixtureRepos(
        roots.templateRoot,
        roots.browseRoot,
        fixtureServer.configRoot,
        attemptDirectory
      )
      await writeFile(fixtureAttemptFile, JSON.stringify({ attemptDirectory }))
      await use(undefined)
    },
    { auto: true },
  ],
  // The OS clipboard is shared by every browser on the machine, so tests that
  // read or write it must not overlap across parallel workers.
  // biome-ignore lint/correctness/noEmptyPattern: fixture has no dependencies
  clipboardAccess: async ({}, use) => {
    const release = await acquireFileLock(path.join(runDir, 'clipboard.lock'))
    try {
      await use(undefined)
    } finally {
      await release()
    }
  },
})

export { expect }
