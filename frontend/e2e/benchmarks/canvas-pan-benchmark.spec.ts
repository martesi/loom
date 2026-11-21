import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../test-fixtures'
import {
  assets,
  dropAssetRow,
  imageNodes,
  openAssetsShelf,
  openFixtureRepo,
} from '../test-helpers'

const resultPath = path.resolve(
  import.meta.dirname,
  '../../../.cache/e2e/pan-fps.json'
)

test.setTimeout(300_000)
// Trace snapshots walk the whole DOM per input action, which dwarfs the
// app's own cost at scale. Screenshots/traces stay available via the
// shared artifacts; the frame numbers below must reflect the app.
test.use({ trace: 'off', screenshot: 'off' })

// Panning is a pure viewport transform: no node state changes, so this
// measures compositor and per-frame viewport-subscriber cost only.
// Fast by design: photo count only sets board size for worst-case runs.
test('zoomed-out canvas pan frame rate', async ({ page }) => {
  const photoCount = Number(process.env.PANFPS_PHOTOS ?? 10)
  const fixture =
    photoCount <= 10 ? 'benchmark-10-fixtures' : 'benchmark-1k-fixtures'
  const expected = photoCount <= 10 ? 10 : 1000

  await openFixtureRepo(page, fixture, { drawers: 'both' })
  // Role queries skip aria-hidden subtrees, so the shelf must be open to
  // count; it is closed again before measuring.
  await openAssetsShelf(page)
  await expect(assets(page)).toHaveCount(expected, { timeout: 300_000 })
  await assets(page).first().click()
  await page.keyboard.press('Control+a')
  await dropAssetRow(page, assets(page).first(), { x: 200, y: 160 })

  // Close the drawers so every raw-mouse grab lands on the canvas.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('aside[data-visible="true"]')).toHaveCount(0)

  // Zoom out to the floor so the pan crosses the whole board (Ctrl+wheel
  // zooms; plain wheel pans since panOnScroll).
  await page.mouse.move(640, 400)
  await page.keyboard.down('Control')
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 500)
  await page.keyboard.up('Control')
  const zoom = await viewportZoom(page)

  const moves = 40
  const collect = collectFrames(page, 60_000)
  await page.mouse.move(640, 400)
  await page.keyboard.down('Space')
  await page.mouse.down()
  const dragStart = await page.evaluate(() => performance.now())
  const moveMs: number[] = []
  for (let i = 1; i <= moves; i++) {
    const moveStart = Date.now()
    await page.mouse.move(640 + i * 12, 400 + i * 3)
    moveMs.push(Date.now() - moveStart)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.keyboard.up('Space')
  const dragEnd = await page.evaluate(() => performance.now())
  await page.evaluate(() => {
    ;(window as unknown as { __stopCollect?: boolean }).__stopCollect = true
  })
  const { frames, longtasks } = await Promise.race([
    collect,
    page.waitForTimeout(15_000).then(() => ({
      frames: [] as number[],
      longtasks: [] as Array<{ start: number; duration: number }>,
    })),
  ])
  moveMs.sort((a, b) => a - b)

  const gaps: Array<{ at: number; gap: number }> = []
  for (let i = 1; i < frames.length; i++)
    gaps.push({ at: frames[i], gap: frames[i] - frames[i - 1] })
  const windowGaps = gaps
    .filter(({ at }) => at >= dragStart && at <= dragEnd)
    .map(({ gap }) => gap)
    .sort((a, b) => a - b)
  const percentile = (p: number) =>
    windowGaps.length
      ? windowGaps[
          Math.min(windowGaps.length - 1, Math.floor(p * windowGaps.length))
        ]
      : null
  const spanMs = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0
  const windowLongtasks = longtasks.filter(
    (task) => task.start >= dragStart && task.start <= dragEnd
  )

  const result = {
    photoCount: expected,
    zoom,
    moves,
    mountedNodes: await imageNodes(page).count(),
    dragMs: Math.round((dragEnd - dragStart) * 10) / 10,
    framesInWindow: windowGaps.length,
    fps:
      windowGaps.length > 1 && spanMs > 0
        ? Math.round(((windowGaps.length - 1) / (spanMs / 1000)) * 10) / 10
        : null,
    frameGapMs: {
      avg:
        Math.round(
          (windowGaps.reduce((sum, gap) => sum + gap, 0) /
            Math.max(1, windowGaps.length)) *
            10
        ) / 10,
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: Math.round(Math.max(0, ...windowGaps) * 10) / 10,
    },
    droppedFramesOver34ms: windowGaps.filter((gap) => gap > 34).length,
    longtasks: {
      count: windowLongtasks.length,
      totalMs:
        Math.round(
          windowLongtasks.reduce((sum, task) => sum + task.duration, 0) * 10
        ) / 10,
      maxMs:
        Math.round(
          Math.max(0, ...windowLongtasks.map((t) => t.duration)) * 10
        ) / 10,
    },
    moveRoundTripMs: {
      avg:
        Math.round(
          (moveMs.reduce((sum, ms) => sum + ms, 0) /
            Math.max(1, moveMs.length)) *
            10
        ) / 10,
      p50: moveMs.length
        ? moveMs[Math.min(moveMs.length - 1, Math.floor(0.5 * moveMs.length))]
        : null,
      p95: moveMs.length
        ? moveMs[Math.min(moveMs.length - 1, Math.floor(0.95 * moveMs.length))]
        : null,
    },
  }

  await mkdir(path.dirname(resultPath), { recursive: true })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`\nPan FPS\n${JSON.stringify(result, null, 2)}`)
})

async function viewportZoom(page: Page): Promise<number | null> {
  return page.locator('.react-flow__viewport').evaluate((viewport) => {
    const match = viewport.getAttribute('style')?.match(/scale\(([\d.]+)/)
    return match ? Number(match[1]) : null
  })
}

function collectFrames(page: Page, durationMs: number) {
  return page.evaluate(
    (ms) =>
      new Promise<{
        frames: number[]
        longtasks: Array<{ start: number; duration: number }>
      }>((resolve) => {
        const t0 = performance.now()
        const frames: number[] = []
        const longtasks: Array<{ start: number; duration: number }> = []
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            longtasks.push({
              start: entry.startTime,
              duration: entry.duration,
            })
        })
        try {
          observer.observe({ entryTypes: ['longtask'] })
        } catch {
          // longtask entries unavailable; frame gaps still reported.
        }
        const tick = () => {
          frames.push(performance.now())
          if (
            (window as unknown as { __stopCollect?: boolean }).__stopCollect ||
            performance.now() - t0 > ms
          ) {
            observer.disconnect()
            resolve({ frames, longtasks })
          } else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    durationMs
  )
}
