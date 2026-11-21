import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Restore one attempt's fixture repos and app config. Only this test's
 * attempt directory is touched so parallel workers that share the browse root
 * never erase each other's fixtures.
 */
export async function restoreFixtureRepos(
  templateRoot: string,
  browseRoot: string,
  configRoot: string,
  attemptDirectory: string
) {
  const attemptPrefix = attemptDirectory.replace(/-retry-\d+$/, '')
  for (const entry of await readdir(browseRoot, {
    withFileTypes: true,
  }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith(attemptPrefix)) {
      await rm(path.join(browseRoot, entry.name), {
        recursive: true,
        force: true,
      })
    }
  }
  await rm(configRoot, { recursive: true, force: true })
  await mkdir(configRoot, { recursive: true })

  const attemptRoot = path.join(browseRoot, attemptDirectory)
  await mkdir(attemptRoot, { recursive: true })

  for (const entry of await readdir(templateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await cp(
      path.join(templateRoot, entry.name),
      path.join(attemptRoot, entry.name),
      { recursive: true }
    )
  }
}

export function getAttemptDirectory(testId: string, retry: number) {
  const safeTestId = testId.replace(/[^a-zA-Z0-9_-]/g, '-')
  return `attempt-${safeTestId}-retry-${retry}`
}
