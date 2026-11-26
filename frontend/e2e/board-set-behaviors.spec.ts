import type { Locator, Page } from '@playwright/test'
import { runtimeMethodID } from './bindings'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  asset,
  autoArrangeCanvas,
  fixturePath,
  imageNodes,
  nodeBox,
  openAssetsShelf,
  openFixtureRepo,
  placeAssets,
} from './test-helpers'

async function dragBy(page: Page, locator: Locator, dx: number, dy: number) {
  const box = await nodeBox(locator)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 8 }
  )
  await page.mouse.up()
}

test('node resize and movement persist while Space drag pans instead of moving nodes', async ({
  page,
}) => {
  await openFixtureRepo(page, 'resize-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  await placeAssets(page, ['resize-alpha.png'])
  const node = imageNodes(page).first()
  await node.click()

  const beforeResize = await nodeBox(node)
  const handle = page.locator('.react-flow__resize-control.handle').last()
  await expect(handle).toBeVisible()
  await dragBy(page, handle, 60, 40)
  await expect
    .poll(async () => (await nodeBox(node)).width)
    .toBeGreaterThan(beforeResize.width + 30)
  const resized = await nodeBox(node)

  await dragBy(page, node, 100, 60)
  const moved = await nodeBox(node)
  expect(moved.x).toBeGreaterThan(resized.x + 50)

  await page.reload()
  await page.getByTestId('canvas-mode-edit').click()
  const restored = imageNodes(page).first()
  await expect(restored).toBeVisible()
  const restoredBox = await nodeBox(restored)
  expect(Math.abs(restoredBox.width - resized.width)).toBeLessThan(5)
  expect(Math.abs(restoredBox.x - moved.x)).toBeLessThan(15)

  await restored.click()
  const nodeTransform = await restored.evaluate(
    (element) => (element as HTMLElement).style.transform
  )
  const viewport = page.locator('.react-flow__viewport')
  const viewportTransform = await viewport.getAttribute('style')
  await page.keyboard.down('Space')
  await dragBy(page, restored, 120, 60)
  await page.keyboard.up('Space')
  await expect
    .poll(() =>
      restored.evaluate((element) => (element as HTMLElement).style.transform)
    )
    .toBe(nodeTransform)
  await expect(viewport).not.toHaveAttribute('style', viewportTransform ?? '')
})

test('text-input undo does not undo canvas changes', async ({ page }) => {
  await openFixtureRepo(page, 'shortcut-fixtures')
  await page.getByTestId('canvas-mode-edit').click()
  await placeAssets(page, ['shortcut-alpha.png', 'shortcut-beta.png'])
  await autoArrangeCanvas(page)
  const positions = () =>
    imageNodes(page).evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).style.transform)
    )
  const arranged = await positions()
  await openAssetsShelf(page)
  const search = page.getByRole('textbox', { name: 'Search assets' })
  await search.pressSequentially('shortcut')
  await search.press('ControlOrMeta+z')
  await expect(search).not.toHaveValue('shortcut')
  await expect(imageNodes(page)).toHaveCount(2)
  expect(await positions()).toEqual(arranged)
  await page.reload()
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(2)
})

test('file drop and canvas clipboard paste create placed assets and errors are dismissible', async ({
  page,
  context,
  clipboardAccess,
}) => {
  void clipboardAccess
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixtureRepo(page, 'media-fixtures')
  await page.getByTestId('canvas-mode-edit').click()

  await page.evaluate(() => {
    const encoded =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    const canvas = document.querySelector<HTMLElement>(
      'main[aria-label="Canvas"]'
    )
    if (!canvas) throw new Error('Canvas not found')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })
    )
  })

  await expect(asset(page, 'dropped.png')).toBeVisible()
  const mediaId = await asset(page, 'media-alpha.png').getAttribute(
    'data-asset-id'
  )
  const droppedId = await asset(page, 'dropped.png').getAttribute(
    'data-asset-id'
  )
  if (!mediaId || !droppedId)
    throw new Error('Missing fixture or drop asset ID')
  await expect(imageNodes(page)).toHaveCount(2)
  await expect
    .poll(() =>
      imageNodes(page).evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-id')).sort()
      )
    )
    .toEqual([mediaId, droppedId].sort())

  await page.locator(`.react-flow__node[data-id="${droppedId}"]`).click()
  await page.evaluate(async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [{ name: 'canvas-paste.png', data }],
      })
    )
  })
  await page.keyboard.press('Control+v')
  await expect(imageNodes(page)).toHaveCount(3)

  const sourceAsset = asset(page, 'media-alpha.png')
  await sourceAsset.click()
  await expect(sourceAsset).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+Shift+c')
  // Copy-converted has no converter in this build. It must report that and
  // leave the existing clipboard payload intact so the next paste still works.
  const convertedError = page.getByRole('alert')
  await expect(convertedError).toContainText(
    'Converted copy is unavailable. No converter is installed.'
  )
  await convertedError.getByRole('button', { name: 'Dismiss' }).click()
  await expect(convertedError).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('canvas-paste.png')
  await page.keyboard.press('Control+v')
  await expect(asset(page, 'canvas-paste.png')).toBeVisible()
  const pasteId = await asset(page, 'canvas-paste.png').getAttribute(
    'data-asset-id'
  )
  await expect(imageNodes(page)).toHaveCount(4)
  await expect
    .poll(() =>
      imageNodes(page).evaluateAll(
        (nodes, id) =>
          nodes.some((node) => node.getAttribute('data-id') === id),
        pasteId
      )
    )
    .toBe(true)

  const importID = runtimeMethodID('imageservice.ts', 'ImportMedia')
  const importRequests: string[] = []
  const recordImport = (request: import('@playwright/test').Request) => {
    const body = request.postData()
    if (body?.includes(`"methodID":${importID}`)) importRequests.push(body)
  }
  page.on('request', recordImport)
  const repoPath = await fixturePath('media-fixtures')
  const beforeInvalid = await legacyServiceCall<{
    images?: {
      id: number
      placed: boolean
      canvasX: number
      canvasY: number
      canvasW: number
      canvasH: number
    }[]
  }>(page, 'imageservice.ts', 'LoadCanvas', [repoPath])
  await page.evaluate(() => navigator.clipboard.writeText('not Loom media'))
  await page.keyboard.press('Control+v')
  const pasteError = page.getByRole('alert')
  await expect(pasteError).toContainText('Clipboard contains no media files')
  await expect(imageNodes(page)).toHaveCount(4)
  expect(importRequests).toHaveLength(0)
  const afterInvalid = await legacyServiceCall<{
    images?: {
      id: number
      placed: boolean
      canvasX: number
      canvasY: number
      canvasW: number
      canvasH: number
    }[]
  }>(page, 'imageservice.ts', 'LoadCanvas', [repoPath])
  expect(afterInvalid.images).toEqual(beforeInvalid.images)
  await pasteError.getByRole('button', { name: 'Dismiss' }).click()
  await expect(pasteError).toHaveCount(0)
  page.off('request', recordImport)

  await page.getByTestId('canvas-mode-view').click()
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.evaluate(async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [{ name: 'view-paste.png', data }],
      })
    )
  })
  await page.keyboard.press('Control+v')
  await expect(asset(page, 'view-paste.png')).toBeVisible()
  const viewPasteId = await asset(page, 'view-paste.png').getAttribute(
    'data-asset-id'
  )
  if (!viewPasteId) throw new Error('View paste did not create an asset ID')
  await expect(
    page.locator(`.react-flow__node[data-id="${viewPasteId}"]`)
  ).toHaveCount(0)
})
