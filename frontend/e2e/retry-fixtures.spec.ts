import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, getRetryFixtureMarkerPath, test } from './test-fixtures'
import { fixtureConfigPath, fixturePath, openFixtureRepo } from './test-helpers'

test.describe.configure({ retries: 1 })

const pristineImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
test('retry restores pristine repo files and clears app config', async ({
  page,
}, testInfo) => {
  const firstAttemptMarker = getRetryFixtureMarkerPath(testInfo.repeatEachIndex)
  const repoRoot = await fixturePath('recent-fixtures')
  const imagePath = path.join(repoRoot, 'recent-alpha.png')
  const appConfigPath = await fixtureConfigPath('Loom', 'config.json')

  if (testInfo.retry === 0) {
    await openFixtureRepo(page, 'recent-fixtures')
    const config = JSON.parse(await readFile(appConfigPath, 'utf8')) as {
      recent: { path: string }[]
    }
    expect(config.recent.map(({ path: recentPath }) => recentPath)).toContain(
      repoRoot
    )

    await writeFile(imagePath, 'mutated by the first attempt')
    await writeFile(path.join(repoRoot, 'retry-output.png'), 'generated')
    await writeFile(
      firstAttemptMarker,
      JSON.stringify({ repoRoot, appConfigPath })
    )
    throw new Error('Intentional first-attempt failure to exercise retry reset')
  }

  expect(testInfo.retry).toBe(1)
  const firstAttempt = JSON.parse(
    await readFile(firstAttemptMarker, 'utf8')
  ) as { repoRoot: string; appConfigPath: string }
  expect(firstAttempt.appConfigPath).toBe(appConfigPath)
  await expect(stat(firstAttempt.repoRoot)).rejects.toThrow()
  expect(await readFile(imagePath)).toEqual(pristineImage)
  await expect(stat(path.join(repoRoot, '.loom'))).rejects.toThrow()
  await expect(stat(path.join(repoRoot, 'retry-output.png'))).rejects.toThrow()
  await expect(stat(appConfigPath)).rejects.toThrow()
})
