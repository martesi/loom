import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  ctrlDrag,
  dropAsset,
  imageNodes,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

test('resize and link replay in order without moving unrelated nodes', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'group-fixtures')
  for (const [index, name] of [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ].entries())
    await dropAsset(page, name, { x: 400 + index * 220, y: 200 })
  await page
    .locator('.react-flow__pane')
    .click({ position: { x: 900, y: 600 } })
  await autoArrangeCanvas(page)
  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(3)
  const first = nodes.nth(0)
  const bounds = async () =>
    nodes.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect()
        return [box.x, box.y, box.width, box.height].map(Math.round)
      })
    )
  await first.click()
  const before = await bounds()
  const handle = await first.getByTestId('resize-handle-nw').boundingBox()
  if (!handle) throw new Error('missing resize handle')
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(handle.x - 80, handle.y - 60, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await bounds())[0][2])
    .toBeGreaterThan(before[0][2] + 30)
  const resized = await bounds()
  await ctrlDrag(page, first, nodes.nth(1))
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect.poll(bounds).toEqual(resized)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(bounds).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(bounds).toEqual(resized)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect.poll(bounds).toEqual(resized)
  await page.screenshot({ path: testInfo.outputPath('history-replayed.png') })
})

test('held resize stays cancelled across undo refresh, then the same handle records one resize', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'group-fixtures')
  await dropAsset(page, 'group-alpha.png', { x: 500, y: 180 })
  await expect(imageNodes(page)).toHaveCount(1)
  const first = imageNodes(page).first()
  await first.click()
  const rectangle = async () =>
    first.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height].map(Math.round)
    })
  const resizeOnce = async (dx: number, dy: number) => {
    const handle = first.getByTestId('resize-handle-nw')
    const box = await handle.boundingBox()
    if (!box) throw new Error('top-left resize handle is not visible')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 5 })
    await page.mouse.up()
  }

  const original = await rectangle()
  await resizeOnce(-25, -20)
  await expect
    .poll(async () => (await rectangle())[2])
    .toBeGreaterThan(original[2])
  const firstResize = await rectangle()

  const handle = first.getByTestId('resize-handle-nw')
  const held = await handle.boundingBox()
  if (!held) throw new Error('top-left resize handle is not visible')
  const x = held.x + held.width / 2
  const y = held.y + held.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 45, y - 35, { steps: 5 })
  await expect
    .poll(async () => (await rectangle())[2])
    .toBeGreaterThan(firstResize[2])

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(rectangle).toEqual(original)
  await page.mouse.move(1200, 720, { steps: 3 })
  await page.mouse.up()
  await expect.poll(rectangle).toEqual(original)

  await resizeOnce(-18, -14)
  await expect
    .poll(async () => (await rectangle())[2])
    .toBeGreaterThan(original[2])
  const secondResize = await rectangle()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(rectangle).toEqual(original)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(rectangle).toEqual(secondResize)
  await page.screenshot({
    path: testInfo.outputPath('resize-token-replay.png'),
  })
})

test('pointer cancel, lost capture, and blur cancel resize without history', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures')
  await dropAsset(page, 'group-alpha.png', { x: 500, y: 180 })
  const node = imageNodes(page).first()
  await node.click()
  const geometry = async () => {
    const box = await node.boundingBox()
    if (!box) throw new Error('missing canvas node')
    return [box.x, box.y, box.width, box.height].map(Math.round)
  }
  const before = await geometry()
  const holdResize = async () => {
    const handle = node.getByTestId('resize-handle-nw')
    const box = await handle.boundingBox()
    if (!box) throw new Error('top-left resize handle is not visible')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 35, y - 25, { steps: 4 })
    return handle
  }
  const releaseOutside = async () => {
    await page.mouse.move(1200, 720, { steps: 2 })
    await page.mouse.up()
    await expect.poll(geometry).toEqual(before)
  }

  const cancelled = await holdResize()
  await cancelled.dispatchEvent('pointercancel', {
    pointerId: 1,
    pointerType: 'mouse',
    bubbles: true,
  })
  await releaseOutside()

  const lost = await holdResize()
  const captured = await lost.evaluate((element) => {
    if (!element.hasPointerCapture(1)) return false
    element.releasePointerCapture(1)
    return true
  })
  expect(captured).toBe(true)
  await releaseOutside()

  await holdResize()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await releaseOutside()

  await holdResize()
  await page.mouse.up()
  await expect
    .poll(async () => (await geometry())[2])
    .toBeGreaterThan(before[2])
  const resized = await geometry()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(geometry).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(geometry).toEqual(resized)
  const keyboardHandle = node.getByTestId('resize-handle-nw')
  await keyboardHandle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => (await geometry())[2])
    .toBeGreaterThan(resized[2])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(geometry).toEqual(resized)
})

