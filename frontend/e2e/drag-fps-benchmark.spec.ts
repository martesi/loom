import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './test-fixtures'
import {
  assets,
  dropAssetRow,
  imageNodes,
  openFixtureRepo,
} from './test-helpers'

const resultPath = path.resolve(
  import.meta.dirname,
  '../../.cache/e2e/drag-fps.json'
)

test.skip(process.env.LOOM_BENCHMARK !== '1', 'run with LOOM_BENCHMARK=1')
test.setTimeout(300_000)
// Trace snapshots walk the whole DOM per input action, which dwarfs the
// app's own drag cost at 1k nodes. Screenshots/traces stay available via
// the shared artifacts; the frame numbers below must reflect the app.
test.use({ trace: 'off', screenshot: 'off' })

interface PhaseResult {
  phase: string
  moves: number
  dragMs: number
  movedBy: { dx: number; dy: number } | null
  framesInWindow: number
  fps: number | null
  frameGapMs: {
    avg: number
    p50: number | null
    p95: number | null
    max: number
  }
  droppedFramesOver34ms: number
  longtasks: { count: number; totalMs: number; maxMs: number }
  moveRoundTripMs: { avg: number; p50: number | null; p95: number | null }
}

test('sustained node-drag frame rate and cpu profile', async ({ page }) => {
  // Fast by design: drag workflows are scale-independent (correctness is
  // covered at any size), so the default fixture stays small and the run
  // finishes in about a minute. Pass DRAGFPS_PHOTOS=1000 explicitly for an
  // occasional worst-case sample, not for iteration.
  const photoCount = Number(process.env.DRAGFPS_PHOTOS ?? 10)
  const fixture =
    photoCount <= 10 ? 'benchmark-10-fixtures' : 'benchmark-1k-fixtures'
  const expected = photoCount <= 10 ? 10 : 1000

  await openFixtureRepo(page, fixture, {
    drawers: process.env.DRAGFPS_DRAWERS === 'closed' ? 'closed' : 'both',
  })
  // The listbox renders regardless of drawer visibility (the shelf keeps
  // children mounted while closed), and counts do not require visibility.
  await expect(assets(page)).toHaveCount(expected, { timeout: 300_000 })
  await assets(page).first().click()
  await page.keyboard.press('Control+a')
  await dropAssetRow(page, assets(page).first(), { x: 200, y: 160 })
  // Sanity: mass placement landed on the board. With viewport culling only
  // the visible window is mounted, so this asserts a lower bound, not the
  // total (the drop itself throws on backend failure, which is the exact
  // placement guarantee).
  await expect
    .poll(() => imageNodes(page).count(), { timeout: 60_000 })
    .toBeGreaterThan(10)
  // Close the drawers so every raw-mouse grab lands on the canvas.
  // (Memoized panels skip drag frames either way, so this does not change
  // the measured cost.)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('aside[data-visible="true"]')).toHaveCount(0)

  const phases: PhaseResult[] = []
  phases.push(await measurePhase(page, 'single-node-drag', 90))

  if (expected > 10) {
    // Worst case: every node moves, so every memo fails and all nodes
    // re-render per pointermove.
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 100 } })
    await page.keyboard.press('Control+a')
    // Culling-proof: offscreen selected nodes are unmounted, so the selected
    // count is asserted on the dock (data-driven), not the DOM.
    await expect(page.getByTestId('canvas-dock')).toHaveAttribute(
      'data-selection-count',
      String(expected)
    )
    phases.push(await measurePhase(page, 'all-selected-drag', 40))
  }

  const result = { photoCount: expected, phases }
  await mkdir(path.dirname(resultPath), { recursive: true })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`\nDrag FPS\n${JSON.stringify(result, null, 2)}`)
})

