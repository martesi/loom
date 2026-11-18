import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import {
  clearFirstAttemptMarker,
  getAttemptDirectory,
  restoreFixtureRepos,
} from './fixture-isolation'
import { getE2ERunId } from './run-context'

type FixtureRoots = {
  browseRoot: string
  configRoot: string
  templateRoot: string
}

const runId = getE2ERunId()
const fixtureRootFile = path.resolve(
  import.meta.dirname,
  `../../.cache/e2e/runs/${runId}/fixture-root.json`
)
const fixtureAttemptFile = path.resolve(
  import.meta.dirname,
  `../../.cache/e2e/runs/${runId}/fixture-attempt.json`
)

export function getRetryFixtureMarkerPath(repeatEachIndex: number) {
  return path.resolve(
    import.meta.dirname,
    `../../.cache/e2e/runs/${runId}/retry-fixtures-first-attempt-${repeatEachIndex}.json`
  )
}

export const test = base.extend<{ restoreFixtures: undefined }>({
  restoreFixtures: [
    async ({ browserName }, use, testInfo) => {
      // Clear before root reads so setup failures cannot reuse an older marker.
      await clearFirstAttemptMarker(
        getRetryFixtureMarkerPath(testInfo.repeatEachIndex),
        testInfo.retry
      )
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
        roots.configRoot,
        attemptDirectory
      )
      await writeFile(fixtureAttemptFile, JSON.stringify({ attemptDirectory }))
      await use(undefined)
    },
    { auto: true },
  ],
})

// Keep Playwright at one worker: restoration deletes the shared browse and
// config roots, and helpers discover the active attempt through one shared
// run-scoped file. Parallel workers could erase each other's fixtures or read
// another worker's attempt path.

export { expect }
