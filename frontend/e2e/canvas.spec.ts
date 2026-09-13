import { expect, type Page, test } from '@playwright/test'

async function open(page: Page, name: string) {
  await page.goto('/?token=loom-e2e-token')
  await page.getByRole('button', { name: /^(Create )?New Repo$/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button').filter({ hasText: name }).first().click()
  await dialog
    .getByRole('button', { name: /^(Create repo here|Open this folder)$/ })
    .click()
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(assets(page).first()).toBeVisible()
}
function assets(page: Page) {
  return page.getByRole('listbox', { name: 'Assets' }).getByRole('option')
}
async function drop(page: Page, name: string, x: number, y: number) {
  await assets(page)
    .filter({ hasText: name })
    .dragTo(page.locator('.react-flow__pane'), { targetPosition: { x, y } })
}
function canvasNodes(page: Page) {
  return page.locator('.react-flow__node-image')
}
test('Assets selection, placement, unplace, trash and viewport persistence', async ({
  page,
}) => {
  await open(page, 'canvas-fixtures')
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  const rows = assets(page)
  await rows.first().click()
  await rows.last().click({ modifiers: ['Shift'] })
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  await page.getByRole('button', { name: 'Folders', exact: true }).click()
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(2)
  await page.getByRole('button', { name: 'All Assets', exact: true }).click()
  await drop(page, 'canvas-alpha.png', 80, 100)
  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(0)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2)
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click()
  await page.getByRole('button', { name: 'Reset 100%', exact: true }).click()
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    /scale\(1\)/
  )
  await page.getByRole('button', { name: 'Auto-arrange', exact: true }).click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(rows).toHaveCount(2)
  await rows.first().click()
  await page.keyboard.press('Delete')
  await expect(rows).toHaveCount(1)
  await drop(page, await rows.first().innerText(), 90, 90)
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await page.getByRole('button', { name: 'Fit all', exact: true }).click()
  const transform = await page
    .locator('.react-flow__viewport')
    .getAttribute('style')
  await page.reload()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    transform ?? ''
  )
})
test('explicit relationship gesture, navigation, and semantic sets', async ({
  page,
}) => {
  await open(page, 'menu-linux-fixtures')
  await drop(page, 'menu-alpha.png', 50, 100)
  await drop(page, 'menu-beta.png', 280, 200)
  await page.getByRole('button', { name: 'Reset 100%', exact: true }).click()
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    /scale\(1\)/
  )
  const nodes = canvasNodes(page)
  await page.getByRole('button', { name: 'Auto-arrange', exact: true }).click()
  await expect
    .poll(async () => {
      const first = await nodes.nth(0).boundingBox()
      const second = await nodes.nth(1).boundingBox()
      if (!first || !second) return false
      return (
        first.x + first.width <= second.x ||
        second.x + second.width <= first.x ||
        first.y + first.height <= second.y ||
        second.y + second.height <= first.y
      )
    })
    .toBe(true)
  await expect(nodes).toHaveCount(2)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect(page.locator('.react-flow__handle:visible')).toHaveCount(0)
  const a = await nodes.nth(0).boundingBox(),
    b = await nodes.nth(1).boundingBox()
  if (!a || !b) throw new Error('missing nodes')
  await page.keyboard.down('Control')
  await page.mouse.move(a.x + 40, a.y + 40)
  await page.mouse.down()
  await page.mouse.move(b.x + 40, b.y + 40, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  const source = await nodes.nth(0).boundingBox(),
    target = await nodes.nth(1).boundingBox()
  if (!source || !target) throw new Error('missing nodes')
  await page.keyboard.down('Control')
  await page.mouse.move(target.x + 40, target.y + 40)
  await page.mouse.down()
  await page.mouse.move(source.x + 40, source.y + 40, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await nodes.nth(0).click()
  await expect(page.getByRole('heading', { name: 'Derived' })).toBeVisible()
  await page.getByRole('button', { name: 'Go to', exact: true }).click()
  await expect(nodes.nth(1)).toHaveClass(/selected/)
  await page
    .getByRole('button', { name: 'Remove relationship', exact: true })
    .click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: 'Create set', exact: true }).click()
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
  await page.locator('.react-flow__node-group').dblclick()
  await expect(nodes).toHaveCount(2)
  await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
})
test('marquee selection replaces the Canvas selection', async ({ page }) => {
  await open(page, 'set-fixtures')
  await drop(page, 'set-alpha.png', 40, 100)
  await drop(page, 'set-beta.png', 280, 100)
  await drop(page, 'set-gamma.png', 520, 100)
  await page.getByRole('button', { name: 'Reset 100%', exact: true }).click()
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute(
    'style',
    /scale\(1\)/
  )
  const nodes = canvasNodes(page)
  const first = await nodes.first().boundingBox(),
    second = await nodes.nth(1).boundingBox()
  if (!first || !second) throw new Error('missing nodes')
  await page.mouse.move(first.x - 10, first.y - 10)
  await page.mouse.down()
  await page.mouse.move(
    second.x + second.width + 10,
    second.y + second.height + 10,
    {
      steps: 8,
    }
  )
  await page.mouse.up()
  await expect(nodes).toHaveCount(3)
})
test('browser import creates an unplaced asset and keeps Canvas focused behavior separate', async ({
  page,
}) => {
  await open(page, 'clipboard-fixtures')
  await page.locator('input[type=file]').setInputFiles({
    name: 'imported.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  })
  await expect(assets(page)).toHaveCount(2)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(
    assets(page).filter({ hasText: 'imported.png' })
  ).toHaveAttribute('aria-selected', 'true')
})
test('browser clipboard copies original media and paste creates fresh unplaced assets', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page, 'filename-fixtures')
  await assets(page).filter({ hasText: 'hover-target.png' }).click()
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+v')
  await expect(page.locator('[data-asset-id]')).toHaveCount(2)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(page.locator('[aria-selected=true]')).toHaveCount(1)
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('1 assets')
    void dialog.dismiss()
  })
  await page.keyboard.press('Shift+Delete')
  await expect(page.locator('[data-asset-id]')).toHaveCount(2)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.keyboard.press('Shift+Delete')
  await expect(page.locator('[data-asset-id]')).toHaveCount(1)
})
