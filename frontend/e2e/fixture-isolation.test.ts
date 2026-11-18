import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  getAttemptDirectory,
  restoreFixtureRepos,
} from './fixture-isolation.ts'

test('restores each fixture repo from its pristine template', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loom-e2e-fixtures-'))
  const templateRoot = path.join(tempRoot, 'templates')
  const browseRoot = path.join(tempRoot, 'browse')
  const configRoot = path.join(tempRoot, 'config')
  const templateRepo = path.join(templateRoot, 'retry-fixtures')
  const firstAttempt = getAttemptDirectory('test-case', 0)
  const retryAttempt = getAttemptDirectory('test-case', 1)
  const firstRepo = path.join(browseRoot, firstAttempt, 'retry-fixtures')
  const retryRepo = path.join(browseRoot, retryAttempt, 'retry-fixtures')

  try {
    await mkdir(templateRepo, { recursive: true })
    await writeFile(path.join(templateRepo, 'image.png'), 'pristine')
    await restoreFixtureRepos(
      templateRoot,
      browseRoot,
      configRoot,
      firstAttempt
    )

    await writeFile(path.join(firstRepo, 'image.png'), 'mutated')
    await mkdir(path.join(firstRepo, '.loom'), { recursive: true })
    await writeFile(path.join(firstRepo, '.loom', 'state.json'), '{}')
    await writeFile(path.join(firstRepo, 'retry-output.png'), 'generated')
    await mkdir(configRoot, { recursive: true })
    await writeFile(path.join(configRoot, 'config.json'), 'stale config')

    await restoreFixtureRepos(
      templateRoot,
      browseRoot,
      configRoot,
      retryAttempt
    )

    assert.equal(
      await readFile(path.join(retryRepo, 'image.png'), 'utf8'),
      'pristine'
    )
    await assert.rejects(stat(firstRepo))
    await assert.rejects(readFile(path.join(retryRepo, '.loom', 'state.json')))
    await assert.rejects(readFile(path.join(retryRepo, 'retry-output.png')))
    await assert.rejects(stat(path.join(configRoot, 'config.json')))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
