import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// Every input that can change the server-mode binary or the frontend bundle
// embedded in it. Generated output (frontend/bindings, frontend/dist, the
// binary) is deliberately absent: those are validated separately.
const includedFiles = [
  'main.go',
  'go.mod',
  'go.sum',
  'bun.lock',
  'package.json',
  'build/config.yml',
  'build/Taskfile.yml',
  'frontend/index.html',
  'frontend/package.json',
  'frontend/tsconfig.json',
  'frontend/vite.config.ts',
]
const includedTrees = ['internal', 'frontend/src', 'frontend/public']

export async function computeBuildKey(repoDir: string): Promise<string> {
  const entries = [...includedFiles]
  for (const tree of includedTrees) await collect(repoDir, tree, entries)
  entries.sort()

  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry).update('\0')
    const contents = await readFile(path.join(repoDir, entry)).catch(() => null)
    if (contents) hash.update(contents)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function collect(repoDir: string, relative: string, entries: string[]) {
  const absolute = path.join(repoDir, relative)
  const children = await readdir(absolute, { withFileTypes: true }).catch(
    () => []
  )
  for (const child of children) {
    const childRelative = path.join(relative, child.name)
    if (child.isDirectory()) {
      await collect(repoDir, childRelative, entries)
      continue
    }
    if (!child.isFile() && !child.isSymbolicLink()) continue
    // Test sources do not reach the binary or the bundle.
    if (/\.test\.[jt]sx?$/.test(child.name)) continue
    if (child.name.endsWith('_test.go')) continue
    entries.push(childRelative)
  }
}
