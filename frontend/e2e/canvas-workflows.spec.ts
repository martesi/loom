import { expect, test } from './test-fixtures'
import {
  imageNodes,
  dropAsset,
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

test('select, arrange, align, create and expand a set, then restore viewport', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
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
  await page.getByRole('menu').getByRole('button', { name: 'Select all' }).click()
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
      return Math.max(...positions.map(({ y }) => y)) -
        Math.min(...positions.map(({ y }) => y))
    })
    .toBeLessThanOrEqual(1)

  const beforeSet = await Promise.all(
    [0, 1, 2].map((index) => nodePosition(nodes.nth(index)))
  )
  const createSet = page.getByTestId('dock-create-set')
  await expect(createSet).toBeEnabled()
  await createSet.click()
  const group = page.locator('.react-flow__node-group')
  await expect(group).toHaveCount(1)
  await expect(group).toContainText('3')
  await expect(nodes).toHaveCount(0)
  await expect(group).toHaveClass(/selected/)

  await group.dblclick()
  await expect(nodes).toHaveCount(3)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  const afterExpand = await Promise.all(
    [0, 1, 2].map((index) => nodePosition(nodes.nth(index)))
  )
  for (let index = 0; index < beforeSet.length; index += 1) {
    expect(afterExpand[index].x).toBeCloseTo(beforeSet[index].x, 0)
    expect(afterExpand[index].y).toBeCloseTo(beforeSet[index].y, 0)
  }

  const viewport = page.locator('.react-flow__viewport')
  const waitForViewportSave = () => page.waitForResponse(
    (response) =>
      response.url().endsWith('/wails/runtime') &&
      response.request().postData()?.includes('"methodID":248266558') === true
  )
  const fitSaved = waitForViewportSave()
  await page.keyboard.press('Shift+1')
  await fitSaved
  const pane = page.locator('.react-flow__pane')
  const paneBox = await pane.boundingBox()
  if (!paneBox) throw new Error('Canvas pane has no bounding box')
  const panSaved = waitForViewportSave()
  await page.mouse.move(paneBox.x + 100, paneBox.y + 100)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(paneBox.x + 150, paneBox.y + 130, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await panSaved
  const transform = await viewport.getAttribute('style')
  await page.reload()
  await expect(group).toHaveCount(1)
  await expect(group).toContainText('3')
  await expect(nodes).toHaveCount(0)
  await expect(viewport).toHaveAttribute('style', transform ?? '')
  await group.dblclick()
  await expect(nodes).toHaveCount(3)
  await expect(group).toHaveCount(0)
  const afterReload = await Promise.all(
    [0, 1, 2].map((index) => nodePosition(nodes.nth(index)))
  )
  for (let index = 0; index < afterExpand.length; index += 1) {
    expect(afterReload[index].x).toBeCloseTo(afterExpand[index].x, 0)
    expect(afterReload[index].y).toBeCloseTo(afterExpand[index].y, 0)
  }
  await expect
    .poll(async () => {
      const positions = await Promise.all(
        [0, 1, 2].map((index) => nodePosition(nodes.nth(index)))
      )
      return Math.max(...positions.map(({ y }) => y)) -
        Math.min(...positions.map(({ y }) => y))
    })
    .toBeLessThanOrEqual(1)
})
