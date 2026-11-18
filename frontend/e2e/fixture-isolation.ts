import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

export async function restoreFixtureRepos(
  templateRoot: string,
  browseRoot: string,
  configRoot: string,
  attemptDirectory: string
) {
  await rm(browseRoot, { recursive: true, force: true })
  await mkdir(browseRoot, { recursive: true })
  await rm(configRoot, { recursive: true, force: true })

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

export async function clearFirstAttemptMarker(
  markerPath: string,
  retry: number
) {
  if (retry === 0) await rm(markerPath, { force: true })
}
