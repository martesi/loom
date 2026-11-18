import { rm } from 'node:fs/promises'
import path from 'node:path'
import { getE2ERunId } from './run-context'

const runDir = path.resolve(
  import.meta.dirname,
  '../../.cache/e2e/runs',
  getE2ERunId()
)

export default async function teardown() {
  await Promise.all([
    rm(path.join(runDir, 'fixture-root.json'), { force: true }),
    rm(path.join(runDir, 'fixture-attempt.json'), { force: true }),
    rm(path.join(runDir, 'fixtures'), { force: true, recursive: true }),
  ])
}
