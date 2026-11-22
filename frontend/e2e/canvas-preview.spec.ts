import { previewTierForNode } from '../src/lib/preview-tier'
import { expect, test } from './test-fixtures'
import { dropAsset, imageNodes, openFixtureRepo } from './test-helpers'

// These browser-visible layer transitions use Chromium's image loading and
// compositing behavior. Firefox and WebKit projects are not configured.
test.describe('Canvas progressive previews', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only')

  test('keeps the thumbnail visible until the tiered preview loads', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let requested!: (url: URL) => void
    const requestSeen = new Promise<URL>((resolve) => {
      requested = resolve
    })
    await page.route('**/loom-asset/preview/**', async (route) => {
      requested(new URL(route.request().url()))
      await held
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: pngBytes,
      })
    })
    try {
      await openFixtureRepo(page, 'preview-fixtures', { drawers: 'closed' })
      await dropAsset(page, 'preview-alpha.png', { x: 500, y: 300 })
      const node = imageNodes(page).first()
      await expect(node).toBeVisible()
      const thumb = node.locator('img').first()
      await expect(thumb).toHaveJSProperty('complete', true)
      const box = await node.boundingBox()
      if (!box) throw new Error('Canvas node has no bounds')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -900)
      await page.keyboard.up('Control')
      const url = await requestSeen
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
      const pending = node.getByTestId('image-node-preview')
      await expect(pending).toBeVisible()
      await expect(pending).toHaveCSS('opacity', '0')
      await expect(thumb).toBeVisible()
      release()
      const loaded = node.getByTestId('image-node-preview-loaded')
      await expect(loaded).toBeVisible()
      await expect(loaded).toHaveCSS('opacity', '1')
      await expect(loaded).toHaveJSProperty('complete', true)
      await expect
        .poll(() =>
          loaded.evaluate((image: HTMLImageElement) => image.naturalWidth)
        )
        .toBeGreaterThan(0)
      await expect
        .poll(() =>
          loaded.evaluate((image: HTMLImageElement) => image.naturalHeight)
        )
        .toBeGreaterThan(0)
    } finally {
      release()
      await page.unroute('**/loom-asset/preview/**')
    }
  })

  test('retries a 503 and ignores an older preview that finishes after the latest tier', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
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
    const heldResponses: Array<{ url: URL; release: () => void }> = []
    let heldSeen!: (entry: { url: URL; release: () => void }) => void
    let heldRequested = new Promise<{ url: URL; release: () => void }>(
      (resolve) => {
        heldSeen = resolve
      }
    )
    await page.route('**/loom-asset/preview/**', async (route) => {
      const url = new URL(route.request().url())
      if (initialFailure) {
        initialFailure = false
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
      const entry = { url, release }
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
      await expect(thumb).toBeVisible()
      const pending = node.getByTestId('image-node-preview')
      await expect(pending).toBeVisible()
      await expect(pending).toHaveCSS('opacity', '0')
      releaseRetry()
      await retrySuccess
      await expect(node.getByTestId('image-node-preview-loaded')).toBeVisible()
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
      const latestRequested = heldRequested
      await wheel(-300)
      let latest = await latestRequested
      if (
        latest.url.searchParams.get('w') === older.url.searchParams.get('w')
      ) {
        const nextRequested = heldRequested
        await wheel(-300)
        latest = await nextRequested
      }
      expect(latest.url.searchParams.get('w')).not.toBe(
        older.url.searchParams.get('w')
      )
      latest.release()
      const loaded = node.getByTestId('image-node-preview-loaded')
      await expect(loaded).toHaveAttribute(
        'src',
        new RegExp(`w=${latest.url.searchParams.get('w')}`)
      )
      older.release()
      await expect(loaded).toHaveAttribute(
        'src',
        new RegExp(`w=${latest.url.searchParams.get('w')}`)
      )
    } finally {
      releaseRetry()
      for (const held of heldResponses) held.release()
      await page.unroute('**/loom-asset/preview/**')
    }
  })
})

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
