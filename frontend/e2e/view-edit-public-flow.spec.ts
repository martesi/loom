import type { Page } from '@playwright/test'
import { runtimeMethodID } from './bindings'
import { expect, test } from './test-fixtures'
import {
  asset,
  ctrlDrag,
  dropAsset,
  imageNodes,
  nodeBox,
  openAssetsShelf,
  openFixtureRepo,
} from './test-helpers'

const importMediaMethodID = runtimeMethodID('imageservice.ts', 'ImportMedia')
const placeImagesMethodID = runtimeMethodID('imageservice.ts', 'PlaceImages')
const getLayoutSnapshotMethodID = runtimeMethodID(
  'imageservice.ts',
  'GetLayoutSnapshot'
)
const setGeometryMethodID = runtimeMethodID(
  'imageservice.ts',
  'SetGeometryFromDisplayAtRevision'
)

async function clickEdge(page: Page, index = 0) {
  const point = await page
    .locator('.react-flow__edge-path')
    .nth(index)
    .evaluate((path) => {
      const element = path as SVGPathElement
      const middle = element.getPointAtLength(element.getTotalLength() / 2)
      const matrix = element.getScreenCTM()
      if (!matrix) throw new Error('edge has no screen transform')
      const screen = new DOMPoint(middle.x, middle.y).matrixTransform(matrix)
      return { x: screen.x, y: screen.y }
    })
  await page.mouse.click(point.x, point.y)
}

