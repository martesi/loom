/**
 * Rasterizes frontend/public/loom-mark.svg into the PNG that
 * `wails3 generate icons` consumes (build/Taskfile.yml → generate:appicon).
 *
 * The Wails generator decodes raster input only — its icon command goes
 * through image.Decode — so the SVG cannot be handed to it directly. Doing the
 * conversion here keeps frontend/public/loom-mark.svg the single source of
 * truth and build/appicon.png a generated artifact.
 *
 * Usage: bun scripts/build-appicon.ts [outputPath]  (default: appicon.png)
 */
import { readFile, writeFile } from 'node:fs/promises'
import { Resvg } from '@resvg/resvg-js'

const outputPath = process.argv[2] ?? 'appicon.png'

const svg = await readFile(
  new URL('../public/loom-mark.svg', import.meta.url),
  'utf8'
)

// The mark is square, so width alone fixes both dimensions. 1024 is the
// largest size any platform icon set needs (macOS 512@2x).
const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1024 },
})
  .render()
  .asPng()

await writeFile(outputPath, png)
console.log(`wrote ${outputPath} (${(png.byteLength / 1024).toFixed(1)} KB)`)
