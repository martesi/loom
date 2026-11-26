import type { Page } from '@playwright/test'
import type {
  GeometryUpdate,
  LayoutSnapshot,
  UndoState,
} from '../bindings/loom/internal/service/models'
import { runtimeMethodID } from './bindings'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  ctrlDrag,
  dropAsset,
  fixturePath,
  imageNodes,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

const setGeometryMethodID = runtimeMethodID(
  'imageservice.ts',
  'SetGeometryFromDisplayAtRevision'
)
const setViewportMethodID = runtimeMethodID('imageservice.ts', 'SetViewport')

async function savedGeometry(
  page: Page,
  path: string,
  imageId: number
): Promise<GeometryUpdate> {
  const snapshot = await legacyServiceCall<LayoutSnapshot | null>(
    page,
    'imageservice.ts',
    'GetLayoutSnapshot',
    [path]
  )
  const geometry = snapshot?.images?.find(
    (image) => image.id === imageId
  )?.geometry
  if (!geometry)
    throw new Error(`missing persisted geometry for image ${imageId}`)
  return {
    ...geometry,
    x: geometry.x ?? 0,
    y: geometry.y ?? 0,
    w: geometry.w ?? 150,
    h: geometry.h ?? 110,
  }
}

async function undoState(page: Page, path: string) {
  return legacyServiceCall<UndoState | null>(page, 'undoservice.ts', 'State', [
    path,
  ])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

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
  await selectedHandle.click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await expect
    .poll(async () =>
      first.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width)
      )
    )
    .toBe(baselineWidth)
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

for (const scenario of [
  {
    name: 'Reset Zoom with a top-left handle',
    shortcut: 'ControlOrMeta+0',
    direction: 'nw',
    dx: -60,
    dy: -45,
  },
  {
    name: 'Fit All with a bottom-right handle',
    shortcut: 'Shift+1',
    direction: 'se',
    dx: 60,
    dy: 45,
  },
] as const) {
  test(`passive viewport persistence does not cancel resize after ${scenario.name}`, async ({
    page,
  }) => {
    await openFixtureRepo(page, 'group-fixtures')
    await dropAsset(page, 'group-alpha.png', { x: 500, y: 180 })
    const node = imageNodes(page).first()
    await node.click()
    const viewportZoom = () =>
      page.locator('.react-flow__viewport').evaluate((element) => {
        const transform = getComputedStyle(element).transform
        return new DOMMatrixReadOnly(transform).a
      })
    await page.keyboard.press(
      scenario.shortcut === 'ControlOrMeta+0' ? 'Shift+1' : 'ControlOrMeta+0'
    )
    if (scenario.shortcut === 'ControlOrMeta+0')
      await expect.poll(viewportZoom).not.toBe(1)
    else await expect.poll(viewportZoom).toBeCloseTo(1)
    await page.waitForTimeout(200)

    const repoPath = await fixturePath('group-fixtures')
    const imageId = Number(await node.getAttribute('data-id'))
    const before = await savedGeometry(page, repoPath, imageId)
    const firstViewportSaved = deferred<void>()
    const passiveViewportStarted = deferred<void>()
    const passiveViewportSaved = deferred<void>()
    const passiveViewportGate = deferred<void>()
    let viewportCalls = 0
    let pointerHeld = false
    let passiveSaveStartedDuringResize = false
    let geometryCalls = 0

    page.on('request', (request) => {
      if (
        request.url().endsWith('/wails/runtime') &&
        request.postData()?.includes(`"methodID":${setGeometryMethodID}`)
      )
        geometryCalls++
    })
    await page.route('**/wails/runtime', async (route) => {
      if (
        !route
          .request()
          .postData()
          ?.includes(`"methodID":${setViewportMethodID}`)
      ) {
        await route.continue()
        return
      }
      viewportCalls++
      const response = await route.fetch()
      if (viewportCalls === 1) {
        await route.fulfill({ response })
        firstViewportSaved.resolve()
        return
      }
      passiveSaveStartedDuringResize = pointerHeld
      passiveViewportStarted.resolve()
      await passiveViewportGate.promise
      await route.fulfill({ response })
      passiveViewportSaved.resolve()
    })

    await page.keyboard.press(scenario.shortcut)
    await firstViewportSaved.promise
    if (scenario.shortcut === 'Shift+1')
      expect(Math.abs((await viewportZoom()) - 1)).toBeGreaterThan(0.05)
    else expect(await viewportZoom()).toBeCloseTo(1)
    const handle = node.getByTestId(`resize-handle-${scenario.direction}`)
    const box = await handle.boundingBox()
    if (!box) throw new Error(`missing ${scenario.direction} resize handle`)
    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    const beforeBox = await node.boundingBox()
    if (!beforeBox) throw new Error('missing resize target')
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    pointerHeld = true
    await page.mouse.move(startX + scenario.dx, startY + scenario.dy, {
      steps: 5,
    })
    await passiveViewportStarted.promise
    expect(passiveSaveStartedDuringResize).toBe(true)
    const previewBox = await node.boundingBox()
    if (!previewBox) throw new Error('missing resized node preview')
    expect(previewBox.width).toBeGreaterThan(beforeBox.width + 20)

    await page.mouse.up()
    pointerHeld = false
    expect(geometryCalls).toBe(0)
    passiveViewportGate.resolve()
    await passiveViewportSaved.promise
    await expect
      .poll(() => savedGeometry(page, repoPath, imageId))
      .not.toEqual(before)
    const resized = await savedGeometry(page, repoPath, imageId)
    expect(geometryCalls).toBeGreaterThan(0)

    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() => savedGeometry(page, repoPath, imageId))
      .toEqual(before)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect
      .poll(() => savedGeometry(page, repoPath, imageId))
      .toEqual(resized)
    await page.unroute('**/wails/runtime')
  })
}

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
  const repoPath = await fixturePath('group-fixtures')
  const imageId = Number(await first.getAttribute('data-id'))
  const before = await savedGeometry(page, repoPath, imageId)
  const undoBefore = await undoState(page, repoPath)
  let geometryWrites = 0
  page.on('request', (request) => {
    if (
      request.url().endsWith('/wails/runtime') &&
      request.postData()?.includes(`"methodID":${setGeometryMethodID}`)
    )
      geometryWrites++
  })
  const handle = first.getByTestId('resize-handle-se')
  const box = await handle.boundingBox()
  if (!box) throw new Error('bottom-right resize handle is not visible')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('[data-testid="resize-handle-se"]') !== null,
        { x, y }
      )
    )
    .toBe(true)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 55, y + 40, { steps: 4 })
  const heldBox = await first.boundingBox()
  if (!heldBox) throw new Error('resizing node disappeared before pan')
  expect(heldBox.width).toBeGreaterThan(box.width + 20)

  await page.mouse.wheel(10000, 0)
  await expect(first).toHaveCount(0)
  await page.mouse.move(1200, 740, { steps: 2 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect(geometryWrites).toBe(0)
  expect(await savedGeometry(page, repoPath, imageId)).toEqual(before)
  expect(await undoState(page, repoPath)).toEqual(undoBefore)

  await page.keyboard.press('Shift+1')
  await expect(first).toBeVisible()
  expect(await savedGeometry(page, repoPath, imageId)).toEqual(before)
  expect(await undoState(page, repoPath)).toEqual(undoBefore)

  const freshHandle = first.getByTestId('resize-handle-se')
  const freshBox = await freshHandle.boundingBox()
  if (!freshBox) throw new Error('fresh resize handle was not restored')
  const freshX = freshBox.x + freshBox.width / 2
  const freshY = freshBox.y + freshBox.height / 2
  await page.mouse.move(freshX, freshY)
  await page.mouse.down()
  await page.mouse.move(freshX + 55, freshY + 40, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(() => savedGeometry(page, repoPath, imageId))
    .not.toEqual(before)
  const resized = await savedGeometry(page, repoPath, imageId)
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() => savedGeometry(page, repoPath, imageId))
    .toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect
    .poll(() => savedGeometry(page, repoPath, imageId))
    .toEqual(resized)
})