test('public View and Edit modes stage imported unpaired media and keep View read-only', async ({
  page,
}, testInfo) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const view = page.getByTestId('canvas-mode-view')
  const edit = page.getByTestId('canvas-mode-edit')

  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(0)
  await expect(edit).toContainText('3')
  await page.locator('input[type=file]').setInputFiles({
    name: 'public-view-edit-import.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  })
  await expect(edit).toContainText('4')
  await openAssetsShelf(page)
  const assetRow = asset(page, 'group-alpha.png')
  await assetRow.dragTo(page.locator('.react-flow__pane'), {
    targetPosition: { x: 800, y: 300 },
  })
  await expect(imageNodes(page)).toHaveCount(0)
  await page.getByTestId('toggle-assets-shelf').click()
  await page.getByTestId('empty-canvas-edit').click()
  await expect(edit).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(4)
  await testInfo.attach('view-edit-visible-toolbar.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await page.keyboard.press('Control+\\')
  await expect(page.getByTestId('canvas-workspace-controls')).toHaveAttribute(
    'aria-hidden',
    'true'
  )
  await page.getByRole('button', { name: 'Exit Focus Canvas mode' }).click()
  await expect(page.getByTestId('canvas-workspace-controls')).toHaveAttribute(
    'aria-hidden',
    'false'
  )
  await expect(edit).toHaveAttribute('aria-pressed', 'true')

  const initial = await Promise.all(
    [0, 1, 2, 3].map((index) => nodeBox(imageNodes(page).nth(index)))
  )
  for (let left = 0; left < initial.length; left += 1) {
    for (let right = left + 1; right < initial.length; right += 1) {
      const a = initial[left]
      const b = initial[right]
      expect(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
      ).toBe(true)
    }
  }

  await page.getByTestId('canvas-mode-view').click()
  await expect(view).toHaveAttribute('aria-pressed', 'true')
  await expect(imageNodes(page)).toHaveCount(0)

  await page.keyboard.press('Control+z')
  await expect(imageNodes(page)).toHaveCount(0)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(4)
  await expect(edit).toHaveAttribute('aria-pressed', 'true')
})

test('linked graph opens in View, preserves Edit geometry, and rejects View mutation', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)

  const nodes = imageNodes(page)
  for (const index of [0, 1]) {
    await ctrlDrag(page, nodes.nth(index), nodes.nth(index + 1))
    await expect(page.locator('.react-flow__edge')).toHaveCount(index + 1)
  }

  const view = page.getByTestId('canvas-mode-view')
  await view.click()
  await expect(imageNodes(page)).toHaveCount(3)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(page.getByTestId('dock-connect-derivative')).toHaveCount(0)
  await page.keyboard.press('d')
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await clickEdge(page)
  await page.getByTestId('toggle-inspector-shelf').click()
  await expect(
    page.locator('aside[aria-label="Inspector"]').getByRole('button', {
      name: 'Remove relationship',
    })
  ).toBeDisabled()
  await page.getByTestId('toggle-inspector-shelf').click()
  await expect(page.getByTestId('dock-auto-arrange')).toHaveCount(0)
  const positionsInView = await Promise.all(
    [0, 1, 2].map((index) => nodeBox(nodes.nth(index)))
  )
  const source = await nodeBox(nodes.nth(0))
  const target = await nodeBox(nodes.nth(2))
  await page.keyboard.down('Control')
  await page.mouse.move(source.x + 40, source.y + 40)
  await page.mouse.down()
  await page.mouse.move(target.x + 40, target.y + 40, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  const beforeViewDrag = await nodeBox(nodes.nth(0))
  await page.mouse.move(
    beforeViewDrag.x + beforeViewDrag.width / 2,
    beforeViewDrag.y + beforeViewDrag.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    beforeViewDrag.x + beforeViewDrag.width / 2 + 80,
    beforeViewDrag.y + beforeViewDrag.height / 2 + 50,
    { steps: 5 }
  )
  await page.mouse.up()
  const afterViewDrag = await nodeBox(nodes.nth(0))
  expect(afterViewDrag.x).toBeCloseTo(beforeViewDrag.x, 0)
  expect(afterViewDrag.y).toBeCloseTo(beforeViewDrag.y, 0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)

  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(3)
  const positionsInEdit = await Promise.all(
    [0, 1, 2].map((index) => nodeBox(nodes.nth(index)))
  )
  for (let index = 0; index < positionsInView.length; index += 1) {
    expect(positionsInEdit[index].x).toBeCloseTo(positionsInView[index].x, 0)
    expect(positionsInEdit[index].y).toBeCloseTo(positionsInView[index].y, 0)
  }
  const editViewport = await page
    .locator('.react-flow__viewport')
    .getAttribute('style')
  await view.click()
  const viewViewport = await page
    .locator('.react-flow__viewport')
    .getAttribute('style')
  const pane = page.locator('.react-flow__pane')
  const paneBounds = await pane.boundingBox()
  if (!paneBounds) throw new Error('Canvas pane has no bounding box')
  await page.mouse.move(paneBounds.x + 40, paneBounds.y + 90)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(paneBounds.x + 120, paneBounds.y + 150, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  await expect
    .poll(() => page.locator('.react-flow__viewport').getAttribute('style'))
    .not.toBe(viewViewport)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    editViewport ?? ''
  )
})

test('Edit D/S/R connection tools retain their anchor and cancel with Escape', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  const nodes = imageNodes(page)
  await nodes.nth(0).click({ position: { x: 20, y: 20 } })
  const derivative = page.getByTestId('dock-connect-derivative')
  await expect(derivative).toBeEnabled()
  await derivative.click()
  await expect(derivative).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('connection-tool-status')).toContainText(
    'Connect source → derivative'
  )
  await nodes.nth(0).click({ position: { x: 20, y: 20 } })
  await expect(page.getByRole('alert')).toContainText(
    'An image cannot be related to itself'
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await nodes.nth(1).click({ position: { x: 20, y: 20 } })
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await nodes.nth(2).click({ position: { x: 20, y: 20 } })
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(derivative).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await nodes.nth(0).click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('s')
  await nodes.nth(1).click({ position: { x: 20, y: 20 } })
  await expect(page.getByRole('alert')).toContainText(
    'This relationship would create a cycle'
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await nodes.nth(1).click({ position: { x: 20, y: 20 } })
  const source = page.getByTestId('dock-connect-source')
  await expect(source).toBeVisible()
  await expect(source).toBeEnabled()
  await source.click()
  await nodes.nth(2).click({ position: { x: 20, y: 20 } })
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)

  await page.keyboard.press('Escape')
  const reverseTool = page.getByTestId('dock-reverse-relationship')
  await page.keyboard.press('r')
  const cyclicEdge = page.locator('.react-flow__edge').first()
  const cyclicEdgeLabel = await cyclicEdge.getAttribute('aria-label')
  await clickEdge(page)
  await expect(page.getByRole('alert')).toContainText(
    'This relationship would create a cycle'
  )
  await expect(cyclicEdge).toHaveAttribute('aria-label', cyclicEdgeLabel ?? '')
  const edge = page.locator('.react-flow__edge').nth(1)
  const previousLabel = await edge.getAttribute('aria-label')
  await clickEdge(page, 1)
  await expect(edge).not.toHaveAttribute('aria-label', previousLabel ?? '')
  await expect(reverseTool).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
})

