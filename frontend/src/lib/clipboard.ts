import {
  type ClipboardMedia,
  ImageService,
  SystemService,
} from '../../bindings/loom/internal/service'

const MIME = 'application/x-loom-media'
export async function copyMedia(
  path: string,
  ids: number[],
  converted: boolean
) {
  if (!(await SystemService.IsServerMode()))
    return ImageService.CopyNative(path, ids, converted)
  const media = await ImageService.CopyMedia(path, ids, converted)
  if (!media?.length) return
  const payload = JSON.stringify({ version: 1, media })
  // A custom payload retains original encoding and supports multiple images.
  const entries: Record<string, Blob> = {
    'text/plain': new Blob([payload], { type: 'text/plain' }),
  }
  const custom = `web ${MIME}`
  if (ClipboardItem.supports(custom))
    entries[custom] = new Blob([payload], { type: MIME })
  await navigator.clipboard.write([new ClipboardItem(entries)])
}
export function normalizePayload(text: string): ClipboardMedia[] {
  const value: unknown = JSON.parse(text)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('media' in value) ||
    !Array.isArray(value.media)
  )
    throw new Error('Clipboard does not contain Loom media')
  return value.media.map((item: unknown) => {
    if (
      typeof item !== 'object' ||
      !item ||
      !('name' in item) ||
      typeof item.name !== 'string' ||
      !('data' in item) ||
      typeof item.data !== 'string'
    )
      throw new Error('Invalid Loom clipboard item')
    return { name: item.name, data: item.data }
  })
}
export async function filesToMedia(files: File[]): Promise<ClipboardMedia[]> {
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      data: await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      }),
    }))
  )
}
export async function readMedia(): Promise<ClipboardMedia[]> {
  if (!(await SystemService.IsServerMode()))
    return (await ImageService.ReadNative()) ?? []
  const items = await navigator.clipboard.read()
  for (const item of items) {
    for (const type of [`web ${MIME}`, 'text/plain']) {
      if (item.types.includes(type)) {
        const text = await (await item.getType(type)).text()
        try {
          return normalizePayload(text)
        } catch {
          /* Arbitrary text is never interpreted as a filesystem path. */
        }
      }
    }
  }
  const files: File[] = []
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (type)
      files.push(
        new File([await item.getType(type)], `pasted.${type.split('/')[1]}`, {
          type,
        })
      )
  }
  if (!files.length) throw new Error('Clipboard contains no media files')
  return filesToMedia(files)
}
