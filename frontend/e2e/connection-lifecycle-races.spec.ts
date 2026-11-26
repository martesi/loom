import type { Page } from '@playwright/test'
import { linkSourceMethodID } from './bindings'
import { expect, test } from './test-fixtures'
import { asset, imageNodes, nodeBox, openFixtureRepo } from './test-helpers'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function tabTo(page: Page, selector: string) {
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press('Tab')
    if (
      await page.evaluate(
        (target) =>
          document.activeElement instanceof Element &&
          document.activeElement.matches(target),
        selector
      )
    )
      return
  }
  throw new Error(`Tab did not reach ${selector}`)
}

async function latchFirstLink(page: Page) {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  await page.route('**/wails/runtime', async (route) => {
    if (
      !route.request().postData()?.includes(`"methodID":${linkSourceMethodID}`)
    ) {
      await route.continue()
      return
    }
    calls++
    const response = await route.fetch()
    if (calls === 1) {
      started.resolve()
      await release.promise
    }
    await route.fulfill({ response }).catch(() => undefined)
  })
  return {
    started: started.promise,
    release: () => release.resolve(),
    calls: () => calls,
  }
}

async function startKeyboardDerivative(page: Page) {
  await page.getByTestId('canvas-mode-edit').click()
  const nodes = imageNodes(page)
  await nodes.nth(0).click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('d')
  await expect(page.getByTestId('connection-tool-status')).toBeVisible()
  const id = await nodes.nth(1).getAttribute('data-id')
  if (!id) throw new Error('target node is missing its canvas ID')
  await tabTo(page, `.react-flow__node[data-id="${id}"]`)
  return nodes.nth(1)
}

test('a committed D link remains visible after Escape while its response is held', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const link = await latchFirstLink(page)
  const target = await startKeyboardDerivative(page)
  await page.keyboard.press('Enter')
  await link.started

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await expect(target).toBeFocused()
  await link.release()

  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(target).toBeFocused()
  expect(link.calls()).toBe(1)
})

test('a committed D link reconciles after selection changes without restoring old focus', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const link = await latchFirstLink(page)
  const target = await startKeyboardDerivative(page)
  await page.keyboard.press('Enter')
  await link.started

  await page.getByTestId('toggle-assets-shelf').click()
  const selectedAsset = asset(page, 'group-gamma.png')
  await selectedAsset.click()
  await expect(selectedAsset).toHaveAttribute('aria-selected', 'true')
  await selectedAsset.focus()
  await expect(selectedAsset).toBeFocused()
  await link.release()

  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(selectedAsset).toHaveAttribute('aria-selected', 'true')
  await expect(selectedAsset).toBeFocused()
  await expect(target).not.toHaveClass(/selected/)
  expect(link.calls()).toBe(1)
})

test('View waits for a dispatched D link, then displays the committed edge', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const link = await latchFirstLink(page)
  const target = await startKeyboardDerivative(page)
  await page.keyboard.press('Enter')
  await link.started

  await page.getByTestId('canvas-mode-view').click()
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await link.release()

  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(target).toBeVisible()
  expect(link.calls()).toBe(1)
})

test('View cancels a queued Ctrl-drag link behind a dispatched link', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  const nodes = imageNodes(page)
  const firstBounds = await nodeBox(nodes.nth(0))
  const secondBounds = await nodeBox(nodes.nth(1))
  const thirdBounds = await nodeBox(nodes.nth(2))
  const link = await latchFirstLink(page)

  await page.keyboard.down('Control')
  await page.mouse.move(firstBounds.x + 30, firstBounds.y + 30)
  await page.mouse.down()
  await page.mouse.move(secondBounds.x + 30, secondBounds.y + 30, {
    steps: 5,
  })
  await page.mouse.up()
  await link.started

  await page.keyboard.down('Control')
  await page.mouse.move(secondBounds.x + 30, secondBounds.y + 30)
  await page.mouse.down()
  await page.mouse.move(thirdBounds.x + 30, thirdBounds.y + 30, {
    steps: 5,
  })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await page.getByTestId('canvas-mode-view').click()
  await link.release()

  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  expect(link.calls()).toBe(1)
})

