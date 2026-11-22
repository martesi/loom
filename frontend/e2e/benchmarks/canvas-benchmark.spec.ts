import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../test-fixtures'
import {
  assets,
  dropAssetRow,
  imageNodes,
  openFixtureRepo,
} from '../test-helpers'

const photoCount = 1000
const resultPath = path.resolve(
  import.meta.dirname,
  '../../../.cache/e2e/benchmark-1k.json'
)

test.skip(process.env.LOOM_BENCHMARK !== '1', 'run with bun run benchmark:1k')
test.setTimeout(600_000)

test('1k-photo Canvas latency and resource benchmark', async ({
  page,
  browser,
}) => {
  await openFixtureRepo(page, 'benchmark-10-fixtures')
  await expect(assets(page)).toHaveCount(10)
  await assets(page).first().click()
  await page.keyboard.press('Control+a')
  await dropAssetRow(page, assets(page).first(), { x: 200, y: 160 })
  await expectTotalNodes(page, 10)
  await expect(imageNodes(page).first()).toBeVisible()
  await page.keyboard.press('Shift+1')
  const baselineInteractions = await measureInteractions(page, 10)

  await openFixtureRepo(page, 'benchmark-1k-fixtures')
  await expect(assets(page)).toHaveCount(photoCount, { timeout: 300_000 })

  await assets(page).first().click()
  await page.keyboard.press('Control+a')
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(
    photoCount
  )

  const placementStarted = performance.now()
  await dropAssetRow(page, assets(page).first(), { x: 200, y: 160 })
  await waitForModelAndMountedNodes(page, photoCount, 120_000)
  const placementMs = performance.now() - placementStarted
  console.log(
    `Model ready plus visible nodes mounted for ${photoCount} photos in ${placementMs.toFixed(1)} ms`
  )
  const placementState = await canvasState(page)

  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000))
  const reloadStarted = performance.now()
  await page.reload()
  await waitForModelAndMountedNodes(page, photoCount, 120_000)
  const reloadRenderMs = performance.now() - reloadStarted
  console.log(
    `Reload model ready plus visible nodes mounted for ${photoCount} photos in ${reloadRenderMs.toFixed(1)} ms`
  )
  const reloadState = await canvasState(page)

  const viewport = page.locator('.react-flow__viewport')
  await page.keyboard.press('ControlOrMeta+0')
  await expect(viewport).toHaveAttribute('style', /scale\(1(?:\.0+)?\)/, {
    timeout: 120_000,
  })
  const beforeFit = await viewport.getAttribute('style')
  const fitStarted = performance.now()
  await page.keyboard.press('Shift+1')
  await expect(viewport).not.toHaveAttribute('style', beforeFit ?? '', {
    timeout: 120_000,
  })
  await waitForModelAndMountedNodes(page, photoCount, 120_000)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const fitMs = performance.now() - fitStarted
  const fitState = await canvasState(page)

  const interactions1000 = await measureInteractions(page, photoCount)
  const baseline = baselineInteractions.inputToPaintMs
  const board1000 = interactions1000.inputToPaintMs
  const interactions = {
    baseline10: baselineInteractions,
    board1000: interactions1000,
    slowdownVsBaseline: {
      pan: rounded(board1000.pan / baseline.pan),
      zoom: rounded(board1000.zoom / baseline.zoom),
      singleNodeDrag: rounded(
        board1000.singleNodeDrag / baseline.singleNodeDrag
      ),
      allSelectedDrag: rounded(
        board1000.allSelectedDrag / baseline.allSelectedDrag
      ),
    },
  }

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  const resources = await page.evaluate(() => {
    const memory = (
      performance as Performance & {
        memory?: {
          usedJSHeapSize: number
          totalJSHeapSize: number
          jsHeapSizeLimit: number
        }
      }
    ).memory
    const entries = performance.getEntriesByType(
      'resource'
    ) as PerformanceResourceTiming[]
    return {
      domElements: document.getElementsByTagName('*').length,
      resourceCount: entries.length,
      transferBytes: entries.reduce(
        (sum, entry) => sum + entry.transferSize,
        0
      ),
      encodedBodyBytes: entries.reduce(
        (sum, entry) => sum + entry.encodedBodySize,
        0
      ),
      usedJSHeapBytes: memory?.usedJSHeapSize ?? null,
      totalJSHeapBytes: memory?.totalJSHeapSize ?? null,
      jsHeapLimitBytes: memory?.jsHeapSizeLimit ?? null,
    }
  })
  await cdp.detach()
  const chromium = await chromiumResources(browser)

  const result = {
    photoCount,
    nodeCounts: {
      placement: placementState,
      reload: reloadState,
      fit: fitState,
    },
    latencyMs: {
      placeModelReadyAndVisibleNodesMounted: Math.round(placementMs * 10) / 10,
      reloadModelReadyAndVisibleNodesMounted:
        Math.round(reloadRenderMs * 10) / 10,
      fit: Math.round(fitMs * 10) / 10,
    },
    interactions,
    resources,
    chromium,
    environment: {
      browser: browser.version(),
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      viewport: page.viewportSize(),
    },
  }

  await mkdir(path.dirname(resultPath), { recursive: true })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`\n1k Canvas benchmark\n${JSON.stringify(result, null, 2)}`)
})