test('selection change cancels a held resize and resize activation preserves multi-selection', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures')
  await placeAssets(
    page,
    ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
    {
      x: 100,
      y: 100,
    }
  )
  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(3)
  await selectImageNodes(page, [0, 1])
  const first = nodes.nth(0)
  const second = nodes.nth(2)
  const rect = async () =>
    first.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height].map(Math.round)
    })
  const before = await rect()
  const handle = first.getByTestId('resize-handle-nw')
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('top-left resize handle is not visible')
  const x = handleBox.x + handleBox.width / 2
  const y = handleBox.y + handleBox.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 40, y - 30, { steps: 4 })
  await expect.poll(async () => (await rect())[2]).toBeGreaterThan(before[2])

  await second.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
  await expect(first.getByTestId('resize-handle-nw')).toHaveCount(0)
  await expect.poll(rect).toEqual(before)
  await page.mouse.move(1200, 740, { steps: 2 })
  await page.mouse.up()
  await expect.poll(rect).toEqual(before)

  await page.keyboard.press('Shift+2')
  await page.keyboard.press('Shift+1')
  await expect(first).toBeVisible()
  await selectImageNodes(page, [0, 1])
  const selectedHandle = first.getByTestId('resize-handle-se')
  const baselineWidth = await first.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  )
  await selectedHandle.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect
    .poll(async () =>
      first.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width)
      )
    )
    .toBeGreaterThan(baselineWidth)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect
    .poll(async () =>
      first.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width)
      )
    )
    .toBe(baselineWidth)
  await selectedHandle.focus()
  const pointerHandle = first.getByTestId('resize-handle-se')
  const pointerBounds = await pointerHandle.boundingBox()
  if (!pointerBounds)
    throw new Error('bottom-right resize handle is not visible')
  await page.mouse.move(
    pointerBounds.x + pointerBounds.width / 2,
    pointerBounds.y + pointerBounds.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    pointerBounds.x + pointerBounds.width / 2 + 25,
    pointerBounds.y + pointerBounds.height / 2 + 15,
    { steps: 4 }
  )
  await page.mouse.up()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect
    .poll(async () =>
      first.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width)
      )
    )
    .toBeGreaterThan(baselineWidth + 10)
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(async () =>
      first.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width)
      )
    )
    .toBe(baselineWidth)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
})

test('viewport culling cancels an active pointer resize without a late write', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures')
  await placeAssets(
    page,
    ['group-alpha.png', 'group-beta.png', 'group-gamma.png'],
    { x: 100, y: 100 }
  )
  await page.keyboard.press('Shift+1')
  const first = imageNodes(page).first()
  await first.click()
  const geometry = async () =>
    first.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height].map(Math.round)
    })
  const before = await geometry()
  const handle = first.getByTestId('resize-handle-se')
  const box = await handle.boundingBox()
  if (!box) throw new Error('bottom-right resize handle is not visible')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 20, y + 15, { steps: 3 })
  await expect
    .poll(async () => (await geometry())[2])
    .toBeGreaterThan(before[2])

  await page.mouse.wheel(10000, 0)
  await expect(first).toHaveCount(0)
  await page.mouse.move(1200, 740, { steps: 2 })
  await page.mouse.up()
  await page.keyboard.press('Shift+1')
  await expect(first).toBeVisible()
  await expect.poll(geometry).toEqual(before)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)

  const freshHandle = first.getByTestId('resize-handle-se')
  const freshBox = await freshHandle.boundingBox()
  if (!freshBox) throw new Error('fresh resize handle was not restored')
  const freshX = freshBox.x + freshBox.width / 2
  const freshY = freshBox.y + freshBox.height / 2
  await page.mouse.move(freshX, freshY)
  await page.mouse.down()
  await page.mouse.move(freshX + 20, freshY + 15, { steps: 3 })
  await page.mouse.up()
  await expect
    .poll(async () => (await geometry())[2])
    .toBeGreaterThan(before[2])
  const resized = await geometry()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(geometry).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(geometry).toEqual(resized)
})
