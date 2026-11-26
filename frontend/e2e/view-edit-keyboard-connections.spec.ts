import { expect, test } from './test-fixtures'
import { imageNodes, openFixtureRepo } from './test-helpers'

async function tabTo(page: import('@playwright/test').Page, selector: string) {
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press('Tab')
    const reached = await page.evaluate((target) => {
      const active = document.activeElement
      return active instanceof Element && active.matches(target)
    }, selector)
    if (reached) return
  }
  throw new Error(`Tab did not reach ${selector}`)
}

test('D/S/R relationships work with keyboard focus and stay guarded in View', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await tabTo(page, '[data-testid="canvas-mode-edit"]')
  await page.keyboard.press('Enter')
  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(3)
  const ids = await nodes.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).dataset.id)
  )
  const nodeSelector = (id: string | undefined) =>
    `.react-flow__node[data-id="${id}"]`

  await expect(page.locator(nodeSelector(ids[0]))).toHaveAccessibleName(
    /Image.*group-alpha\.png/
  )
  await tabTo(page, nodeSelector(ids[0]))
  await page.keyboard.press('Enter')
  await expect(page.locator(nodeSelector(ids[0]))).toHaveClass(/selected/)
  await page.keyboard.press('d')
  await expect(page.getByTestId('connection-tool-status')).toContainText(
    'Focus an image or relationship, then press Enter'
  )

  // Self-target is rejected, then both valid targets are linked without a pointer.
  await tabTo(page, nodeSelector(ids[0]))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText(
    'An image cannot be related to itself'
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await tabTo(page, nodeSelector(ids[1]))
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await tabTo(page, nodeSelector(ids[2]))
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)

  // S makes a valid reverse-direction link and rejects a cycle.
  await tabTo(page, nodeSelector(ids[1]))
  await page.keyboard.press('Enter')
  await page.keyboard.press('s')
  await tabTo(page, nodeSelector(ids[2]))
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await tabTo(page, nodeSelector(ids[0]))
  await page.keyboard.press('Enter')
  await page.keyboard.press('s')
  await tabTo(page, nodeSelector(ids[1]))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText(
    'This relationship would create a cycle'
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)
  await page.keyboard.press('Escape')

  const edges = page.locator('.react-flow__edge')
  const edgeIds = await edges.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).dataset.id)
  )
  await expect(edges.first()).toHaveAccessibleName(/Edge from.*relationship/)
  await page.keyboard.press('r')
  // Reverse the newest link. It remains acyclic and is a valid target.
  await tabTo(page, `.react-flow__edge[data-id="${edgeIds[2]}"]`)
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)
  await expect(page.getByTestId('connection-tool-status')).toBeVisible()
  await page.keyboard.press('Escape')

  // The earlier source edge would create a cycle when reversed.
  await page.keyboard.press('r')
  await tabTo(page, `.react-flow__edge[data-id="${edgeIds[0]}"]`)
  const labelBefore = await page
    .locator(`.react-flow__edge[data-id="${edgeIds[0]}"]`)
    .getAttribute('aria-label')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText(
    'This relationship would create a cycle'
  )
  await expect(
    page.locator(`.react-flow__edge[data-id="${edgeIds[0]}"]`)
  ).toHaveAttribute('aria-label', labelBefore ?? '')
  await page.keyboard.press('Escape')

  // Leaving Edit cancels tools. The same shortcut cannot enable one in View.
  await tabTo(page, '[data-testid="canvas-mode-view"]')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await page.keyboard.press('d')
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await expect(page.getByTestId('dock-connect-derivative')).toHaveCount(0)
})

test('ordinary Enter selection remains available when no connection tool is active', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  const first = imageNodes(page).first()
  const id = await first.getAttribute('data-id')
  await tabTo(page, `.react-flow__node[data-id="${id}"]`)
  await page.keyboard.press('Enter')
  await expect(first).toHaveClass(/selected/)
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
})
