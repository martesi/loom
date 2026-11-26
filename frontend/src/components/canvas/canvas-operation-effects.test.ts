import { expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const sourceRoot = path.resolve(import.meta.dirname, '../..')
const effectsModule = path.resolve(
  sourceRoot,
  'components/canvas/canvas-operation-effects.ts'
)
const allowedPreferenceWriter = path.resolve(
  sourceRoot,
  'components/canvas/use-saved-asset-views.ts'
)
const mutatingBindings =
  /\b(?:ImageService|UndoService|TagService|PromptService|MediaService|SettingsService)\.(?:SetArchived|SetGeometry|SetPositions|SetGeometryFromDisplayAtRevision|LinkSource|UnlinkSource|UnlinkSources|ReverseRelationship|PlaceImages|ImportMedia|MoveFile|TrashImage|PurgeImages|RestoreImage|ReplaceMedia|RescanRepository|Undo|Redo|AddTag|RemoveTag|DetachPrompt|CreateAndAttachPrompt|AttachPrompt|Transcode|SetViewport|InvalidateRenditions|Set)\s*\(/g

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(entryPath)
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : []
  })
}

it('routes Canvas binding writes through the operation effects adapter', () => {
  const violations = sourceFiles(sourceRoot)
    .filter(
      (file) => file !== effectsModule && file !== allowedPreferenceWriter
    )
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file))
    .flatMap((file) => {
      const source = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        ''
      )
      const matches = source.match(mutatingBindings)
      return (
        matches?.map(
          (match) => `${path.relative(sourceRoot, file)}: ${match}`
        ) ?? []
      )
    })

  expect(violations).toEqual([])
})