test('View requested between Ctrl-drag pointer down and up cancels the write', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  const source = await nodeBox(imageNodes(page).nth(0))
  const target = await nodeBox(imageNodes(page).nth(1))
  let calls = 0
  await page.route('**/wails/runtime', async (route) => {
    if (
      route.request().postData()?.includes(`"methodID":${linkSourceMethodID}`)
    )
      calls++
    await route.continue()
  })

  await page.keyboard.down('Control')
  await page.mouse.move(source.x + 30, source.y + 30)
  await page.mouse.down()
  await page.mouse.move(target.x + 30, target.y + 30, { steps: 5 })
  await page.getByTestId('canvas-mode-view').evaluate((button) => {
    if (!(button instanceof HTMLButtonElement))
      throw new Error('View mode control is not a button')
    button.click()
  })
  await page.mouse.up()
  await page.keyboard.up('Control')

  await expect(page.getByTestId('canvas-mode-view')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  expect(calls).toBe(0)
})

test('selection A→B→A cancels a queued D command without cancelling the dispatched link', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  const nodes = imageNodes(page)
  const boxes = await Promise.all(
    [0, 1].map((index) => nodeBox(nodes.nth(index)))
  )
  const link = await latchFirstLink(page)

  await page.keyboard.down('Control')
  await page.mouse.move(boxes[0].x + 30, boxes[0].y + 30)
  await page.mouse.down()
  await page.mouse.move(boxes[1].x + 30, boxes[1].y + 30, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await link.started

  await nodes.nth(0).click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('d')
  await nodes.nth(1).click({ position: { x: 20, y: 20 } })
  await nodes.nth(0).click({ position: { x: 20, y: 20 } })
  await link.release()

  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  expect(link.calls()).toBe(1)
})

test('a replacement owner observes a committed link after the old owner is disposed', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  const link = await latchFirstLink(page)
  const target = await startKeyboardDerivative(page)
  await page.keyboard.press('Enter')
  await link.started

  // Navigate away to dispose the in-flight owner, then reopen the same isolated
  // repository before releasing the already-committed RPC response.
  await page.goto('/')
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await link.release()
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
  await expect(target).not.toBeFocused()
  expect(link.calls()).toBe(1)
})

test('a cancelled target gesture cannot commit after the D tool is re-entered', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  const nodes = imageNodes(page)
  await nodes.nth(0).click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('d')
  const target = await nodeBox(nodes.nth(1))
  await page.mouse.move(target.x + 30, target.y + 30)
  await page.mouse.down()
  await page.keyboard.press('Escape')
  await page.keyboard.press('d')
  await page.mouse.up()
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect(page.getByTestId('connection-tool-status')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('an uncertain LinkSource response stays fenced without authoritative status', async ({
  page,
}) => {
  await openFixtureRepo(page, 'group-fixtures', { drawers: 'closed' })
  await page.getByTestId('canvas-mode-edit').click()
  let failFirst = true
  let calls = 0
  await page.route('**/wails/runtime', async (route) => {
    if (
      failFirst &&
      route.request().postData()?.includes(`"methodID":${linkSourceMethodID}`)
    ) {
      failFirst = false
      calls++
      await route.abort()
      return
    }
    await route.continue()
  })

  await startKeyboardDerivative(page)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('canvas-mutation-fence')).toBeVisible()
  await expect(page.getByTestId('canvas-mutation-fence')).toContainText(
    'outcome is unknown'
  )
  await expect(
    page.getByTestId('canvas-mutation-fence').getByRole('button')
  ).toHaveCount(0)

  await page.keyboard.press('Escape')
  await imageNodes(page)
    .nth(0)
    .click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('d')
  await expect(page.getByTestId('canvas-mutation-fence')).toBeVisible()
  await expect.poll(() => calls).toBe(1)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  await expect(page.getByTestId('connection-tool-status')).toHaveCount(0)
})
