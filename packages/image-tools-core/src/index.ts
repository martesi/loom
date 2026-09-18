export type AssetId = string | number

export interface AssetRef {
  id: AssetId
  name: string
  mimeType?: string
  sizeBytes?: number
}

export type ImageFormat = 'avif' | 'webp' | 'png' | 'jpeg'

export interface MediaTransform {
  format: ImageFormat
  quality?: number
  maxWidth?: number
  maxHeight?: number
}

export interface MediaTransformRequest {
  asset: AssetRef
  transform: MediaTransform
}

export interface MediaTransformResult {
  name: string
  mimeType: string
  sizeBytes?: number
}

export interface MediaTransformer {
  transform(request: MediaTransformRequest): Promise<MediaTransformResult>
}

export interface CompressionPolicy {
  transform: MediaTransform
  maxBytes?: number
}

export type CompressionMode = 'replace' | 'copy'

export interface CompressionRequest {
  assets: readonly AssetRef[]
  mode: CompressionMode
  policy: CompressionPolicy
}

export interface CompressionOutput {
  source: AssetRef
  output: AssetRef
}

export interface CompressionFailure {
  source: AssetRef
  error: string
}

export interface CompressionResult {
  outputs: readonly CompressionOutput[]
  failures: readonly CompressionFailure[]
}
