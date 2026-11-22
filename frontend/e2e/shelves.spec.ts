import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { expect, test } from './test-fixtures'
import {
  asset,
  dropAsset,
  imageNodes,
  openFixtureRepo,
  placeAssets,
} from './test-helpers'

test.describe('floating Canvas drawers', () => {
  test('defers Assets thumbnails until the closed drawer opens', async ({
    page,
  }) => {
    const thumbnailRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/loom-asset/thumb/'))
        thumbnailRequests.push(request.url())
    })

    await openFixtureRepo(page, 'library-fixtures', { drawers: 'closed' })
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-state',
      'closed'
    )
    await page.waitForTimeout(500)
    const closedCount = thumbnailRequests.length
    expect(closedCount).toBe(0)

    await page.getByTestId('toggle-assets-shelf').click()
    await expect(page.locator('aside[aria-label="Assets"]')).toHaveAttribute(
      'data-state',
      'open'
    )
    await expect.poll(() => thumbnailRequests.length).toBeGreaterThan(0)
  })

  test('clips overflowing content at both bottom corners of Assets and Inspector', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1)
    await openFixtureRepo(page, 'shelves-fixtures')
    const artifacts = path.resolve(
      import.meta.dirname,
      '../../.cache/e2e/artifacts'
    )
    await mkdir(artifacts, { recursive: true })
    for (const name of ['Assets', 'Inspector']) {
      const shelf = page.locator(`aside[aria-label="${name}"]`)
      await expect(shelf).toHaveAttribute('data-visible', 'true')
      const content = shelf.locator(':scope > div').nth(1)
      await content.evaluate((element) => {
        element.style.background = 'rgb(255, 0, 255)'
        const overflow = document.createElement('div')
        overflow.style.cssText =
          'height:1400px;min-height:1400px;background:rgb(255,0,255);flex:none'
        element.append(overflow)
      })
      const screenshot = await shelf.screenshot({
        animations: 'disabled',
        scale: 'css',
      })
      const imagePath = path.join(
        artifacts,
        `${name.toLowerCase()}-bottom-corners.png`
      )
      await writeFile(imagePath, screenshot)
      const pixels = decodePng(screenshot)
      const magenta = (x: number, y: number) => {
        const i = (y * pixels.width + x) * 4
        return (
          pixels.rgba[i] === 255 &&
          pixels.rgba[i + 1] === 0 &&
          pixels.rgba[i + 2] === 255
        )
      }
      expect(
        magenta(Math.floor(pixels.width / 2), pixels.height - 2),
        `${name} overflow must reach the bottom edge`
      ).toBe(true)
      expect(
        magenta(2, pixels.height - 2),
        `${name} bottom-left corner must be clipped; see ${imagePath}`
      ).toBe(false)
      expect(
        magenta(pixels.width - 3, pixels.height - 2),
        `${name} bottom-right corner must be clipped; see ${imagePath}`
      ).toBe(false)
    }
  })

  test('icon-only floating controls show framework tooltips with separate shortcut keys', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'shelves-fixtures', { drawers: 'closed' })
    await page.getByTestId('open-command-palette').hover()

    const tooltip = page.getByTestId('base-tooltip-popup')
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toContainText('Show commands')
    const keys = tooltip.locator('[data-slot="kbd"]')
    await expect(keys).toHaveCount(2)
    await expect(keys.nth(0)).toHaveText('Ctrl')
    await expect(keys.nth(1)).toHaveText('K')
  })

  test('starts closed and never changes the full-viewport Canvas bounds', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'shelves-fixtures', { drawers: 'closed' })

    const canvas = page.getByRole('main', { name: 'Canvas' })
    const assets = page.locator('aside[aria-label="Assets"]')
    const inspector = page.locator('aside[aria-label="Inspector"]')
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(inspector).toHaveAttribute('data-state', 'closed')
    const assetsToggle = page.getByTestId('toggle-assets-shelf')
    const inspectorToggle = page.getByTestId('toggle-inspector-shelf')
    await expect(assetsToggle).toBeVisible()
    await expect(inspectorToggle).toBeVisible()
    await expect(page.getByTestId('shelf-edge-trigger-left')).toHaveCount(0)
    await expect(page.getByTestId('shelf-edge-trigger-right')).toHaveCount(0)

    const originalBounds = await canvas.boundingBox()
    expect(originalBounds).toMatchObject({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    })
    await assetsToggle.click()
    await expect(assets).toHaveAttribute('data-state', 'open')
    await inspectorToggle.click()
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(assetsToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(assets).toHaveAttribute('data-visible', 'true')

    const resizedBounds = await canvas.boundingBox()
    expect(resizedBounds).toEqual(originalBounds)
    await page.getByTestId('shelf-resize-handle-left').focus()
    await page.keyboard.press('End')
    await expect(page.getByTestId('shelf-resize-handle-left')).toHaveAttribute(
      'aria-valuenow',
      '480'
    )
    expect(await canvas.boundingBox()).toEqual(originalBounds)
  })

  test('supports top-island, shortcut, pin, and successful-drop auto-hide paths', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    const assets = page.locator('aside[aria-label="Assets"]')

    await page.getByTestId('toggle-assets-shelf').click()
    await expect(assets).toHaveAttribute('data-state', 'open')
    await page.keyboard.press('ControlOrMeta+b')
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await page.keyboard.press('ControlOrMeta+b')
    await expect(assets).toHaveAttribute('data-state', 'open')

    const pin = page.getByTestId('pin-shelf-left')
    await pin.hover()
    await expect(page.getByTestId('base-tooltip-popup')).toHaveText(
      'Pin Assets drawer'
    )
    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.move(0, 0)
    await pin.hover()
    await expect(page.getByTestId('base-tooltip-popup')).toHaveText(
      'Unpin Assets drawer'
    )
    await dropAsset(page, 'dock-alpha.png', { x: 420, y: 180 })
    await expect(assets).toHaveAttribute('data-state', 'open')
    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    await dropAsset(page, 'dock-beta.png', { x: 640, y: 180 })
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(page.getByRole('main', { name: 'Canvas' })).toBeFocused()
  })

  test('Escape closes an unpinned drawer while focus is in its search field', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'library-fixtures', { drawers: 'assets' })
    const assets = page.locator('aside[aria-label="Assets"]')
    const search = page.getByRole('textbox', { name: 'Search assets' })
    const trigger = page.getByTestId('toggle-assets-shelf')

    await search.focus()
    await expect(search).toBeFocused()
    await page.keyboard.press('Escape')

    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await expect(assets).toHaveAttribute('data-state', 'open')
    await page.getByTestId('collapse-shelf-left').click()
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(trigger).toBeFocused()
  })

  test('Escape closes palette and menus before an unpinned drawer', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'library-fixtures', { drawers: 'assets' })
    const assets = page.locator('aside[aria-label="Assets"]')

    await asset(page, 'root-alpha.png').click()
    await page.keyboard.press('Shift+Delete')
    const purgeDialog = page.getByRole('dialog', {
      name: 'Permanently delete 1 asset?',
    })
    await expect(purgeDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(purgeDialog).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await page.getByTestId('toggle-assets-shelf').focus()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await page.getByTestId('repository-actions').click()
    await expect(
      page.getByRole('menu', { name: 'Repository actions' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('menu', { name: 'Repository actions' })
    ).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await asset(page, 'root-alpha.png').click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(assets).toHaveAttribute('data-state', 'open')

    await page.keyboard.press('Escape')
    await expect(assets).toHaveAttribute('data-state', 'closed')
  })

  test('unpinned Inspector follows the active selection and auto-hides when it clears', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFixtureRepo(page, 'dock-fixtures', { drawers: 'closed' })
    const inspector = page.locator('aside[aria-label="Inspector"]')

    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(inspector.getByText('No Selection')).toBeVisible()
    await expect(
      inspector.getByText('Select all on active surface')
    ).toBeVisible()
    await expect(inspector.getByText('Search assets in palette')).toBeVisible()
    await page.getByTestId('toggle-inspector-shelf').click()

    await placeAssets(page, ['dock-alpha.png', 'dock-beta.png'])
    await imageNodes(page).nth(0).click()
    await page.keyboard.press('ControlOrMeta+i')
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('aside')?.getAttribute('aria-label')
        )
      )
      .toBe('Inspector')
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toBeVisible()
    await imageNodes(page).nth(1).click()
    await expect(
      inspector.getByText('dock-beta.png', { exact: true })
    ).toBeVisible()
    await expect(
      inspector.getByText('dock-alpha.png', { exact: true })
    ).toHaveCount(0)
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 700, y: 460 } })
    await expect(inspector).toHaveAttribute('data-state', 'closed')
    await expect(page.getByRole('main', { name: 'Canvas' })).toBeFocused()

    await page.getByTestId('toggle-inspector-shelf').click()
    await page.getByTestId('pin-shelf-right').click()
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 700, y: 460 } })
    await expect(inspector).toHaveAttribute('data-state', 'open')
    await expect(inspector.getByText('No Selection')).toBeVisible()
  })

  test('keeps closed drawer controls out of keyboard focus and remains usable on narrow screens', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await openFixtureRepo(page, 'responsive-fixtures', { drawers: 'closed' })
    const canvas = page.getByRole('main', { name: 'Canvas' })
    const assets = page.locator('aside[aria-label="Assets"]')

    await expect(assets).toHaveAttribute('inert', '')
    await page.getByTestId('toggle-assets-shelf').click()
    await expect(assets).toHaveAttribute('data-visible', 'true')
    await expect(assets).toHaveCSS('position', 'absolute')
    await expect
      .poll(async () => (await assets.boundingBox())?.width ?? 0)
      .toBeLessThanOrEqual(366)
    const fullBounds = await canvas.boundingBox()
    expect(fullBounds?.width).toBe(390)

    await page.getByTestId('toggle-inspector-shelf').click()
    await expect(assets).toHaveAttribute('data-state', 'closed')
    await expect(page.locator('aside[aria-label="Inspector"]')).toHaveAttribute(
      'data-state',
      'open'
    )
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('aside')?.getAttribute('aria-label')
        )
      )
      .toBe('Inspector')
    expect((await canvas.boundingBox())?.width).toBe(390)

    await page.getByTestId('toggle-assets-shelf').click()
    await expect(page.locator('aside[aria-label="Inspector"]')).toHaveAttribute(
      'data-state',
      'closed'
    )
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest('aside')?.getAttribute('aria-label')
        )
      )
      .toBe('Assets')
  })
})

function decodePng(buffer: Buffer) {
  let width = 0
  let height = 0
  let colorType = 0
  const compressed: Buffer[] = []
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') compressed.push(data)
    offset += length + 12
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels)
    throw new Error(`Unsupported screenshot PNG color type ${colorType}`)
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(compressed))
  const decoded = Buffer.alloc(height * stride)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + x + 1]
      const left = x >= channels ? decoded[y * stride + x - channels] : 0
      const above = y ? decoded[(y - 1) * stride + x] : 0
      const upperLeft =
        y && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0
      decoded[y * stride + x] =
        (value +
          (filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paeth(left, above, upperLeft)
                  : 0)) &
        255
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = decoded[i * channels]
    rgba[i * 4 + 1] = decoded[i * channels + 1]
    rgba[i * 4 + 2] = decoded[i * channels + 2]
    rgba[i * 4 + 3] = channels === 4 ? decoded[i * channels + 3] : 255
  }
  return { width, height, rgba }
}