async function measureInteractions(page: Page, selectionSize: number) {
  const pane = page.locator('.react-flow__pane')
  const paneBox = await pane.boundingBox()
  if (!paneBox) throw new Error('Canvas pane has no bounding box')
  const center = {
    x: paneBox.x + paneBox.width / 2,
    y: paneBox.y + paneBox.height / 2,
  }

  const viewport = page.locator('.react-flow__viewport')
  const beforePan = await viewport.getAttribute('style')
  await page.keyboard.down('Space')
  await expect(pane).toHaveClass(/\bdraggable\b/, { timeout: 10_000 })
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  const panPaint = nextInputPaint(page, 'pointermove')
  await page.mouse.move(center.x + 160, center.y + 90)
  const panInputToPaint = await panPaint
  await page.mouse.up()
  await page.keyboard.up('Space')
  await expect(viewport).not.toHaveAttribute('style', beforePan ?? '')

  const beforeZoom = await viewport.getAttribute('style')
  await page.mouse.move(center.x, center.y)
  const zoomPaint = nextInputPaint(page, 'wheel')
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -300)
  await page.keyboard.up('Control')
  const zoomInputToPaint = await zoomPaint
  await expect(viewport).not.toHaveAttribute('style', beforeZoom ?? '')

  await dismissCanvasOverlays(page)
  await page.keyboard.press('Shift+1')
  const node = await visibleNode(page)
  const singleNodeDragInputToPaint = await dragNodeAndMeasure(
    page,
    node,
    40,
    30
  )

  await dismissCanvasOverlays(page)
  const selectionNode = await visibleNode(page)
  await selectionNode.click()
  await page.keyboard.press('Control+a')
  await expect(page.locator('[data-testid="canvas-dock"]')).toHaveAttribute(
    'data-selection-count',
    String(selectionSize)
  )
  const selectedNode = await visibleNode(page)
  const allSelectedDragInputToPaint = await dragNodeAndMeasure(
    page,
    selectedNode,
    40,
    30
  )

  return {
    inputToPaintMs: {
      pan: rounded(panInputToPaint),
      zoom: rounded(zoomInputToPaint),
      singleNodeDrag: rounded(singleNodeDragInputToPaint),
      allSelectedDrag: rounded(allSelectedDragInputToPaint),
    },
    selectionSize,
  }
}

async function dismissCanvasOverlays(page: Page) {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(
    page.locator(
      'aside[data-visible="true"], [role="dialog"]:visible, [role="menu"]:visible, [role="tooltip"]:visible'
    )
  ).toHaveCount(0)
}

async function visibleNode(page: Page) {
  const indexes = await imageNodes(page).evaluateAll((nodes) =>
    nodes.flatMap((node, index) => {
      const rect = node.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const hit = document.elementFromPoint(x, y)
      return rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight &&
        hit !== null &&
        (hit === node || node.contains(hit))
        ? [index]
        : []
    })
  )
  if (indexes.length === 0) throw new Error('No visible Canvas node')
  return imageNodes(page).nth(indexes[Math.floor(indexes.length / 2)])
}

async function expectTotalNodes(page: Page, count: number, timeout = 10_000) {
  await expect(page.locator('.react-flow')).toHaveAttribute(
    'data-total-image-nodes',
    String(count),
    { timeout }
  )
}

async function waitForModelAndMountedNodes(
  page: Page,
  count: number,
  timeout = 10_000
) {
  await expectTotalNodes(page, count, timeout)
  await expect(imageNodes(page).first()).toBeVisible({ timeout: 120_000 })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function canvasState(page: Page) {
  return page.evaluate(() => ({
    totalNodes: Number(
      document
        .querySelector('.react-flow')
        ?.getAttribute('data-total-image-nodes')
    ),
    mountedNodes: document.querySelectorAll('.react-flow__node-image').length,
    viewport:
      document.querySelector('.react-flow__viewport')?.getAttribute('style') ??
      '',
  }))
}

async function dragNodeAndMeasure(
  page: Page,
  node: ReturnType<typeof imageNodes>,
  dx: number,
  dy: number
) {
  const box = await node.boundingBox()
  if (!box) throw new Error('Canvas node has no bounding box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  const paint = nextInputPaint(page, 'pointermove')
  await page.mouse.move(x + dx, y + dy)
  const latency = await paint
  await page.mouse.up()
  return latency
}

function nextInputPaint(page: Page, eventName: 'pointermove' | 'wheel') {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve) => {
        addEventListener(
          name,
          () => {
            const started = performance.now()
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - started))
            )
          },
          { capture: true, once: true }
        )
      }),
    eventName
  )
}

function rounded(value: number) {
  return Math.round(value * 10) / 10
}

async function chromiumResources(browser: Browser) {
  if (process.platform !== 'linux') return null
  const cdp = await browser.newBrowserCDPSession()
  try {
    const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: Array<{ type: string; id: number; cpuTime: number }>
    }
    const processes = await Promise.all(
      processInfo.map(async (process) => ({
        ...process,
        rssBytes: await linuxRssBytes(process.id),
      }))
    )
    const measured = processes.filter(
      (process): process is typeof process & { rssBytes: number } =>
        process.rssBytes !== null
    )
    const renderers = measured.filter((process) => process.type === 'renderer')
    return {
      processCount: measured.length,
      totalRssBytes: measured.reduce(
        (sum, process) => sum + process.rssBytes,
        0
      ),
      browserRssBytes:
        measured.find((process) => process.type === 'browser')?.rssBytes ??
        null,
      rendererRssBytes: renderers.reduce(
        (sum, process) => sum + process.rssBytes,
        0
      ),
      maxRendererRssBytes: Math.max(
        0,
        ...renderers.map((process) => process.rssBytes)
      ),
      cumulativeCpuSeconds: processInfo.reduce(
        (sum, process) => sum + process.cpuTime,
        0
      ),
      rendererCumulativeCpuSeconds: processInfo
        .filter((process) => process.type === 'renderer')
        .reduce((sum, process) => sum + process.cpuTime, 0),
    }
  } finally {
    await cdp.detach()
  }
}

async function linuxRssBytes(pid: number) {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
    return rss ? Number(rss[1]) * 1024 : null
  } catch {
    return null
  }
}
