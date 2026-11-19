import { z } from 'zod'

export const assetDragPayloadSchema = z.object({
  repoPath: z.string(),
  ids: z.array(z.number().int().positive().safe()).min(1),
})

export type AssetDragPayload = z.infer<typeof assetDragPayloadSchema>

export function parseAssetDragPayload(raw: string): AssetDragPayload | null {
  let value: unknown
  try {
    // why: JSON.parse throws a SyntaxError for malformed platform drag data.
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = assetDragPayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
