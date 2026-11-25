import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  ctrlDrag,
  dropAsset,
  imageNodes,
  openFixtureRepo,
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
