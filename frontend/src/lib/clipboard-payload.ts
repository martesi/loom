import type { ClipboardMedia } from '../../bindings/loom/internal/service'

export function normalizePayload(text: string): ClipboardMedia[] {
  const value: unknown = JSON.parse(text)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('media' in value) ||
    !Array.isArray(value.media)
  ) {
    throw new Error('Clipboard does not contain Loom media')
  }

  return value.media.map((item: unknown) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('name' in item) ||
      typeof item.name !== 'string' ||
      !('data' in item) ||
      typeof item.data !== 'string'
    ) {
      throw new Error('Invalid Loom clipboard item')
    }

    return { name: item.name, data: item.data }
  })
}
