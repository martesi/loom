import { readFile } from 'node:fs/promises'
import type {
  CanvasData,
  GroupInfo,
} from '../bindings/loom/internal/service/models'
import { legacyServiceCall } from './legacy-service'
import { expect, test } from './test-fixtures'
import {
  asset,
  fixturePath,
  imageNodes,
  nodeBox,
  openAssetsShelf,
  openFixtureRepo,
  selectImageNodes,
} from './test-helpers'

test('persisted legacy sets open as individual images and relationships', async ({
  page,
}, testInfo) => {
  const repo = 'group-fixtures'
  const names = ['group-alpha.png', 'group-beta.png', 'group-gamma.png']
  await openFixtureRepo(page, repo)
  const path = await fixturePath(repo)
  const mediaBefore = await Promise.all(
    names.map(async (name) => readFile(await fixturePath(repo, name)))
  )
  const load = () =>
    legacyServiceCall<CanvasData>(page, 'imageservice.ts', 'LoadCanvas', [path])
  const discovered = await load()
  const ids = names.map((name) => {
    const image = discovered.images?.find((item) => item.fileName === name)
    if (!image) throw new Error(`missing fixture image ${name}`)
    return image.id
  })
  const group = await legacyServiceCall<GroupInfo>(
    page,
    'groupservice.ts',
    'CreateGroup',
    [path, 'Legacy pair', 'variant', ids.slice(0, 2)]
  )
  await legacyServiceCall(page, 'imageservice.ts', 'PlaceImages', [
    path,
    ids,
    80,
    100,
    0,
  ])
  for (const target of ids.slice(1)) {
    await legacyServiceCall(page, 'imageservice.ts', 'LinkSource', [
      path,
      ids[0],
      target,
    ])
  }
  const seeded = await load()
  expect(
    seeded.groups?.find((item) => item.id === group.id)?.memberIds
  ).toEqual(ids.slice(0, 2))
  expect(seeded.relationships).toHaveLength(2)
  expect(
    seeded.relationships?.map((edge) => [
      edge.sourceImageId,
      edge.derivedImageId,
    ])
  ).toEqual([
    [ids[0], ids[1]],
    [ids[0], ids[2]],
  ])
  const edgeIDs = (seeded.relationships ?? [])
    .map((edge) => String(edge.id))
    .sort()

  // Reload starts the canvas from the persisted service data, not in-memory UI state.
  await page.reload()
  await expect(imageNodes(page)).toHaveCount(3)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await openAssetsShelf(page)
  for (const [index, name] of names.entries()) {
    await expect(asset(page, name)).toBeVisible()
    await expect(
      page.locator(`.react-flow__node-image[data-id="${ids[index]}"]`)
    ).toBeVisible()
  }
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  expect(
    (
      await page
        .locator('.react-flow__edge')
        .evaluateAll((edges) =>
          edges.map((edge) => edge.getAttribute('data-id'))
        )
    ).sort()
  ).toEqual(edgeIDs)
  await selectImageNodes(page, [0, 1])
  await expect(page.getByTestId('dock-create-set')).toHaveCount(0)
  await expect(page.getByTestId('dock-unplace')).toHaveCount(0)
  await imageNodes(page).first().click({ button: 'right' })
  await expect(
    page.getByRole('menu').getByRole('menuitem', { name: /set|group/i })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+g')
  await expect(imageNodes(page)).toHaveCount(3)
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  const source = await nodeBox(imageNodes(page).nth(2))
  const target = await nodeBox(imageNodes(page).first())
  await page.mouse.move(source.x + 30, source.y + 30)
  await page.mouse.down()
  await page.mouse.move(target.x + 30, target.y + 30, { steps: 8 })
  await expect(
    page.getByText('Release to add or move into this set')
  ).toHaveCount(0)
  await page.mouse.up()
  await expect(page.locator('.react-flow__node-group')).toHaveCount(0)
  await expect(imageNodes(page)).toHaveCount(3)
  await testInfo.attach('legacy-individual-images', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })

  const reloaded = await load()
  expect(reloaded.groups).toEqual(seeded.groups)
  expect(reloaded.relationships).toEqual(seeded.relationships)
  expect(
    await Promise.all(
      names.map(async (name) => readFile(await fixturePath(repo, name)))
    )
  ).toEqual(mediaBefore)
})
