export function previewTierForNode(
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
  dpr: number
): 640 | 1280 | 2048 | null {
  if (
    ![width, height, sourceWidth, sourceHeight, zoom, dpr].every(
      Number.isFinite
    ) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  )
    return null
  const required = Math.min(
    Math.max(width, height * (sourceWidth / sourceHeight)) * zoom * dpr,
    sourceWidth
  )
  if (required <= 320) return null
  return required <= 640 ? 640 : required <= 1280 ? 1280 : 2048
}

export function previewRequestUrl(
  url: string,
  tier: 640 | 1280 | 2048
): string {
  return `${url}&w=${tier}`
}

export function renditionGenerationUrl(
  url: string,
  generation: number
): string {
  if (!url || generation <= 0) return url
  const revisioned = new URL(url, 'http://loom.invalid')
  revisioned.searchParams.set('ui', String(generation))
  return `${revisioned.pathname}${revisioned.search}${revisioned.hash}`
}
