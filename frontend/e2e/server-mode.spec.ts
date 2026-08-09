import { expect, test } from '@playwright/test'

const token =
  process.env.E2E_TOKEN ?? process.env.LOOM_TOKEN ?? 'loom-e2e-token'

test('server mode authenticates and bootstraps a first board', async ({
  page,
  request,
}) => {
  const health = await request.get('/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toEqual({ status: 'ok' })

  const unauthenticated = await request.get('/')
  expect(unauthenticated.status()).toBe(401)

  const invalidToken = await request.get(
    `/?token=${encodeURIComponent('invalid-e2e-token')}`
  )
  expect(invalidToken.status()).toBe(401)

  const unauthenticatedRPC = await request.post('/wails/runtime', {
    data: { object: 0, method: 0, args: [] },
  })
  expect(unauthenticatedRPC.status()).toBe(401)

  const invalidTokenRPC = await request.post(
    '/wails/runtime?token=invalid-e2e-token',
    { data: { object: 0, method: 0, args: [] } }
  )
  expect(invalidTokenRPC.status()).toBe(401)

  await page.goto(`/?token=${encodeURIComponent(token)}`)
  await expect(page).toHaveTitle('Loom')

  const finalURL = new URL(page.url())
  expect(finalURL.pathname).toBe('/')
  expect(finalURL.searchParams.has('token')).toBe(false)

  const loomCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'loom_token'
  )
  expect(loomCookie?.value).toBe(token)
  expect(loomCookie?.httpOnly).toBe(true)

  await expect(
    page.getByRole('heading', { name: 'Welcome to Loom' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Create New Repo' }).click()

  const picker = page.getByRole('dialog')
  await expect(picker.getByText('Choose a folder')).toBeVisible()
  await expect(
    picker.getByRole('button', { name: 'e2e-repo', exact: true })
  ).toBeVisible()
  await picker.getByRole('button', { name: 'e2e-repo', exact: true }).click()
  await picker
    .getByRole('button', { name: 'Create repo here', exact: true })
    .click()

  await expect(page.getByText('No boards yet')).toBeVisible()
  await page.getByRole('button', { name: 'Create board', exact: true }).click()

  await expect(page.getByRole('button', { name: /^Board 1/ })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Library', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Explorer', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Detail', exact: true })
  ).toBeVisible()
  await expect(page.locator('.react-flow')).toBeVisible()
})
