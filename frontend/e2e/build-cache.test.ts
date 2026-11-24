import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { computeBuildKey } from './build-cache.ts'

async function prepareRepo() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'loom-build-key-'))
  await mkdir(path.join(repoDir, 'internal', 'service'), { recursive: true })
  await mkdir(path.join(repoDir, 'frontend', 'src', 'lib'), { recursive: true })
  await writeFile(path.join(repoDir, 'go.mod'), 'module loom\n')
  await writeFile(
    path.join(repoDir, 'internal', 'service', 'x.go'),
    'package service\n'
  )
  await writeFile(
    path.join(repoDir, 'frontend', 'src', 'main.tsx'),
    'export {}\n'
  )
  return repoDir
}

test('build key changes when a build input changes', async () => {
  const repoDir = await prepareRepo()
  try {
    const initial = await computeBuildKey(repoDir)
    assert.equal(await computeBuildKey(repoDir), initial)

    await writeFile(
      path.join(repoDir, 'internal', 'service', 'x.go'),
      'package service\n// changed\n'
    )
    assert.notEqual(await computeBuildKey(repoDir), initial)
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
})

test('build key ignores unit tests and generated output', async () => {
  const repoDir = await prepareRepo()
  try {
    const initial = await computeBuildKey(repoDir)

    await writeFile(
      path.join(repoDir, 'frontend', 'src', 'lib', 'helper.test.ts'),
      'export {}\n'
    )
    await mkdir(path.join(repoDir, 'frontend', 'dist'), { recursive: true })
    await writeFile(
      path.join(repoDir, 'frontend', 'dist', 'index.html'),
      '<html></html>'
    )

    assert.equal(await computeBuildKey(repoDir), initial)
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
})

test('build key tracks the unified entry point but not removed startup files', async () => {
  const repoDir = await prepareRepo()
  try {
    await writeFile(path.join(repoDir, 'main.go'), 'package main\n')
    const initial = await computeBuildKey(repoDir)

    await writeFile(path.join(repoDir, 'app.go'), 'obsolete\n')
    await writeFile(path.join(repoDir, 'main_server.go'), 'obsolete\n')
    assert.equal(await computeBuildKey(repoDir), initial)

    await writeFile(path.join(repoDir, 'main.go'), 'package main\n// changed\n')
    assert.notEqual(await computeBuildKey(repoDir), initial)
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
})
