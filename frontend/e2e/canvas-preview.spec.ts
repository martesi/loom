import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { previewTierForNode } from '../src/lib/preview-tier'
import { expect, test } from './test-fixtures'
import {
  dropAsset,
  fixturePath,
  imageNodes,
  openFixtureRepo,
} from './test-helpers'

// These browser-visible layer transitions use Chromium's image loading and
// compositing behavior. Firefox and WebKit projects are not configured.
test.describe('Canvas progressive previews', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only')

  test('keeps the thumbnail visible until the tiered preview loads', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    let releaseBody!: () => void
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve
    })
    let responseStarted!: () => void
    const partialResponseWritten = new Promise<void>((resolve) => {
      responseStarted = resolve
    })
    const previewServer = createServer(async (_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': pngBytes.length,
        'Cache-Control': 'no-store',
      })
      response.write(pngBytes.subarray(0, 30))
      responseStarted()
      await bodyGate
      response.end(pngBytes.subarray(30))
    })
    await new Promise<void>((resolve) =>
      previewServer.listen(0, '127.0.0.1', resolve)
    )
    const address = previewServer.address()
    if (!address || typeof address === 'string')
      throw new Error('Preview stream server did not bind')
    let requested!: (url: URL) => void
    const requestSeen = new Promise<URL>((resolve) => {
      requested = resolve
    })
    await page.route('**/loom-asset/preview/**', async (route) => {
      requested(new URL(route.request().url()))
      await route.continue({
        url: `http://127.0.0.1:${address.port}/preview.png`,
      })
    })
    try {
      await openFixtureRepo(page, 'preview-fixtures', { drawers: 'closed' })
      await dropAsset(page, 'preview-alpha.png', { x: 500, y: 300 })
      const node = imageNodes(page).first()
      await expect(node).toBeVisible()
      const thumb = node.locator('img').first()
      await expect(thumb).toHaveJSProperty('complete', true)
      const thumbUrl = new URL((await thumb.getAttribute('src'))!, page.url())
      expect(thumbUrl.searchParams.get('v')).toBeTruthy()
      const box = await node.boundingBox()
      if (!box) throw new Error('Canvas node has no bounds')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -900)
      await page.keyboard.up('Control')
      const url = await requestSeen
      expect(url.searchParams.get('v')).toBe(thumbUrl.searchParams.get('v'))
      const tier = Number(url.searchParams.get('w'))
      const expected = await node.evaluate((element) => {
        const image = element.querySelector('img')!
        const bounds = element.getBoundingClientRect()
        const viewport = document.querySelector('.react-flow__viewport')!
        const transform = new DOMMatrix(getComputedStyle(viewport).transform)
        return {
          width: bounds.width / transform.a,
          height: bounds.height / transform.d,
          sourceWidth: image.naturalWidth,
          sourceHeight: image.naturalHeight,
          zoom: transform.a,
          dpr: window.devicePixelRatio,
        }
      })
      expect(tier).toBe(
        previewTierForNode(
          expected.width,
          expected.height,
          2400,
          1200,
          expected.zoom,
          expected.dpr
        )
      )
      await partialResponseWritten
      const pending = node.getByTestId('image-node-preview')
      await expect(pending).toBeVisible()
      await expect(pending).toHaveCSS('opacity', '0')
      await expect(thumb).toBeVisible()
      const effectiveOpacity = await thumb.evaluate((image) => {
        let opacity = 1
        for (
          let element: HTMLElement | null = image as HTMLElement;
          element;
          element = element.parentElement
        ) {
          opacity *= Number.parseFloat(getComputedStyle(element).opacity)
        }
        return opacity
      })
      expect(effectiveOpacity).toBeGreaterThan(0)
      releaseBody()
      const loaded = node.getByTestId('image-node-preview-loaded')
      await expect(loaded).toBeVisible()
      await expect(loaded).toHaveCSS('opacity', '1')
      await expect(loaded).toHaveJSProperty('complete', true)
      await expect
        .poll(() =>
          loaded.evaluate((image: HTMLImageElement) => ({
            width: image.naturalWidth,
            height: image.naturalHeight,
          }))
        )
        .toEqual({ width: 1, height: 1 })
      const loadedSrc = await loaded.getAttribute('src')
      if (!loadedSrc) throw new Error('Decoded preview has no source URL')
      const loadedUrl = new URL(loadedSrc, page.url())
      expect(loadedUrl.searchParams.get('v')).toBe(url.searchParams.get('v'))
      expect(loadedUrl.searchParams.get('w')).toBe(url.searchParams.get('w'))
    } finally {
      releaseBody()
      await page.unroute('**/loom-asset/preview/**')
      await new Promise<void>((resolve) => previewServer.close(() => resolve()))
    }
  })

  test('retries a 503 and ignores an older preview that finishes after the latest tier', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    let failedUrl: URL | undefined
    let retryUrl: URL | undefined
    let initialFailure = true
    let retryCount = 0
    let retrySucceeded!: () => void
    const retrySuccess = new Promise<void>((resolve) => {
      retrySucceeded = resolve
    })
    let releaseRetry!: () => void
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve
    })
    type HeldResponse = {
      url: URL
      release: () => void
      fulfilled: Promise<void>
    }
    const heldResponses: HeldResponse[] = []
    let heldSeen!: (entry: HeldResponse) => void
    let heldRequested = new Promise<HeldResponse>((resolve) => {
      heldSeen = resolve
    })
    await page.route('**/loom-asset/preview/**', async (route) => {
      const url = new URL(route.request().url())
      if (initialFailure) {
        initialFailure = false
        failedUrl = url
        await route.fulfill({ status: 503, body: 'preview unavailable' })
        return
      }
      if (url.searchParams.has('retry')) {
        retryCount++
        retryUrl = url
        await retryGate
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: pngBytes,
        })
        retrySucceeded()
        return
      }
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let markFulfilled!: () => void
      const fulfilled = new Promise<void>((resolve) => {
        markFulfilled = resolve
      })
      const entry = { url, release, fulfilled }
      heldResponses.push(entry)
      heldSeen(entry)
      heldRequested = new Promise((resolve) => {
        heldSeen = resolve
      })
      await gate
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: pngBytes,
      })
      markFulfilled()
    })
    try {
      await openFixtureRepo(page, 'preview-fixtures', { drawers: 'closed' })
      await dropAsset(page, 'preview-alpha.png', { x: 500, y: 300 })
      const node = imageNodes(page).first()
      const thumb = node.locator('img').first()
      const box = await node.boundingBox()
      if (!box) throw new Error('Canvas node has no bounds')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -900)
      await page.keyboard.up('Control')
      await expect.poll(() => retryCount).toBe(1)
      expect(retryUrl?.searchParams.get('retry')).toBe('1')
      expect(retryUrl?.searchParams.get('v')).toBeTruthy()
      expect(retryUrl?.searchParams.get('v')).toBe(
        failedUrl?.searchParams.get('v')
      )
      await expect(thumb).toBeVisible()
      const pending = node.getByTestId('image-node-preview')
      await expect(pending).toBeVisible()
      await expect(pending).toHaveCSS('opacity', '0')
      releaseRetry()
      await retrySuccess
      const retryLoaded = node.getByTestId('image-node-preview-loaded')
      await expect(retryLoaded).toBeVisible()
      await expect
        .poll(() =>
          retryLoaded.evaluate((image: HTMLImageElement) => ({
            width: image.naturalWidth,
            height: image.naturalHeight,
          }))
        )
        .toEqual({ width: 1, height: 1 })
      const retryLoadedSrc = await retryLoaded.getAttribute('src')
      if (!retryLoadedSrc) throw new Error('Retry preview has no source URL')
      const retryLoadedUrl = new URL(retryLoadedSrc, page.url())
      expect(retryLoadedUrl.searchParams.get('retry')).toBe('1')
      expect(retryLoadedUrl.searchParams.get('v')).toBe(
        retryUrl?.searchParams.get('v')
      )
      expect(retryCount).toBe(1)

      const wheel = async (delta: number) => {
        const current = await node.boundingBox()
        if (!current) throw new Error('Canvas node has no bounds')
        await page.mouse.move(
          current.x + current.width / 2,
          current.y + current.height / 2
        )
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, delta)
        await page.keyboard.up('Control')
      }
      const olderRequested = heldRequested
      await wheel(300)
      const older = await olderRequested
      let latest: HeldResponse | undefined
      for (let attempt = 0; attempt < 8; attempt++) {
        const nextRequested = heldRequested
        await wheel(-300)
        const response = await Promise.race([
          nextRequested,
          page.waitForTimeout(250).then(() => undefined),
        ])
        if (response) latest = response
        if (
          latest &&
          latest.url.searchParams.get('w') !== older.url.searchParams.get('w') &&
          latest.url.searchParams.get('w') !== retryUrl?.searchParams.get('w')
        ) {
          break
        }
      }
      if (!latest)
        throw new Error('Canvas zoom did not request a latest preview tier')
      if (latest.url.searchParams.get('w') === retryUrl?.searchParams.get('w')) {
        latest.release()
        await latest.fulfilled
        await page.setViewportSize({ width: 1600, height: 1000 })
        const resizeHandle = node.locator(
          '.react-flow__resize-control.handle.bottom.right'
        )
        await expect(resizeHandle).toBeVisible()
        const handleBounds = await resizeHandle.boundingBox()
        if (!handleBounds) throw new Error('Canvas resize handle has no bounds')
        const resizedRequest = heldRequested
        await page.mouse.move(
          handleBounds.x + handleBounds.width / 2,
          handleBounds.y + handleBounds.height / 2
        )
        await page.mouse.down()
        await page.mouse.move(
          handleBounds.x + handleBounds.width / 2 + 240,
          handleBounds.y + handleBounds.height / 2 + 240
        )
        await page.mouse.up()
        latest = await resizedRequest
      }
      expect(latest.url.searchParams.get('w')).not.toBe(
        older.url.searchParams.get('w')
      )
      expect(latest.url.searchParams.get('w')).not.toBe(
        retryUrl?.searchParams.get('w')
      )
      expect(latest.url.searchParams.has('retry')).toBe(false)
      latest.release()
      const loaded = node.getByTestId('image-node-preview-loaded')
      await expect(loaded).toBeVisible()
      const loadedUrl = async () => {
        const src = await loaded.getAttribute('src')
        return src ? new URL(src, page.url()) : null
      }
      await expect
        .poll(async () => (await loadedUrl())?.href)
        .toBe(latest.url.href)
      const latestLoadedUrl = await loadedUrl()
      if (!latestLoadedUrl) throw new Error('Latest preview has no source URL')
      expect(latestLoadedUrl.href).toBe(latest.url.href)
      expect(latestLoadedUrl.searchParams.has('retry')).toBe(false)
      await expect
        .poll(() =>
          loaded.evaluate((image: HTMLImageElement) => ({
            width: image.naturalWidth,
            height: image.naturalHeight,
          }))
        )
        .toEqual({ width: 1, height: 1 })
      older.release()
      await older.fulfilled
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      await expect
        .poll(async () => (await loadedUrl())?.href)
        .toBe(latest.url.href)
      const finalLoadedUrl = await loadedUrl()
      if (!finalLoadedUrl) throw new Error('Final preview has no source URL')
      expect(finalLoadedUrl.href).toBe(latest.url.href)
      expect(finalLoadedUrl.searchParams.has('retry')).toBe(false)
      await expect
        .poll(() =>
          loaded.evaluate((image: HTMLImageElement) => ({
            width: image.naturalWidth,
            height: image.naturalHeight,
          }))
        )
        .toEqual({ width: 1, height: 1 })
    } finally {
      releaseRetry()
      for (const held of heldResponses) held.release()
      await page.unroute('**/loom-asset/preview/**')
    }
  })

  test('video canvas nodes use revisioned tier 320 only', async ({ page }) => {
    const videoPath = await fixturePath('preview-fixtures', 'video-rendition-check.mp4')
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
    ])
    let previewRequests = 0
    await page.route('**/loom-asset/preview/**', async (route) => {
      previewRequests++
      await route.fulfill({ status: 400, body: 'video previews are limited to 320' })
    })
    try {
      await openFixtureRepo(page, 'preview-fixtures', { drawers: 'closed' })
      await dropAsset(page, 'video-rendition-check.mp4', { x: 500, y: 300 })
      const node = imageNodes(page).first()
      await expect(node).toBeVisible()
      const thumb = node.locator('img').first()
      await expect(thumb).toHaveJSProperty('complete', true)
      await expect
        .poll(() => thumb.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0)
      await expect(thumb).toHaveAttribute('src', /\?v=[^&]+$/)
      const box = await node.boundingBox()
      if (!box) throw new Error('Canvas node has no bounds')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -1200)
      await page.keyboard.up('Control')
      await page.waitForTimeout(500)
      expect(previewRequests).toBe(0)
    } finally {
      await page.unroute('**/loom-asset/preview/**')
      await rm(videoPath, { force: true })
    }
  })
})

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
