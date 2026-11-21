import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  getAttemptDirectory,
  restoreFixtureRepos,
} from './fixture-isolation.ts'

async function prepare() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loom-e2e-fixtures-'))
  const templateRoot = path.join(tempRoot, 'templates')
  const browseRoot = path.join(tempRoot, 'browse')
  const configRoot = path.join(tempRoot, 'config')
  const templateRepo = path.join(templateRoot, 'sample-fixtures')
  await mkdir(templateRepo, { recursive: true })
  await writeFile(path.join(templateRepo, 'image.png'), 'pristine')
  await mkdir(browseRoot, { recursive: true })
  return { tempRoot, templateRoot, browseRoot, configRoot }
}

test('restores each fixture repo from its pristine template', async () => {
  const { tempRoot, templateRoot, browseRoot, configRoot } = await prepare()
  const firstAttempt = getAttemptDirectory('test-case', 0)
  const firstRepo = path.join(browseRoot, firstAttempt, 'sample-fixtures')

  try {
    await restoreFixtureRepos(
      templateRoot,
      browseRoot,
      configRoot,
      firstAttempt
    )

    await writeFile(path.join(firstRepo, 'image.png'), 'mutated')
    await mkdir(path.join(firstRepo, '.loom'), { recursive: true })
    await writeFile(path.join(firstRepo, '.loom', 'state.json'), '{}')
    await writeFile(path.join(firstRepo, 'generated.png'), 'generated')
    await mkdir(configRoot, { recursive: true })
    await writeFile(path.join(configRoot, 'config.json'), 'stale config')

    await restoreFixtureRepos(
      templateRoot,
      browseRoot,
      configRoot,
      firstAttempt
    )

    assert.equal(
      await readFile(path.join(firstRepo, 'image.png'), 'utf8'),
      'pristine'
    )
    await assert.rejects(stat(path.join(firstRepo, '.loom', 'state.json')))
    await assert.rejects(stat(path.join(firstRepo, 'generated.png')))
    await assert.rejects(stat(path.join(configRoot, 'config.json')))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('a retry replaces every earlier attempt of the same test', async () => {
  const { tempRoot, templateRoot, browseRoot, configRoot } = await prepare()
  const firstAttempt = getAttemptDirectory('retry-case', 0)
  const retryAttempt = getAttemptDirectory('retry-case', 1)

  try {
    await restoreFixtureRepos(
      templateRoot,
      browseRoot,
      configRoot,
      firstAttempt
    )
    await restoreFixtureRepos(
      templateRoot,
      browseRoot,
      configRoot,
      retryAttempt
    )

    await assert.rejects(stat(path.join(browseRoot, firstAttempt)))
    assert.equal(
      await readFile(
        path.join(browseRoot, retryAttempt, 'sample-fixtures', 'image.png'),
        'utf8'
      ),
      'pristine'
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('restoring one attempt leaves other workers attempts intact', async () => {
  const { tempRoot, templateRoot, browseRoot, configRoot } = await prepare()
  const workerA = getAttemptDirectory('worker-a-test', 0)
  const workerB = getAttemptDirectory('worker-b-test', 0)

  try {
    await restoreFixtureRepos(templateRoot, browseRoot, configRoot, workerA)
    await restoreFixtureRepos(templateRoot, browseRoot, configRoot, workerB)

    assert.equal(
      await readFile(
        path.join(browseRoot, workerA, 'sample-fixtures', 'image.png'),
        'utf8'
      ),
      'pristine'
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
