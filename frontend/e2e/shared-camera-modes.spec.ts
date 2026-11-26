import type { Page } from '@playwright/test'
import {
  reverseRelationshipMethodID,
  runtimeMethodID,
  setViewportMethodID,
} from './bindings'
import { expect, test } from './test-fixtures'
import { ctrlDrag, imageNodes, openFixtureRepo } from './test-helpers'

const setGeometryMethodID = runtimeMethodID(
  'imageservice.ts',
  'SetGeometryFromDisplayAtRevision'
)

function waitForCameraSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().endsWith('/wails/runtime') &&
      response
        .request()
        .postData()
        ?.includes(`"methodID":${setViewportMethodID}`) === true
  )
}

async function cameraValues(page: Page) {
  return page.locator('.react-flow__viewport').evaluate((element) => {
    const match = (element as HTMLElement).style.transform.match(
      /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/
    )
    if (!match) throw new Error('viewport transform is missing')
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
  })
}

test('modes keep one camera and persist the linked and loose layouts', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const view = page.getByTestId('canvas-mode-view')
  const edit = page.getByTestId('canvas-mode-edit')
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(0)
  const cameraSaved = waitForCameraSave(page)
  await edit.click()
  await expect(edit).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(3)
  await cameraSaved
  const looseId = await imageNodes(page).nth(2).getAttribute('data-id')
  await ctrlDrag(page, imageNodes(page).nth(0), imageNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.locator('main').focus()
  const resetSaved = waitForCameraSave(page)
  await page.keyboard.press('ControlOrMeta+0')
  await resetSaved
  const viewport = page.locator('.react-flow__viewport')
  await expect
    .poll(async () =>
      (await viewport.getAttribute('style'))?.includes('scale(1)')
    )
    .toBe(true)
  const viewSave = waitForCameraSave(page)
  await view.click()
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(2)
  await expect(
    page.locator(`.react-flow__node[data-id="${looseId}"]`)
  ).toHaveCount(0)
  const positionsInView = await imageNodes(page).evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute('data-id'),
      transform: (element as HTMLElement).style.transform,
    }))
  )
  await expect
    .poll(async () =>
      (await viewport.getAttribute('style'))?.includes('scale(1)')
    )
    .toBe(true)
  await viewSave
  const saved = await viewport.getAttribute('style')
  let reloadLayouts = 0
  page.on('request', (request) => {
    if (
      request.url().endsWith('/wails/runtime') &&
      request.postData()?.includes(`"methodID":${setGeometryMethodID}`)
    )
      reloadLayouts++
  })
  await page.reload()
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(2)
  expect(
    await imageNodes(page).evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.getAttribute('data-id'),
        transform: (element as HTMLElement).style.transform,
      }))
    )
  ).toEqual(positionsInView)
  await expect(viewport).toHaveAttribute('style', saved ?? '')
  expect(reloadLayouts).toBe(0)
  const editAgainSave = waitForCameraSave(page)
  await edit.click()
  await expect(edit).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(3)
  await expect
    .poll(async () =>
      (await viewport.getAttribute('style'))?.includes('scale(1)')
    )
    .toBe(true)
  await editAgainSave
  const rectangles = await imageNodes(page).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        id: element.getAttribute('data-id'),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      }
    })
  )
  const loose = rectangles.find((rect) => rect.id === looseId)
  if (!loose) throw new Error('Loose image is missing in Edit')
  const pane = await page.locator('.react-flow__pane').boundingBox()
  if (!pane) throw new Error('Canvas pane has no bounds')
  expect((loose.left + loose.right) / 2).toBeCloseTo(pane.x + pane.width / 2, 0)
  for (const linked of rectangles.filter((rect) => rect.id !== looseId)) {
    expect(
      linked.left >= loose.right ||
        linked.right <= loose.left ||
        linked.top >= loose.bottom ||
        linked.bottom <= loose.top
    ).toBe(true)
  }
  await testInfo.attach('edit-layout', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})

test('Fit accepted during a pending mode layout waits for its committed nodes', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  let saved = waitForCameraSave(page)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)
  await saved
  await ctrlDrag(page, imageNodes(page).nth(0), imageNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route('**/wails/runtime', async (route) => {
    if (
      !route.request().postData()?.includes(`"methodID":${setGeometryMethodID}`)
    )
      return route.continue()
    const response = await route.fetch()
    started()
    await gate
    await route.fulfill({ response })
  })
  await page.getByTestId('canvas-mode-view').click()
  await pending
  await page.locator('main').focus()
  await page.keyboard.press('Shift+1')
  saved = waitForCameraSave(page)
  release()
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(imageNodes(page)).toHaveCount(2)
  await saved
  const fitAfterMode = await cameraValues(page)
  saved = waitForCameraSave(page)
  await page.locator('main').focus()
  await page.keyboard.press('Shift+1')
  await saved
  const fittedAgain = await cameraValues(page)
  expect(fitAfterMode.x).toBeCloseTo(fittedAgain.x, 1)
  expect(fitAfterMode.y).toBeCloseTo(fittedAgain.y, 1)
  expect(fitAfterMode.zoom).toBeCloseTo(fittedAgain.zoom, 3)
  await page.unroute('**/wails/runtime')
})

