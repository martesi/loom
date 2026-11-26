import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  type AdmissionTicket,
  admissionMethodID,
  admissionPayload,
  admissionRPC,
  admissionRPCByID,
} from './admission-client'
import { expect, test } from './test-fixtures'
import { fixturePath } from './test-helpers'

const oldDiscoverCanvasMethodID = 2889814343

test('admission facade survives lost response and reload, then discovers through a ticket', async ({
  page,
  request,
}) => {
  await page.goto('/')
  const root = await fixturePath('direct-fixtures')
  const oldDatabasePath = `${root}/.loom/db.sqlite`
  await mkdir(`${root}/.loom`, { recursive: true })
  await writeFile(oldDatabasePath, new Uint8Array())
  const oldSchema = await admissionRPC<{
    databaseExists: boolean
    pending: string[]
  }>(page, 'InspectRepository', [root])
  expect(oldSchema.status).toBe(200)
  expect(oldSchema.value?.databaseExists).toBe(true)
  expect(oldSchema.value?.pending.length).toBeGreaterThan(0)

  // Fetch the actual Wails response, then drop it before the browser receives
  // it. This models a reserve that completed on the server but lost its reply.
  const lostID = randomUUID()
  const migratePayload = admissionPayload('migrate_repository')
  let lostTicket: AdmissionTicket | undefined
  const reserveID = admissionMethodID('Reserve')
  await page.route('**/wails/runtime', async (route) => {
    const call = route.request().postDataJSON() as {
      args?: { methodID?: number; args?: unknown[] }
    }
    if (call.args?.methodID === reserveID && call.args.args?.[1] === lostID) {
      const response = await route.fetch()
      expect(response.ok()).toBeTruthy()
      lostTicket = (await response.json()) as AdmissionTicket
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  await expect(
    admissionRPC<AdmissionTicket>(page, 'Reserve', [
      root,
      lostID,
      'migrate_repository',
      migratePayload,
    ])
  ).rejects.toThrow()
  await page.unroute('**/wails/runtime')
  expect(lostTicket).toBeDefined()
  if (!lostTicket)
    throw new Error('lost reserve route did not capture the response')
  await page.reload()

  const lostStatus = await admissionRPC<{ state: string }>(page, 'Status', [
    root,
    lostID,
  ])
  expect(lostStatus.status).toBe(200)
  expect(lostStatus.value?.state).toBe('reserved')
  const sealLost = await admissionRPC<void>(page, 'SealUnclaimed', [
    root,
    lostID,
  ])
  expect(sealLost.status).toBe(200)
  const delayed = await admissionRPCByID(page, admissionMethodID('Dispatch'), [
    lostTicket,
    migratePayload,
  ])
  expect(delayed.status).toBeGreaterThanOrEqual(400)
  const duplicateLost = await admissionRPC(page, 'Reserve', [
    root,
    lostID,
    'migrate_repository',
    migratePayload,
  ])
  expect(duplicateLost.status).toBeGreaterThanOrEqual(400)

  // The delayed old-schema operation was sealed. A new admitted migration
  // applies the ledger, then reconciliation observes the migrated DB read-only.
  const migrateID = randomUUID()
  const migrateTicket = await admissionRPC<AdmissionTicket>(page, 'Reserve', [
    root,
    migrateID,
    'migrate_repository',
    migratePayload,
  ])
  expect(migrateTicket.status).toBe(200)
  expect(migrateTicket.value).toBeDefined()
  if (!migrateTicket.value)
    throw new Error('migration reservation returned no ticket')
  const migrated = await admissionRPC<{ result: string }>(page, 'Dispatch', [
    migrateTicket.value,
    migratePayload,
  ])
  expect(migrated.status).toBe(200)
  expect(migrated.value?.result).toBe('migrated')
  expect(
    (await admissionRPC(page, 'Reconcile', [migrateTicket.value])).status
  ).toBe(200)
  const migratedSchema = await admissionRPC<{ pending: string[] }>(
    page,
    'InspectRepository',
    [root]
  )
  expect(migratedSchema.status, migratedSchema.text).toBe(200)
  expect(migratedSchema.value?.pending ?? []).toHaveLength(0)

  // Explicit creation is a distinct token-bearing operation. No implicit
  // Bootstrap path is exposed by this profile.
  const createRoot = await fixturePath('admission-create-fixtures')
  const createPayload = admissionPayload('create_repository')
  const createTicket = await admissionRPC<AdmissionTicket>(page, 'Reserve', [
    createRoot,
    randomUUID(),
    'create_repository',
    createPayload,
  ])
  expect(createTicket.status).toBe(200)
  if (!createTicket.value)
    throw new Error('create reservation returned no ticket')
  const created = await admissionRPC<{ result: string }>(page, 'Dispatch', [
    createTicket.value,
    createPayload,
  ])
  expect(created.status).toBe(200)
  expect(created.value?.result).toBe('created')
  expect(
    (await admissionRPC(page, 'Reconcile', [createTicket.value])).status
  ).toBe(200)

  const discoverID = randomUUID()
  const discoverPayload = admissionPayload('discover_canvas')
  const discoverTicket = await admissionRPC<AdmissionTicket>(page, 'Reserve', [
    root,
    discoverID,
    'discover_canvas',
    discoverPayload,
  ])
  expect(discoverTicket.status).toBe(200)
  if (!discoverTicket.value)
    throw new Error('discovery reservation returned no ticket')
  expect(discoverTicket.value.epoch).toBeGreaterThan(migrateTicket.value.epoch)

  // No rendition has been generated. Ordinary thumbnail/preview work is still
  // rejected while admission is reserved, but observation remains read-only.
  const rootBytes = Buffer.from(root).toString('base64url')
  const fencedPreview = await request.get(
    `/loom-asset/preview/${rootBytes}/1?w=640`
  )
  expect(fencedPreview.status()).toBe(503)
  const observedBefore = await admissionRPC<{ canvas: { images: unknown[] } }>(
    page,
    'ObserveCanvas',
    [root]
  )
  expect(observedBefore.status).toBe(200)
  expect(observedBefore.value?.canvas.images).toHaveLength(0)

  // A ticket from the prior epoch cannot enter the current operation, even if
  // it has the correct operation kind and serialized payload.
  const oldEpochDispatch = await admissionRPC(page, 'Dispatch', [
    migrateTicket.value,
    migratePayload,
  ])
  expect(oldEpochDispatch.status).toBeGreaterThanOrEqual(400)
  const preDispatchStatus = await admissionRPC<{ state: string }>(
    page,
    'Status',
    [root, discoverID]
  )
  expect(preDispatchStatus.value?.state).toBe('reserved')

  const discovered = await admissionRPC<{ result: string }>(page, 'Dispatch', [
    discoverTicket.value,
    discoverPayload,
  ])
  expect(discovered.status).toBe(200)
  expect(discovered.value?.result).toBe('discovered')
  const terminal = await admissionRPC<{ state: string }>(page, 'Status', [
    root,
    discoverID,
  ])
  expect(terminal.value?.state).toBe('terminal')
  const duplicateDispatch = await admissionRPC(page, 'Dispatch', [
    discoverTicket.value,
    discoverPayload,
  ])
  expect(duplicateDispatch.status).toBeGreaterThanOrEqual(400)
  const observedAfter = await admissionRPC<{ canvas: { images: unknown[] } }>(
    page,
    'ObserveCanvas',
    [root]
  )
  expect(observedAfter.value?.canvas.images).toHaveLength(1)
  expect(
    (await admissionRPC(page, 'Reconcile', [discoverTicket.value])).status
  ).toBe(200)

  const viewportPayload = Buffer.from(
    JSON.stringify({
      action: 'set_viewport',
      viewport: { x: 32, y: -16, zoom: 1.5 },
    })
  ).toString('base64')
  const viewportTicket = await admissionRPC<AdmissionTicket>(page, 'Reserve', [
    root,
    randomUUID(),
    'set_viewport',
    viewportPayload,
  ])
  expect(viewportTicket.status).toBe(200)
  if (!viewportTicket.value)
    throw new Error('viewport reservation returned no ticket')
  const viewportDispatch = await admissionRPC<{ result: string }>(
    page,
    'Dispatch',
    [viewportTicket.value, viewportPayload]
  )
  expect(viewportDispatch.status).toBe(200)
  expect(viewportDispatch.value?.result).toBe('updated')
  expect(
    (
      await admissionRPC(page, 'Dispatch', [
        viewportTicket.value,
        viewportPayload,
      ])
    ).status
  ).toBeGreaterThanOrEqual(400)
  expect(
    (await admissionRPC(page, 'Reconcile', [viewportTicket.value])).status
  ).toBe(200)

  const nextViewportPayload = Buffer.from(
    JSON.stringify({
      action: 'set_viewport',
      viewport: { x: 0, y: 0, zoom: 2 },
    })
  ).toString('base64')
  const nextViewportTicket = await admissionRPC<AdmissionTicket>(
    page,
    'Reserve',
    [root, randomUUID(), 'set_viewport', nextViewportPayload]
  )
  expect(nextViewportTicket.status).toBe(200)
  if (!nextViewportTicket.value)
    throw new Error('next viewport reservation returned no ticket')
  expect(
    (
      await admissionRPC(page, 'Dispatch', [
        viewportTicket.value,
        viewportPayload,
      ])
    ).status
  ).toBeGreaterThanOrEqual(400)
  const nextStatus = await admissionRPC<{ state: string }>(page, 'Status', [
    root,
    nextViewportTicket.value.operationId,
  ])
  expect(nextStatus.value?.state).toBe('reserved')
  expect(
    (await admissionRPC(page, 'Seal', [nextViewportTicket.value])).status
  ).toBe(200)

  // The test binding profile does not bind the old untagged mutation method.
  const untagged = await admissionRPCByID(page, oldDiscoverCanvasMethodID, [
    root,
  ])
  expect(untagged.status).toBeGreaterThanOrEqual(400)
})
