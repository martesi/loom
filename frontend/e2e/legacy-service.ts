import type { Page } from '@playwright/test'
import { runtimeMethodID } from './bindings'

// Seed legacy persisted state through the same services used by the app.
export async function legacyServiceCall<T>(
  page: Page,
  binding: string,
  method: string,
  args: unknown[]
): Promise<T> {
  const response = await page.request.post('/wails/runtime', {
    data: {
      object: 0,
      method: 0,
      args: {
        'call-id': crypto.randomUUID(),
        methodID: Number(runtimeMethodID(binding, method)),
        args,
      },
    },
  })
  if (!response.ok()) {
    throw new Error(
      `${method} failed: ${response.status()} ${await response.text()}`
    )
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}
