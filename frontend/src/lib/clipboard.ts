import {
  type ClipboardMedia,
  ImageService,
} from '../../bindings/loom/internal/service'
import { getCapabilities } from './capabilities-store'
import { normalizePayload } from './clipboard-payload'

const MIME = 'application/x-loom-media'
export async function copyMedia(
  path: string,
  ids: number[],
  converted: boolean
) {
  if (!getCapabilities().isServerMode)
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
  if (!getCapabilities().isServerMode)
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