test('Edit keeps explicit external file-drop coordinates in one import request', async ({
  page,
}) => {
  await openFixtureRepo(page, 'canvas-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  await expect(imageNodes(page)).toHaveCount(2)
  const surface = page.locator('[data-canvas-surface]')
  const bounds = await surface.boundingBox()
  if (!bounds) throw new Error('Canvas surface has no bounding box')
  const drop = {
    x: bounds.x + bounds.width - 220,
    y: bounds.y + bounds.height - 180,
  }
  const flowTransform = await page.locator('.react-flow').evaluate((root) => {
    const rect = root.getBoundingClientRect()
    const viewport = root.querySelector('.react-flow__viewport')
    if (!viewport) throw new Error('Canvas viewport is missing')
    const matrix = new DOMMatrix(getComputedStyle(viewport).transform)
    return {
      left: rect.left,
      top: rect.top,
      scaleX: matrix.a,
      scaleY: matrix.d,
      translateX: matrix.e,
      translateY: matrix.f,
    }
  })
  const expectedFlowPoint = {
    x:
      (drop.x - flowTransform.left - flowTransform.translateX) /
      flowTransform.scaleX,
    y:
      (drop.y - flowTransform.top - flowTransform.translateY) /
      flowTransform.scaleY,
  }
  const importRequestPromise = page.waitForRequest(
    (request) =>
      request.url().endsWith('/wails/runtime') &&
      request.postData()?.includes(`"methodID":${importMediaMethodID}`) === true
  )
  const runtimeRequests: string[] = []
  const captureRuntimeRequest = (
    request: import('@playwright/test').Request
  ) => {
    if (request.url().endsWith('/wails/runtime'))
      runtimeRequests.push(request.postData() ?? '')
  }
  page.on('request', captureRuntimeRequest)
  await surface.evaluate((element, point) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File(
        [
          Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
            ),
            (character) => character.charCodeAt(0)
          ),
        ],
        'dropped-at-pointer.png',
        { type: 'image/png' }
      )
    )
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: point.x,
        clientY: point.y,
      })
    )
  }, drop)
  const importRequest = await importRequestPromise
  const call = importRequest.postDataJSON().args as { args: unknown[] }
  const args = call.args
  expect(args[2]).toBe(true)
  expect(args[3]).toBeCloseTo(expectedFlowPoint.x, 0)
  expect(args[4]).toBeCloseTo(expectedFlowPoint.y, 0)
  await expect(imageNodes(page)).toHaveCount(3)
  page.off('request', captureRuntimeRequest)
  expect(
    runtimeRequests.filter((body) =>
      body.includes(`"methodID":${importMediaMethodID}`)
    )
  ).toHaveLength(1)
  expect(
    runtimeRequests.some(
      (body) =>
        body.includes(`"methodID":${placeImagesMethodID}`) ||
        body.includes(`"methodID":${setGeometryMethodID}`)
    )
  ).toBe(false)
  const dropped = await nodeBox(imageNodes(page).nth(2))
  const finalFlowTransform = await page
    .locator('.react-flow')
    .evaluate((root) => {
      const rect = root.getBoundingClientRect()
      const viewport = root.querySelector('.react-flow__viewport')
      if (!viewport) throw new Error('Canvas viewport is missing')
      const matrix = new DOMMatrix(getComputedStyle(viewport).transform)
      return { left: rect.left, top: rect.top, x: matrix.e, y: matrix.f }
    })
  expect(dropped.x).toBeCloseTo(
    finalFlowTransform.left +
      finalFlowTransform.x +
      Number(args[3]) * flowTransform.scaleX,
    0
  )
  expect(dropped.y).toBeCloseTo(
    finalFlowTransform.top +
      finalFlowTransform.y +
      Number(args[4]) * flowTransform.scaleY,
    0
  )
})

test('Edit asset drop updates both saved and projected staged geometry', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  const node = imageNodes(page).filter({ hasText: 'group-alpha.png' })
  await expect(node).toHaveCount(1)
  const placementRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/wails/runtime') &&
      request.postData()?.includes(`"methodID":${placeImagesMethodID}`) === true
  )
  const snapshotResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/wails/runtime') &&
      response
        .request()
        .postData()
        ?.includes(`"methodID":${getLayoutSnapshotMethodID}`) === true
  )
  await dropAsset(page, 'group-alpha.png', { x: 820, y: 360 })
  const call = (await placementRequest).postDataJSON().args as {
    args: unknown[]
  }
  const [, ids, x, y] = call.args as [string, number[], number, number, number]
  const snapshot = (await (await snapshotResponse).json()) as {
    images: Array<{
      id: number
      geometry: { x: number | null; y: number | null }
    }>
  }
  const saved = snapshot.images.find((image) => image.id === ids[0])
  expect(saved?.geometry).toMatchObject({ x, y })

  const bounds = await nodeBox(node)
  const transform = await page.locator('.react-flow').evaluate((root) => {
    const rect = root.getBoundingClientRect()
    const viewport = root.querySelector('.react-flow__viewport')
    if (!viewport) throw new Error('Canvas viewport is missing')
    const matrix = new DOMMatrix(getComputedStyle(viewport).transform)
    return {
      left: rect.left,
      top: rect.top,
      scaleX: matrix.a,
      scaleY: matrix.d,
      x: matrix.e,
      y: matrix.f,
    }
  })
  expect(bounds.x).toBeCloseTo(
    transform.left + transform.x + x * transform.scaleX,
    0
  )
  expect(bounds.y).toBeCloseTo(
    transform.top + transform.y + y * transform.scaleY,
    0
  )
})
