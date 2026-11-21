import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { getE2ERunId } from './run-context'

const runsDir = path.resolve(import.meta.dirname, '../../.cache/e2e/runs')
const runDir = path.join(runsDir, getE2ERunId())

// Runs are only useful while debugging; keep a recent window so artifacts do
// not grow without bound (traces and reports are megabytes per run).
const keptRuns = 10
const minimumAgeMs = 60 * 60 * 1000

export default async function teardown() {
  const attempts = await readdir(runDir).catch(() => [] as string[])
  await Promise.all([
    ...attempts
      .filter((name) => name.startsWith('fixture-attempt-'))
      .map((name) => rm(path.join(runDir, name), { force: true })),
    rm(path.join(runDir, 'fixture-root.json'), { force: true }),
    rm(path.join(runDir, 'fixtures'), { force: true, recursive: true }),
  ])
  await pruneRuns()
}

async function pruneRuns() {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(
    () => []
  )
  const runs = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && entry.name !== path.basename(runDir)
      )
      .map(async (entry) => {
        const directory = path.join(runsDir, entry.name)
        const details = await stat(directory).catch(() => null)
        return details ? { directory, mtimeMs: details.mtimeMs } : null
      })
  )
  const stale = runs
    .filter((run): run is { directory: string; mtimeMs: number } => !!run)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(keptRuns)
    .filter((run) => Date.now() - run.mtimeMs > minimumAgeMs)
  await Promise.all(
    stale.map((run) => rm(run.directory, { recursive: true, force: true }))
  )
}