test('keeps a real geometry write admitted until backend response and reconciliation', async ({
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
  let releaseResponse = () => {}
  let signalResponseStarted = () => {}
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  const responseStarted = new Promise<void>((resolve) => {
    signalResponseStarted = resolve
  })
  await page.route('**/wails/runtime', async (route) => {
    if (
      route.request().postData()?.includes(`"methodID":${setGeometryMethodID}`)
    ) {
      const response = await route.fetch()
      signalResponseStarted()
      await responseGate
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })

  const before = await geometry()
  const handle = node.getByTestId('resize-handle-se')
  const box = await handle.boundingBox()
  if (!box) throw new Error('resize handle is unavailable')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 26, y + 18, { steps: 3 })
  await page.mouse.up()
  await responseStarted

  const submitted = await geometry()
  expect(submitted[2]).toBeGreaterThan(before[2])
  const nextHandle = node.getByTestId('resize-handle-se')
  const nextBox = await nextHandle.boundingBox()
  if (!nextBox) throw new Error('resize handle disappeared during write')
  await page.mouse.move(
    nextBox.x + nextBox.width / 2,
    nextBox.y + nextBox.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    nextBox.x + nextBox.width / 2 + 42,
    nextBox.y + nextBox.height / 2 + 30,
    {
      steps: 3,
    }
  )
  await page.mouse.up()
  await expect.poll(geometry).toEqual(submitted)

  releaseResponse()
  await expect.poll(geometry).toEqual(submitted)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(geometry).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(geometry).toEqual(submitted)
  await page.unroute('**/wails/runtime')
})
