import { readFile, writeFile } from 'node:fs/promises'
import { expect, test } from './test-fixtures'
import { enterEdit, fixturePath, imageNodes, openFixtureRepo } from './test-helpers'

test('a pasted batch undo does not revive after an external replacement', async ({
  page,
  context,
  clipboardAccess: _clipboardAccess,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixtureRepo(page, 'import-empty-fixtures', { drawers: 'closed' })
  await enterEdit(page)
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  await page.evaluate(async (data) => {
    await navigator.clipboard.writeText(
      JSON.stringify({
        version: 1,
        media: [
          { name: 'batch-a.png', data },
          { name: 'batch-b.png', data },
        ],
      })
    )
  }, data)
  await page.keyboard.press('ControlOrMeta+v')
  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(2)
  const ids = await nodes.evaluateAll((elements) =>
    elements.map((node) => node.getAttribute('data-id')).sort()
  )
  const paths = await Promise.all(
    ['batch-a.png', 'batch-b.png'].map((name) =>
      fixturePath('import-empty-fixtures', name)
    )
  )
  const bytes = await Promise.all(paths.map((path) => readFile(path)))
  await page.keyboard.press('ControlOrMeta+z')
  await expect(nodes).toHaveCount(0)
  for (let index = 0; index < paths.length; index++)
    expect(await readFile(paths[index])).toEqual(bytes[index])
  const replacement = Buffer.from('external replacement after undo')
  await writeFile(paths[0], replacement)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(nodes).toHaveCount(0)
  const discoveredIds = await nodes.evaluateAll((elements) =>
    elements.map((node) => node.getAttribute('data-id'))
  )
  for (const id of ids) expect(discoveredIds).not.toContain(id)
  expect(await readFile(paths[0])).toEqual(replacement)
  expect(await readFile(paths[1])).toEqual(bytes[1])
  const redoPath = await fixturePath(
    'import-empty-fixtures',
    'batch-a (redo 1).png'
  )
  expect(await readFile(redoPath).catch(() => null)).toBeNull()
  await page.getByTestId('canvas-mode-view').click()
  await expect(nodes).toHaveCount(0)
})

test('an explicit file drop preserves a pre-existing colliding media file through history', async ({
  page,
}) => {
  await openFixtureRepo(page, 'import-empty-fixtures', { drawers: 'closed' })
  await enterEdit(page)
  const data = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  const collision = await fixturePath('import-empty-fixtures', 'drop-a.png')
  const collisionBytes = Buffer.from('pre-existing collision file')
  await writeFile(collision, collisionBytes)
  const nodes = imageNodes(page)
  await page.locator('.react-flow__pane').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle((bytes) => {
      const transfer = new DataTransfer()
      const payload = Uint8Array.from(bytes).buffer
      transfer.items.add(new File([payload], 'drop-a.png', { type: 'image/png' }))
      transfer.items.add(new File([payload], 'drop-b.png', { type: 'image/png' }))
      return transfer
    }, [...data]),
  })
  await expect(nodes).toHaveCount(3)
  const ids = await nodes.evaluateAll((elements) =>
    elements.map((node) => node.getAttribute('data-id')).sort()
  )
  const paths = await Promise.all(
    ['drop-a (1).png', 'drop-b.png'].map((name) =>
      fixturePath('import-empty-fixtures', name)
    )
  )
  const bytes = await Promise.all(paths.map((path) => readFile(path)))
  expect(await readFile(collision)).toEqual(collisionBytes)
  expect(await readFile(paths[0])).toEqual(bytes[0])
  await page.keyboard.press('ControlOrMeta+z')
  await expect(nodes).toHaveCount(1)
  expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(bytes)
  expect(await readFile(collision)).toEqual(collisionBytes)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(nodes).toHaveCount(3)
  expect(
    await nodes.evaluateAll((elements) =>
      elements.map((node) => node.getAttribute('data-id')).sort()
    )
  ).toEqual(ids)
  expect(await readFile(collision)).toEqual(collisionBytes)
  expect(await readFile(paths[0])).toEqual(bytes[0])
  await page.getByTestId('canvas-mode-view').click()
  await expect(nodes).toHaveCount(0)
})

test('file-picker import is atomic and invalid clipboard input adds no history', async ({
  page,
  context,
  clipboardAccess: _clipboardAccess,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openFixtureRepo(page, 'import-empty-fixtures', { drawers: 'closed' })
  await enterEdit(page)
  const data = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  const nodes = imageNodes(page)
  await page.locator('input[type=file]').setInputFiles([
    { name: 'picker-a.png', mimeType: 'image/png', buffer: data },
    { name: 'picker-b.png', mimeType: 'image/png', buffer: data },
  ])
  await expect(nodes).toHaveCount(2)
  const ids = await nodes.evaluateAll((elements) =>
    elements.map((node) => node.getAttribute('data-id')).sort()
  )
  await page.keyboard.press('ControlOrMeta+z')
  await expect(nodes).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(nodes).toHaveCount(2)
  expect(
    await nodes.evaluateAll((elements) =>
      elements.map((node) => node.getAttribute('data-id')).sort()
    )
  ).toEqual(ids)

  await page.evaluate(async () => navigator.clipboard.writeText('{ invalid json'))
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.getByRole('alert')).toContainText('no media files')
  await expect(nodes).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(nodes).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(nodes).toHaveCount(2)
})