async function measurePhase(
  page: Page,
  label: string,
  moves: number
): Promise<PhaseResult> {
  const node = await visibleNode(page)
  const box = await node.boundingBox()
  if (!box) throw new Error('drag node has no bounding box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  const collect = collectFrames(page, 120_000)
  await page.mouse.move(x, y)
  await page.mouse.down()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  const dragStart = await page.evaluate(() => performance.now())
  const moveMs: number[] = []
  for (let i = 1; i <= moves; i++) {
    const moveStart = Date.now()
    await page.mouse.move(x + i * 4, y + i * 2.4)
    moveMs.push(Date.now() - moveStart)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  const dragEnd = await page.evaluate(() => performance.now())
  await page.evaluate(() => {
    ;(
      window as unknown as { __stopCollect?: boolean }
    ).__stopCollect = true
  })
  const endBox = await node.boundingBox()
  const { profile } = (await cdp.send('Profiler.stop')) as {
    profile: {
      nodes: Array<{
        id: number
        callFrame: {
          functionName: string
          url: string
          lineNumber: number
        }
        children?: number[]
      }>
      samples: number[]
      timeDeltas?: number[]
    }
  }
  await cdp.send('Profiler.disable')
  await cdp.detach()
  // Never hang if rAF stalls (headless produces frames on demand): the
  // Node-side timeout always fires, frames are just truncated.
  const { frames, longtasks } = await Promise.race([
    collect,
    page
      .waitForTimeout(15_000)
      .then(() => ({ frames: [] as number[], longtasks: [] as Array<{ start: number; duration: number }> })),
  ])
  moveMs.sort((a, b) => a - b)

  const gaps: Array<{ at: number; gap: number }> = []
  for (let i = 1; i < frames.length; i++)
    gaps.push({ at: frames[i], gap: frames[i] - frames[i - 1] })
  const windowFrames = gaps.filter(
    ({ at }) => at >= dragStart && at <= dragEnd
  )
  const sortedGaps = windowFrames.map(({ gap }) => gap).sort((a, b) => a - b)
  const percentile = (p: number) =>
    sortedGaps.length
      ? sortedGaps[
          Math.min(sortedGaps.length - 1, Math.floor(p * sortedGaps.length))
        ]
      : null
  const spanMs =
    windowFrames.length > 1
      ? windowFrames[windowFrames.length - 1].at - windowFrames[0].at
      : 0
  const windowLongtasks = longtasks.filter(
    (task) => task.start >= dragStart && task.start <= dragEnd
  )
  const cpuprofilePath = path.resolve(
    import.meta.dirname,
    `../../.cache/e2e/drag-${label}.cpuprofile`
  )
  await writeFile(cpuprofilePath, JSON.stringify(profile))

  return {
    phase: label,
    moves,
    dragMs: Math.round((dragEnd - dragStart) * 10) / 10,
    // Did the drag actually move the node? Distinguishes a real node drag
    // from a missed grab (pane marquee), which has a totally different cost.
    movedBy:
      endBox && box
        ? {
            dx: Math.round((endBox.x - box.x) * 10) / 10,
            dy: Math.round((endBox.y - box.y) * 10) / 10,
          }
        : null,
    framesInWindow: windowFrames.length,
    fps:
      windowFrames.length > 1 && spanMs > 0
        ? Math.round(((windowFrames.length - 1) / (spanMs / 1000)) * 10) / 10
        : null,
    frameGapMs: {
      avg:
        Math.round(
          (sortedGaps.reduce((sum, gap) => sum + gap, 0) /
            Math.max(1, sortedGaps.length)) *
            10
        ) / 10,
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: Math.round(Math.max(0, ...sortedGaps) * 10) / 10,
    },
    droppedFramesOver34ms: sortedGaps.filter((gap) => gap > 34).length,
    longtasks: {
      count: windowLongtasks.length,
      totalMs:
        Math.round(
          windowLongtasks.reduce((sum, task) => sum + task.duration, 0) * 10
        ) / 10,
      maxMs:
        Math.round(Math.max(0, ...windowLongtasks.map((t) => t.duration)) * 10) /
        10,
    },
    moveRoundTripMs: {
      avg:
        Math.round(
          (moveMs.reduce((sum, ms) => sum + ms, 0) / Math.max(1, moveMs.length)) *
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
}

async function visibleNode(page: Page) {
  const indexes = await imageNodes(page).evaluateAll((nodes) =>
    nodes.flatMap((node, index) => {
      const rect = node.getBoundingClientRect()
      return rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight
        ? [index]
        : []
    })
  )
  if (indexes.length === 0) throw new Error('No visible Canvas node')
  return imageNodes(page).nth(indexes[Math.floor(indexes.length / 2)])
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