test('Fit interrupts a mode recenter and the later mode interrupts Fit', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const edit = page.getByTestId('canvas-mode-edit')
  const view = page.getByTestId('canvas-mode-view')
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  let saved = waitForCameraSave(page)
  await edit.click()
  await expect(imageNodes(page)).toHaveCount(3)
  await saved
  await ctrlDrag(page, imageNodes(page).nth(0), imageNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)

  await view.click()
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(2)
  saved = waitForCameraSave(page)
  await page.locator('main').focus()
  await page.keyboard.press('Shift+1')
  await saved
  const fitAfterRecenter = await cameraValues(page)
  saved = waitForCameraSave(page)
  await page.keyboard.press('Shift+1')
  await saved
  const fitAgain = await cameraValues(page)
  expect(fitAfterRecenter.x).toBeCloseTo(fitAgain.x, 1)
  expect(fitAfterRecenter.y).toBeCloseTo(fitAgain.y, 1)
  expect(fitAfterRecenter.zoom).toBeCloseTo(fitAgain.zoom, 3)

  await edit.click()
  await expect(edit).toHaveAttribute('aria-pressed', 'true')
  await page.locator('main').focus()
  await page.keyboard.press('Shift+1')
  await expect
    .poll(async () => (await cameraValues(page)).zoom)
    .not.toBe(fitAgain.zoom)
  await view.evaluate((button) =>
    button.addEventListener(
      'click',
      () => {
        const viewport = document.querySelector<HTMLElement>(
          '.react-flow__viewport'
        )
        button.setAttribute(
          'data-test-camera-at-click',
          viewport?.style.transform ?? ''
        )
      },
      { once: true, capture: true }
    )
  )
  saved = waitForCameraSave(page)
  await view.click()
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await saved
  await expect(imageNodes(page)).toHaveCount(2)
  const finalCamera = await cameraValues(page)
  const atClick = await view.getAttribute('data-test-camera-at-click')
  const zoomAtClick = Number(atClick?.match(/scale\(([-\d.]+)\)/)?.[1])
  expect(finalCamera.zoom).toBeCloseTo(zoomAtClick, 3)
  await page.reload()
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(2)
  await expect.poll(() => cameraValues(page)).toEqual(finalCamera)
})

test('Edit connection tools and Undo do not rearrange the board', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const saved = waitForCameraSave(page)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)
  await saved
  const nodes = imageNodes(page)
  const positions = async () =>
    nodes.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).style.transform)
    )
  const before = await positions()
  await nodes.nth(0).click()
  await page.keyboard.press('d')
  await expect(page.getByTestId('connection-tool-status')).toBeVisible()
  await nodes.nth(1).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await nodes.nth(2).click()
  await page.keyboard.press('s')
  await expect(page.getByTestId('connection-tool-status')).toBeVisible()
  await nodes.nth(1).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await page.locator('main').focus()
  await page.keyboard.press('r')
  await expect(page.getByTestId('connection-tool-status')).toBeVisible()
  const edge = page.locator('.react-flow__edge').nth(1)
  const path = edge.locator('.react-flow__edge-path')
  const beforeReverse = await path.getAttribute('d')
  const reversed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/wails/runtime') &&
      response
        .request()
        .postData()
        ?.includes(`"methodID":${reverseRelationshipMethodID}`) === true
  )
  await edge.locator('.react-flow__edge-interaction').click({ force: true })
  await reversed
  await expect(path).not.toHaveAttribute('d', beforeReverse ?? '')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(path).toHaveAttribute('d', beforeReverse ?? '')
  expect(await positions()).toEqual(before)
})

