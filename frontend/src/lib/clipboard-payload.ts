import { z } from 'zod'
import type { ClipboardMedia } from '../../bindings/loom/internal/service'

const MAX_ITEMS = 100
const MAX_ITEM_BYTES = 50 * 1024 * 1024
const MAX_BATCH_BYTES = 200 * 1024 * 1024
const supportedExtensions = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
]

function isCanonicalBase64(data: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0)
    return false
  if (data.endsWith('==')) return /[AQgw]$/.test(data.slice(0, -2))
  if (data.endsWith('=')) return /[AEIMQUYcgkosw048]$/.test(data.slice(0, -1))
  return true
}

const itemSchema = z
  .object({
    name: z
      .string()
      .transform((name) => name.replace(/\\/g, '/').split('/').pop() ?? ''),
    data: z.string().min(1).refine(isCanonicalBase64),
  })
  .strict()
  .superRefine((item, ctx) => {
    const name = item.name
    const ext = name.split('.').pop()?.toLowerCase()
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      !supportedExtensions.includes(ext ?? '')
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid Loom clipboard item' })
    const bytes =
      (item.data.length * 3) / 4 -
      (item.data.endsWith('==') ? 2 : item.data.endsWith('=') ? 1 : 0)
    if (bytes === 0)
      ctx.addIssue({ code: 'custom', message: 'Invalid Loom clipboard item' })
    if (bytes > MAX_ITEM_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: 'Loom clipboard media exceeds the size limit',
      })
  })

const payloadSchema = z
  .object({
    version: z.literal(1),
    media: z.array(itemSchema).min(1).max(MAX_ITEMS),
  })
  .strict()
  .superRefine(({ media }, ctx) => {
    const total = media.reduce(
      (sum, item) =>
        sum +
        (item.data.length * 3) / 4 -
        (item.data.endsWith('==') ? 2 : item.data.endsWith('=') ? 1 : 0),
      0
    )
    if (total > MAX_BATCH_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: 'Loom clipboard media exceeds the size limit',
      })
  })

export function normalizePayload(text: string): ClipboardMedia[] {
  const value: unknown = JSON.parse(text)
  if (
    !z
      .object({ version: z.literal(1), media: z.array(z.unknown()) })
      .safeParse(value).success
  ) {
    throw new Error('Clipboard does not contain Loom media')
  }
  const parsed = payloadSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue?.message.includes('size limit')) throw new Error(issue.message)
    if (
      issue?.path[0] === 'media' &&
      (issue.code === 'too_big' || issue.code === 'too_small')
    )
      throw new Error('Invalid Loom clipboard batch size')
    throw new Error('Invalid Loom clipboard item')
  }
  return parsed.data.media as ClipboardMedia[]
}
