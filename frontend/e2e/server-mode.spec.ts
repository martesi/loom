import { expect, test } from '@playwright/test'

test('server mode opens a repository Canvas', async ({ page, request }) => {
  const health = await request.get('/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toEqual({ status: 'ok' })

  await page.goto('/')
  await expect(page).toHaveTitle('Loom')

  await page.getByRole('button', { name: /^(Create )?New Repo$/ }).click()

  const picker = page.getByRole('dialog')
  await expect(picker.getByText('Choose a folder')).toBeVisible()
  await expect(
    picker.getByRole('button', { name: 'e2e-repo', exact: true })
  ).toBeVisible()
  await picker.getByRole('button', { name: 'e2e-repo', exact: true }).click()
  await picker
    .getByRole('button', { name: 'Create repo here', exact: true })
    .click()

  await expect(
    page.getByRole('button', { name: 'All Assets', exact: true })
  ).toBeVisible()
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
})