test('a delayed older save cannot overwrite a newer Fit', async ({ page }) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const initialSave = waitForCameraSave(page)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)
  await initialSave

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let writes = 0
  await page.route('**/wails/runtime', async (route) => {
    if (
      !route.request().postData()?.includes(`"methodID":${setViewportMethodID}`)
    ) {
      await route.continue()
      return
    }
    writes++
    if (writes !== 1) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    started()
    await gate
    await route.fulfill({ response })
  })
  const pane = page.locator('.react-flow__pane')
  const bounds = await pane.boundingBox()
  if (!bounds) throw new Error('Canvas pane has no bounds')
  await page.mouse.move(bounds.x + 100, bounds.y + 100)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(bounds.x + 200, bounds.y + 150, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  await firstStarted
  const panned = await cameraValues(page)
  await page.locator('main').focus()
  await page.keyboard.press('Shift+1')
  await expect
    .poll(async () => (await cameraValues(page)).zoom)
    .not.toBe(panned.zoom)
  expect(writes).toBe(1)
  const newestSave = page.waitForResponse(
    (response) =>
      writes === 2 &&
      response.url().endsWith('/wails/runtime') &&
      response
        .request()
        .postData()
        ?.includes(`"methodID":${setViewportMethodID}`) === true
  )
  release()
  await newestSave
  await expect.poll(() => writes).toBe(2)
  const finalCamera = await cameraValues(page)
  await page.unroute('**/wails/runtime')
  await page.reload()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect.poll(() => cameraValues(page)).toEqual(finalCamera)
})

test('an older physical pan cannot take control back after Fit', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  let saved = waitForCameraSave(page)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)
  await saved
  await page.locator('main').focus()
  const box = await page.locator('.react-flow__pane').boundingBox()
  if (!box) throw new Error('Canvas pane has no bounds')
  await page.mouse.move(box.x + 100, box.y + 100)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(box.x + 170, box.y + 150, { steps: 3 })
  saved = waitForCameraSave(page)
  await page.keyboard.press('Shift+1')
  await page.mouse.move(box.x + 280, box.y + 220, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  await saved
  const afterInterruption = await cameraValues(page)
  saved = waitForCameraSave(page)
  await page.keyboard.press('Shift+1')
  await saved
  const expected = await cameraValues(page)
  expect(afterInterruption.x).toBeCloseTo(expected.x, 1)
  expect(afterInterruption.y).toBeCloseTo(expected.y, 1)
  expect(afterInterruption.zoom).toBeCloseTo(expected.zoom, 3)
  await page.reload()
  await expect.poll(() => cameraValues(page)).toEqual(expected)
})

test('a later mode command follows an earlier pending layout', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const firstSave = waitForCameraSave(page)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)
  await firstSave
  await ctrlDrag(page, imageNodes(page).nth(0), imageNodes(page).nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  let delayed = false
  await page.route('**/wails/runtime', async (route) => {
    if (
      delayed ||
      !route.request().postData()?.includes(`"methodID":${setGeometryMethodID}`)
    )
      return route.continue()
    delayed = true
    const response = await route.fetch()
    started()
    await gate
    await route.fulfill({ response })
  })
  await page.getByTestId('canvas-mode-view').click()
  await pending
  await page.getByTestId('canvas-mode-edit').click()
  const saved = waitForCameraSave(page)
  release()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await saved
  await expect(imageNodes(page)).toHaveCount(3)
  const beforeReload = await imageNodes(page).evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).style.transform)
  )
  await page.unroute('**/wails/runtime')
  await page.reload()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(imageNodes(page)).toHaveCount(3)
  expect(
    await imageNodes(page).evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).style.transform)
    )
  ).toEqual(beforeReload)
})

test('View orders linked components by pairing time and keeps loose images hidden', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  let saved = waitForCameraSave(page)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)
  await saved
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  await page.locator('input[type=file]').setInputFiles([
    { name: 'extra-a.png', mimeType: 'image/png', buffer: image },
    { name: 'extra-b.png', mimeType: 'image/png', buffer: image },
  ])
  await expect(imageNodes(page)).toHaveCount(5)
  await page.locator('main').focus()
  saved = waitForCameraSave(page)
  await page.keyboard.press('Shift+1')
  await saved
  const nodes = imageNodes(page)
  const ids = await nodes.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-id'))
  )
  await ctrlDrag(page, nodes.nth(0), nodes.nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await ctrlDrag(page, nodes.nth(2), nodes.nth(3))
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  saved = waitForCameraSave(page)
  await page.getByTestId('canvas-mode-view').click()
  await saved
  await expect(nodes).toHaveCount(4)
  await expect(
    page.locator(`.react-flow__node[data-id="${ids[4]}"]`)
  ).toHaveCount(0)
  const row = async (id: string | null) =>
    page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((element) => {
      const transform = (element as HTMLElement).style.transform
      const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
      if (!match) throw new Error('Missing node position')
      return Number(match[2])
    })
  expect(await row(ids[0])).toBeLessThan(await row(ids[2]))
  const positions = await nodes.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).style.transform)
  )
  await page.reload()
  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(nodes).toHaveCount(4)
  expect(
    await nodes.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).style.transform)
    )
  ).toEqual(positions)
})
