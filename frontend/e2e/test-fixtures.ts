import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import { getAttemptDirectory, restoreFixtureRepos } from './fixture-isolation'
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

export const test = base.extend<{ restoreFixtures: undefined }>({
  restoreFixtures: [
    async ({ browserName }, use, testInfo) => {
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

export { expect }
