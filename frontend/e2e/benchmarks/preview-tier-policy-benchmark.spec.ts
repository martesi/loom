import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { test } from '../test-fixtures'

const outputPath = path.resolve(
  import.meta.dirname,
  '../../../.cache/e2e/preview-tier-policy.json'
)
const nodeCount = 48
const tiers = [2048, 3072] as const

test.setTimeout(180_000)
test.use({ trace: 'off', screenshot: 'off' })

test('preview tier decode-memory and many-node zoom benchmark', async ({
  page,
  browser,
}) => {
  const results: Awaited<ReturnType<typeof measureTier>>[] = []
  for (const tier of tiers) results.push(await measureTier(page, browser, tier))
  const result = {
    workload: {
      tiersPx: tiers,
      nodes: nodeCount,
      asset: 'locally generated colorful WebP; one unique URL per node',
      canvas:
        '48-image grid with CSS transform zoom; synthetic, not app React Flow',
    },
    results,
    environment: {
      browser: browser.version(),
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      viewport: page.viewportSize(),
    },
  }
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    `\nPreview tier policy browser benchmark\n${JSON.stringify(result, null, 2)}`
  )
})

async function measureTier(page: Page, browser: Browser, tier: number) {
  await page.goto('about:blank')
  const baselineRss = await rendererRssBytes(browser)
  const image = await page.evaluate(async (size) => {
    const source = document.createElement('canvas')
    source.width = size
    source.height = Math.round((size * 2) / 3)
    const context = source.getContext('2d')
    if (!context) throw new Error('Canvas 2D context is unavailable')
    for (let y = 0; y < 24; y++) {
      context.fillStyle = `hsl(${y * 15} 75% 50%)`
      context.fillRect(
        0,
        (y * source.height) / 24,
        size,
        source.height / 24 + 1
      )
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      source.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error('WebP encoding failed')),
        'image/webp',
        0.7
      )
    )
    return {
      dataUrl: await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('WebP data URL missing'))
        reader.onerror = () =>
          reject(reader.error ?? new Error('WebP read failed'))
        reader.readAsDataURL(blob)
      }),
      encodedBytes: blob.size,
      width: source.width,
      height: source.height,
    }
  }, tier)
  await page.setContent('<main id="canvas"></main>')
  await page.evaluate(
    ({ dataUrl, count }) => {
      const canvas = document.querySelector<HTMLElement>('#canvas')
      if (!canvas) throw new Error('Benchmark canvas is missing')
      Object.assign(canvas.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(8, 140px)',
        gap: '8px',
        transformOrigin: '0 0',
      })
      for (let index = 0; index < count; index++) {
        const image = document.createElement('img')
        image.src = `${dataUrl}#node-${index}`
        image.width = 140
        image.height = 94
        image.decoding = 'async'
        canvas.append(image)
      }
    },
    { dataUrl: image.dataUrl, count: nodeCount }
  )
  await page
    .locator('#canvas img')
    .last()
    .evaluate(async (element) => {
      await Promise.all(
        Array.from(
          document.querySelectorAll<HTMLImageElement>('#canvas img')
        ).map((img) => img.decode())
      )
      if (!(element instanceof HTMLImageElement) || !element.naturalWidth) {
        throw new Error('Decoded image is empty')
      }
    })
  const afterDecodeRss = await rendererRssBytes(browser)
  const zoom = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLElement>('#canvas')
    if (!canvas) throw new Error('Benchmark canvas is missing')
    const frameTimes: number[] = []
    const start = performance.now()
    let frame = 0
    const sample = () => {
      frameTimes.push(performance.now())
      frame++
      canvas.style.transform = `scale(${1 + frame * 0.02})`
      if (frame < 40) requestAnimationFrame(sample)
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        sample()
        const finish = () =>
          frame >= 40 ? resolve() : requestAnimationFrame(finish)
        finish()
      })
    })
    const gaps = frameTimes
      .slice(1)
      .map((time, index) => time - frameTimes[index])
    gaps.sort((left, right) => left - right)
    const percentile = (value: number) =>
      gaps.length
        ? Math.round(
            gaps[Math.min(gaps.length - 1, Math.floor(value * gaps.length))] *
              10
          ) / 10
        : null
    return {
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      frames: frameTimes.length,
      frameGapP50Ms: percentile(0.5),
      frameGapP95Ms: percentile(0.95),
      frameGapMaxMs: Math.round(Math.max(...gaps) * 10) / 10,
    }
  })
  const afterZoomRss = await rendererRssBytes(browser)
  const decodedRgbaBytes = image.width * image.height * 4 * nodeCount
  return {
    tierPx: tier,
    dimensionsPx: `${image.width}x${image.height}`,
    encodedBytesPerNode: image.encodedBytes,
    nominalDecodedRgbaBytes: decodedRgbaBytes,
    rendererRssBaselineBytes: baselineRss,
    rendererRssAfterDecodeBytes: afterDecodeRss,
    rendererRssAfterZoomBytes: afterZoomRss,
    rendererRssDeltaBytes:
      baselineRss === null || afterDecodeRss === null
        ? null
        : afterDecodeRss - baselineRss,
    zoom,
  }
}

async function rendererRssBytes(browser: Browser) {
  if (process.platform !== 'linux') return null
  const cdp = await browser.newBrowserCDPSession()
  const processInfo = (await cdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: Array<{ type: string; id: number }>
  }
  const renderers = processInfo.processInfo.filter(
    ({ type }) => type === 'renderer'
  )
  const readings = await Promise.all(
    renderers.map(async ({ id }) => {
      const status = await readFile(`/proc/${id}/status`, 'utf8').catch(
        () => ''
      )
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
      return rss ? Number(rss[1]) * 1024 : 0
    })
  )
  await cdp.detach()
  return readings.reduce((total, rss) => total + rss, 0)
}
