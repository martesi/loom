import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'

const names = ['current-mark', 'thread-crossing', 'woven-tile']
const labels = {
  'current-mark': 'Current mark (incumbent)',
  'thread-crossing': 'Warp and shuttle',
  'woven-tile': 'Frame and shuttle (weaker)',
}
const sourceDir = '../docs/icon-candidates'
const outputDir = '../.cache/icon-candidates'
const sizes = [16, 32, 64, 256]
await mkdir(outputDir, { recursive: true })

const pngs: Record<string, Record<number, string>> = {}
const upscaledPngs: Record<string, Record<number, string>> = {}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buffer: Buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, content: Buffer) => {
  const name = Buffer.from(type)
  const result = Buffer.alloc(12 + content.length)
  result.writeUInt32BE(content.length, 0)
  name.copy(result, 4)
  content.copy(result, 8)
  result.writeUInt32BE(
    crc32(Buffer.concat([name, content])),
    8 + content.length
  )
  return result
}
const nearestNeighbor = (png: Buffer, scale: number) => {
  let offset = 8
  let width = 0
  let height = 0
  const compressed: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const content = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = content.readUInt32BE(0)
      height = content.readUInt32BE(4)
      if (content[8] !== 8 || content[9] !== 6)
        throw new Error('Expected RGBA PNG')
    }
    if (type === 'IDAT') compressed.push(content)
    offset += length + 12
  }
  const stride = width * 4
  const packed = inflateSync(Buffer.concat(compressed))
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)]
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const raw = packed[y * (stride + 1) + 1 + x]
      const left = x >= 4 ? pixels[row + x - 4] : 0
      const up = y > 0 ? pixels[row - stride + x] : 0
      const upperLeft = y > 0 && x >= 4 ? pixels[row - stride + x - 4] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      if (filter === 2) predictor = up
      if (filter === 3) predictor = Math.floor((left + up) / 2)
      if (filter === 4) {
        const p = left + up - upperLeft
        const a = Math.abs(p - left),
          b = Math.abs(p - up),
          c = Math.abs(p - upperLeft)
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft
      }
      pixels[row + x] = (raw + predictor) & 0xff
    }
  }
  const scaledWidth = width * scale
  const scaledHeight = height * scale
  const rows = Buffer.alloc(scaledHeight * (scaledWidth * 4 + 1))
  for (let y = 0; y < scaledHeight; y++) {
    const sy = Math.floor(y / scale)
    const base = y * (scaledWidth * 4 + 1)
    for (let x = 0; x < scaledWidth; x++) {
      const sx = Math.floor(x / scale)
      pixels.copy(
        rows,
        base + 1 + x * 4,
        sy * stride + sx * 4,
        sy * stride + sx * 4 + 4
      )
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(scaledWidth, 0)
  header.writeUInt32BE(scaledHeight, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
for (const name of names) {
  const svg = await readFile(`${sourceDir}/${name}.svg`, 'utf8')
  pngs[name] = {}
  upscaledPngs[name] = {}
  for (const size of sizes) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
      .render()
      .asPng()
    pngs[name][size] = png.toString('base64')
    if (size === 16 || size === 32) {
      const scale = size === 16 ? 4 : 2
      upscaledPngs[name][size] = nearestNeighbor(png, scale).toString('base64')
    }
    await writeFile(`${outputDir}/${name}-${size}.png`, png)
  }
}

const columns = [
  { size: 16, x: 24, shown: 66, label: 'Native 16 px' },
  { size: 32, x: 112, shown: 96, label: 'Native 32 px' },
  { size: 64, x: 240, shown: 64, label: 'Native 64 px' },
  { size: 256, x: 328, shown: 64, label: 'Native 256 px' },
  { size: 16, x: 520, shown: 256, label: '16 px · 4× nearest neighbor' },
  { size: 32, x: 820, shown: 256, label: '32 px · 2× nearest neighbor' },
]
const rowHeight = 330
const elements = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1520" height="990" viewBox="0 0 1520 990">',
  '<rect width="100%" height="100%" fill="#e8edf3"/>',
]
names.forEach((name, index) => {
  const y = index * rowHeight
  elements.push(
    `<text x="24" y="${y + 32}" font-family="sans-serif" font-size="22" font-weight="bold" fill="#172033">${labels[name]}</text>`
  )
  for (const column of columns) {
    elements.push(
      `<text x="${column.x}" y="${y + 64}" font-family="sans-serif" font-size="14" fill="#526070">${column.label}</text>`,
      `<rect x="${column.x - 5}" y="${y + 75}" width="${column.shown + 10}" height="${column.shown + 10}" rx="4" fill="#fff" stroke="#aab4c2"/>`,
      `<image href="data:image/png;base64,${column.size === 16 || column.size === 32 ? upscaledPngs[name][column.size] : pngs[name][column.size]}" x="${column.x}" y="${y + 80}" width="${column.shown}" height="${column.shown}"/>`
    )
  }
})
elements.push('</svg>')
await writeFile(
  `${outputDir}/legibility-sheet.png`,
  new Resvg(elements.join(''), { fitTo: { mode: 'width', value: 1520 } })
    .render()
    .asPng()
)
console.log(
  `Rendered all candidates at ${sizes.join(', ')} px and wrote ${outputDir}/legibility-sheet.png`
)

const macLayer = await readFile(
  '../build/appicon.icon/Assets/loom-mark.svg',
  'utf8'
)
const macLayerPngs: Record<number, Buffer> = {}
for (const size of [16, 32, 1024]) {
  const png = new Resvg(macLayer, { fitTo: { mode: 'width', value: size } })
    .render()
    .asPng()
  macLayerPngs[size] = png
  await writeFile(`${outputDir}/macos-layer-${size}.png`, png)
}
const macProof = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250" viewBox="0 0 1000 250">',
  '<rect width="100%" height="100%" fill="#e8edf3"/>',
  '<text x="24" y="30" font-family="sans-serif" font-size="18" fill="#172033">Composed macOS layer · 1024 px raster, full-size placement</text>',
  `<image href="data:image/png;base64,${macLayerPngs[1024].toString('base64')}" x="24" y="44" width="184" height="184"/>`,
  '<text x="240" y="62" font-family="sans-serif" font-size="14" fill="#526070">Native 16 px</text>',
  `<image href="data:image/png;base64,${macLayerPngs[16].toString('base64')}" x="240" y="74" width="64" height="64"/>`,
  '<text x="330" y="62" font-family="sans-serif" font-size="14" fill="#526070">Native 32 px</text>',
  `<image href="data:image/png;base64,${macLayerPngs[32].toString('base64')}" x="330" y="74" width="64" height="64"/>`,
  '<text x="430" y="62" font-family="sans-serif" font-size="14" fill="#526070">16 px · 4× NN</text>',
  `<image href="data:image/png;base64,${nearestNeighbor(macLayerPngs[16], 4).toString('base64')}" x="430" y="74" width="64" height="64"/>`,
  '<text x="540" y="62" font-family="sans-serif" font-size="14" fill="#526070">32 px · 2× NN</text>',
  `<image href="data:image/png;base64,${nearestNeighbor(macLayerPngs[32], 2).toString('base64')}" x="540" y="74" width="64" height="64"/>`,
  '<text x="660" y="62" font-family="sans-serif" font-size="14" fill="#526070">Full-bleed edges</text>',
  '<text x="660" y="86" font-family="sans-serif" font-size="12" fill="#526070">Artwork fills the box;</text>',
  '<text x="660" y="104" font-family="sans-serif" font-size="12" fill="#526070">system mask supplies the</text>',
  '<text x="660" y="122" font-family="sans-serif" font-size="12" fill="#526070">outer rounded silhouette.</text>',
  '</svg>',
]
await writeFile(
  `${outputDir}/macos-layer-check.png`,
  new Resvg(macProof.join('')).render().asPng()
)
console.log(`Rendered macOS layer at 16, 32, 1024 px to ${outputDir}`)
