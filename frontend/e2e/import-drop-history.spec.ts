import { access } from 'node:fs/promises'
import { expect, test } from './test-fixtures'
import { fixturePath, imageNodes, openFixtureRepo } from './test-helpers'

test('canvas file drop uses the flow point and is one undoable import', async ({
  page,
}) => {
  await openFixtureRepo(page, 'clipboard-fixtures', { drawers: 'closed' })
  const pane = page.locator('.react-flow__pane')
  const paneBox = await pane.boundingBox()
  if (!paneBox) throw new Error('Canvas pane has no bounding box')
  const drop = { x: paneBox.x + 240, y: paneBox.y + 180 }
  const filePath = await fixturePath('clipboard-fixtures', 'drop-history.png')

  await page.evaluate(({ x, y }) => {
    const target = document.querySelector('.react-flow__pane')
    if (!target) throw new Error('Canvas pane is unavailable')
    const transfer = new DataTransfer()
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      ),
      (character) => character.charCodeAt(0)
    )
    transfer.items.add(
      new File([bytes], 'drop-history.png', { type: 'image/png' })
    )
    target.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: x,
        clientY: y,
      })
    )
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: x,
        clientY: y,
      })
    )
  }, drop)

  const nodes = imageNodes(page)
  await expect(nodes).toHaveCount(1)
  const imageID = await nodes.getAttribute('data-id')
  expect(imageID).toBeTruthy()
  await access(filePath)

  const canvasTransform = await page
    .locator('.react-flow__viewport')
    .getAttribute('style')
  const match = canvasTransform?.match(
    /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\) scale\(([\d.]+)\)/
  )
  if (!match)
    throw new Error(`Canvas viewport transform missing: ${canvasTransform}`)
  const position = await nodes.evaluate((element) => {
    const transform = (element as HTMLElement).style.transform
    const values = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
    if (!values) throw new Error(`Image position missing: ${transform}`)
    return { x: Number(values[1]), y: Number(values[2]) }
  })
  const expected = {
    x: (drop.x - paneBox.x - Number(match[1])) / Number(match[3]),
    y: (drop.y - paneBox.y - Number(match[2])) / Number(match[3]),
  }
  expect(position.x).toBeCloseTo(expected.x, 0)
  expect(position.y).toBeCloseTo(expected.y, 0)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(nodes).toHaveCount(0)
  await access(filePath)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(nodes).toHaveCount(1)
  await expect(nodes).toHaveAttribute('data-id', imageID ?? '')
})
