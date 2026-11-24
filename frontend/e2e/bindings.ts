import { readFileSync } from 'node:fs'
import path from 'node:path'

// Wails serializes service calls to /wails/runtime with a numeric method ID.
// Tests that must interleave with a specific call (for example, delay an image
// fetch until the Inspector closes) match that ID. Deriving it from the
// generated bindings keeps the tests pinned to the generated contract instead
// of copies of magic numbers that silently stop matching after regeneration.
function runtimeMethodID(bindingFile: string, exportedName: string) {
  const source = readFileSync(
    path.resolve(
      import.meta.dirname,
      '../bindings/loom/internal/service',
      bindingFile
    ),
    'utf8'
  )
  const match = source.match(
    new RegExp(
      `export function ${exportedName}\\b[\\s\\S]*?\\$Call\\.ByID\\((\\d+)`
    )
  )
  if (!match) {
    throw new Error(
      `Could not find the runtime method ID for ${exportedName} in ${bindingFile}`
    )
  }
  return match[1]
}

export const getImageMethodID = runtimeMethodID('imageservice.ts', 'GetImage')
export const reverseRelationshipMethodID = runtimeMethodID(
  'imageservice.ts',
  'ReverseRelationship'
)
export const setViewportMethodID = runtimeMethodID(
  'imageservice.ts',
  'SetViewport'
)
