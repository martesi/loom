import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  dropAsset,
  fixturePath,
  imageNodes,
  openFixtureRepo,
} from './test-helpers'

async function nodePosition(node: ReturnType<typeof imageNodes>) {
  const transform = await node.evaluate(
    (element) => (element as HTMLElement).style.transform
  )
  const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
  if (!match) throw new Error(`missing node transform: ${transform}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

test('select, arrange, align individual images, then restore viewport', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  for (const [index, name] of [
    'group-alpha.png',
    'group-beta.png',
    'group-gamma.png',
  ].entries()) {
    await dropAsset(page, name, { x: 100 + index * 400, y: 120 })
  }
  const nodes = imageNodes(page)
  await page.locator('.react-flow__pane').click({
    button: 'right',
    position: { x: 1000, y: 500 },
  })
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Select all' })
    .click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3)
  await expect(page.getByTestId('dock-arrange-selection')).toBeVisible()
  await page.getByTestId('dock-arrange-selection').click()

  await expect
    .poll(async () => {
      const positions = await Promise.all(
        [0, 1, 2].map((index) => nodePosition(nodes.nth(index)))
      )
      return new Set(positions.map(({ x, y }) => `${x},${y}`)).size
    })
    .toBe(3)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3)

  await page.getByTestId('dock-align-horizontal').click()
  await expect
    .poll(async () => {
      const positions = await Promise.all(
        [0, 1, 2].map((index) => nodePosition(nodes.nth(index)))
      )
      return (
        Math.max(...positions.map(({ y }) => y)) -
        Math.min(...positions.map(({ y }) => y))
      )
    })
    .toBeLessThanOrEqual(1)

  await expect(page.getByTestId('dock-create-set')).toHaveCount(0)
  await expect(nodes).toHaveCount(3)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)

  const viewport = page.locator('.react-flow__viewport')
  const repoPath = await fixturePath('group-fixtures')
  const geometryBeforeReload = await legacyServiceCall<{
    images?: { id: number; geometry: unknown }[]
  }>(page, 'imageservice.ts', 'GetLayoutSnapshot', [repoPath])
  const authoritativeGeometry = geometryBeforeReload.images?.map((image) => [
    image.id,
    image.geometry,
  ])
  const readSavedViewport = () =>
    page.evaluate((path) => {
      const key = `loom.canvas.viewport.v1:${encodeURIComponent(path)}:edit`
      return window.localStorage.getItem(key)
    }, repoPath)
  const waitForViewportSave = (previous: string | null) =>
    page.waitForFunction(
      ({ path, previous }) => {
        const key = `loom.canvas.viewport.v1:${encodeURIComponent(path)}:edit`
        return window.localStorage.getItem(key) !== previous
      },
      { path: repoPath, previous }
    )
  const beforeFit = await readSavedViewport()
  const fitSaved = waitForViewportSave(beforeFit)
  await page.keyboard.press('Shift+1')
  await fitSaved
  const pane = page.locator('.react-flow__pane')
  const paneBox = await pane.boundingBox()
  if (!paneBox) throw new Error('Canvas pane has no bounding box')
  await pane.click({ position: { x: 20, y: 20 } })
  const beforePan = await readSavedViewport()
  const panSaved = waitForViewportSave(beforePan)
  await page.mouse.move(paneBox.x + 100, paneBox.y + 100)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(paneBox.x + 150, paneBox.y + 130, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await panSaved
  const transform = await viewport.getAttribute('style')
  const serializedSavedViewport = await readSavedViewport()
  const savedEditViewport = serializedSavedViewport
    ? JSON.parse(serializedSavedViewport)
    : null
  expect(savedEditViewport).not.toBeNull()
  await page.reload()
  const geometryAfterReload = await legacyServiceCall<{
    images?: { id: number; geometry: unknown }[]
  }>(page, 'imageservice.ts', 'GetLayoutSnapshot', [repoPath])
  expect(
    geometryAfterReload.images?.map((image) => [image.id, image.geometry])
  ).toEqual(authoritativeGeometry)
  await page.getByTestId('canvas-mode-edit').click()
  await expect(page.getByTestId('canvas-mode-edit')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(nodes).toHaveCount(3)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await expect(viewport).toHaveAttribute('style', transform ?? '')
})
