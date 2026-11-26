import type { Page } from '@playwright/test'

export type AdmissionTicket = {
  root: string
  operationId: string
  epoch: number
  kind: string
  payloadDigest: string
}

export type AdmissionRPCResponse<T> = {
  status: number
  value?: T
  text: string
}

const servicePath = 'loom/internal/service.AdmissionFacade'

export function admissionMethodID(method: string) {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(`${servicePath}.${method}`)) {
    hash = Math.imul(hash ^ byte, 0x01000193)
  }
  return hash >>> 0
}

// Calls the real Wails runtime from the loaded frontend page. Keep this helper
// profile-specific: production does not bind AdmissionFacade yet.
export async function admissionRPC<T>(
  page: Page,
  method: string,
  args: unknown[]
): Promise<AdmissionRPCResponse<T>> {
  return admissionRPCByID<T>(page, admissionMethodID(method), args)
}

export async function admissionRPCByID<T>(
  page: Page,
  methodID: number,
  args: unknown[]
): Promise<AdmissionRPCResponse<T>> {
  return page.evaluate(
    async ({ methodID, args: callArgs }) => {
      const response = await fetch('/wails/runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          object: 0,
          method: 0,
          args: {
            'call-id': crypto.randomUUID(),
            methodID,
            args: callArgs,
          },
        }),
      })
      const text = await response.text()
      let value: unknown
      try {
        value = text ? JSON.parse(text) : undefined
      } catch {
        value = undefined
      }
      return { status: response.status, value, text }
    },
    { methodID, args }
  ) as Promise<AdmissionRPCResponse<T>>
}

export function admissionPayload(action: string) {
  return Buffer.from(JSON.stringify({ action })).toString('base64')
}
