import { t } from '@lingui/core/macro'
import {
  Handle,
  type NodeProps,
  NodeResizer,
  Position,
  useStore,
} from '@xyflow/react'
import { memo, useEffect, useState } from 'react'
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from '../../lib/node-size'
import { previewRequestUrl, previewTierForNode } from '../../lib/preview-tier'
import { cn } from '../../lib/utils'

export interface ImageNodeData {
  fileName: string
  thumbUrl: string
  previewUrl?: string
  missing: boolean
  showFileName: boolean
  width?: number
  height?: number
  onResizeStart?: (x: number, y: number, w: number, h: number) => void
  onResizeEnd?: (x: number, y: number, w: number, h: number) => void
  [key: string]: unknown
}

export const ImageNode = memo(
  function ImageNode({ data, selected, width, height }: NodeProps) {
    const {
      fileName,
      thumbUrl,
      previewUrl,
      missing,
      showFileName,
      onResizeStart,
      onResizeEnd,
    } = data as unknown as ImageNodeData
    const [failedThumbUrl, setFailedThumbUrl] = useState<string | null>(null)
    const [naturalSize, setNaturalSize] = useState<{
      w: number
      h: number
    } | null>(null)

    const nodeData = data as unknown as ImageNodeData
    const previewKey = `${thumbUrl}\u0000${previewUrl ?? ''}`
    const [devicePixelRatio, setDevicePixelRatio] = useState(() =>
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    )
    useEffect(() => {
      const updateDevicePixelRatio = () =>
        setDevicePixelRatio(window.devicePixelRatio || 1)
      window.addEventListener('resize', updateDevicePixelRatio)
      return () => window.removeEventListener('resize', updateDevicePixelRatio)
    }, [])
    const calculatedTier = useStore((state) =>
      previewTierForNode(
        Number(width ?? DEFAULT_NODE_WIDTH),
        Number(height ?? DEFAULT_NODE_HEIGHT),
        Number(nodeData.width),
        Number(nodeData.height),
        state.transform[2],
        devicePixelRatio
      )
    )
    const [settledTier, setSettledTier] = useState<{
      key: string
      tier: 640 | 1280 | 2048 | null
    } | null>(null)
    useEffect(() => {
      const timer = window.setTimeout(
        () => setSettledTier({ key: previewKey, tier: calculatedTier }),
        120
      )
      return () => window.clearTimeout(timer)
    }, [calculatedTier, previewKey])
    const requestTier =
      settledTier?.key === previewKey ? settledTier.tier : null
    const previewSrc =
      !missing && previewUrl && requestTier
        ? previewRequestUrl(previewUrl, requestTier)
        : null
    const [previewStatus, setPreviewStatus] = useState<{
      key: string
      requestSrc: string | null
      loadedSrc?: string
      loadedBase?: string
      failures: number
      retryToken: number
    } | null>(null)
    const assetPreviewStatus =
      previewStatus?.key === previewKey ? previewStatus : null
    const requestStatus =
      assetPreviewStatus?.requestSrc === previewSrc ? assetPreviewStatus : null
    const retryFailures = requestStatus?.failures ?? 0
    useEffect(() => {
      setPreviewStatus((previous) => {
        if (previous?.key === previewKey && previous.requestSrc === previewSrc)
          return previous
        return {
          key: previewKey,
          requestSrc: previewSrc,
          loadedSrc:
            previous?.key === previewKey ? previous.loadedSrc : undefined,
          loadedBase:
            previous?.key === previewKey ? previous.loadedBase : undefined,
          failures: 0,
          retryToken: 0,
        }
      })
    }, [previewKey, previewSrc])
    useEffect(() => {
      if (!previewSrc || missing || retryFailures < 1 || retryFailures > 2)
        return
      const delay = retryFailures === 1 ? 1000 : 3000
      const timer = window.setTimeout(() => {
        setPreviewStatus((previous) => {
          if (
            previous?.key !== previewKey ||
            previous.requestSrc !== previewSrc ||
            previous.failures !== retryFailures
          )
            return previous
          return { ...previous, retryToken: retryFailures }
        })
      }, delay)
      return () => window.clearTimeout(timer)
    }, [missing, previewKey, previewSrc, retryFailures])
    const loadedPreviewSrc =
      !missing && requestTier ? assetPreviewStatus?.loadedSrc : null
    const pendingPreviewSrc =
      previewSrc &&
      requestStatus?.loadedBase !== previewSrc &&
      (requestStatus?.failures ?? 0) < 3
        ? requestStatus?.retryToken
          ? `${previewSrc}&retry=${requestStatus.retryToken}`
          : previewSrc
        : null
    const previewLayers = [
      ...(loadedPreviewSrc && loadedPreviewSrc !== pendingPreviewSrc
        ? [{ src: loadedPreviewSrc, loaded: true }]
        : []),
      ...(pendingPreviewSrc ? [{ src: pendingPreviewSrc, loaded: false }] : []),
    ]
    const imgWidth = (nodeData.width as number) || naturalSize?.w
    const imgHeight = (nodeData.height as number) || naturalSize?.h
    const resolutionStr =
      imgWidth && imgHeight
        ? `${imgWidth}×${imgHeight}`
        : `${Math.round(Number(width ?? DEFAULT_NODE_WIDTH))}×${Math.round(Number(height ?? DEFAULT_NODE_HEIGHT))}`

    return (
      <div
        data-testid="image-node-card"
        style={{
          width: width ?? DEFAULT_NODE_WIDTH,
          height: height ?? DEFAULT_NODE_HEIGHT,
        }}
        className={cn(
          'group flex flex-col rounded-lg bg-card border shadow-[0_1px_3px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.05)] transition-shadow duration-150 hover:shadow-[0_2px_6px_rgba(0,0,0,0.12),0_8px_20px_rgba(0,0,0,0.08)]',
          missing
            ? 'border-[1.5px] border-dashed border-danger opacity-90'
            : 'border-black/[0.08] dark:border-white/[0.10]',
          selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
        )}
      >
        <Handle
          type="target"
          position={Position.Left}
          style={{ visibility: 'hidden' }}
        />
        <NodeResizer
          minWidth={100}
          minHeight={80}
          isVisible={selected && data.canResize !== false}
          handleClassName="!h-2.5 !w-2.5 !rounded-sm !border !border-primary !bg-white"
          lineClassName="!border-primary"
          onResizeStart={(_event, params) =>
            onResizeStart?.(params.x, params.y, params.width, params.height)
          }
          onResizeEnd={(_event, params) =>
            onResizeEnd?.(params.x, params.y, params.width, params.height)
          }
        />
        <div className={cn('relative flex-1 min-h-0', missing && 'grayscale')}>
          {thumbUrl && failedThumbUrl !== thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              draggable={false}
              decoding="async"
              className="h-full w-full rounded-t-lg object-cover"
              onError={() => setFailedThumbUrl(thumbUrl)}
              onLoad={(e) => {
                const img = e.currentTarget
                if (
                  img.currentSrc.endsWith(thumbUrl) &&
                  !naturalSize &&
                  img.naturalWidth &&
                  img.naturalHeight
                ) {
                  setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
                }
              }}
            />
          ) : (
            <div className="h-full w-full rounded-t-lg bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_10px,#E1DFDD_10px,#E1DFDD_20px)]" />
          )}
          {previewLayers.map(({ src, loaded }) => (
            <img
              data-testid={
                loaded ? 'image-node-preview-loaded' : 'image-node-preview'
              }
              key={src}
              src={src}
              alt=""
              decoding="async"
              draggable={false}
              className={cn(
                'pointer-events-none absolute inset-0 h-full w-full rounded-t-lg object-cover transition-opacity duration-150 motion-reduce:transition-none',
                loaded ? 'opacity-100' : 'opacity-0'
              )}
              onLoad={(event) => {
                if (
                  !pendingPreviewSrc ||
                  !event.currentTarget.currentSrc.endsWith(pendingPreviewSrc)
                )
                  return
                setPreviewStatus(() => ({
                  key: previewKey,
                  requestSrc: previewSrc,
                  loadedSrc: pendingPreviewSrc,
                  loadedBase: previewSrc ?? undefined,
                  failures: 0,
                  retryToken: 0,
                }))
              }}
              onError={(event) => {
                if (
                  !pendingPreviewSrc ||
                  !event.currentTarget.currentSrc.endsWith(pendingPreviewSrc)
                )
                  return
                setPreviewStatus((previous) => {
                  const sameRequest =
                    previous?.key === previewKey &&
                    previous.requestSrc === previewSrc
                  return {
                    key: previewKey,
                    requestSrc: previewSrc,
                    loadedSrc:
                      previous?.key === previewKey
                        ? previous.loadedSrc
                        : undefined,
                    loadedBase:
                      previous?.key === previewKey
                        ? previous.loadedBase
                        : undefined,
                    failures: sameRequest ? previous.failures + 1 : 1,
                    retryToken: sameRequest ? previous.retryToken : 0,
                  }
                })
              }}
            />
          ))}
          {missing && (
            <div
              role="img"
              aria-label={t`File not found on disk`}
              className="absolute right-1.5 top-1.5 z-20 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-danger text-[11px] font-bold text-white shadow-sm"
            >
              !
            </div>
          )}

          {/* Metadata stays on the card; selection actions live in the Canvas Dock.
              invisible keeps hover-only layers out of paint entirely (no
              backdrop cost while panning); group-hover/focus-within restores
              them with the existing opacity fade. */}
          <div
            data-testid="image-node-hud"
            className="pointer-events-none absolute inset-0 z-10 invisible opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 motion-reduce:transition-none"
          >
            <div
              data-testid="image-node-metadata"
              className="absolute bottom-[calc(100%+8px)] left-0 flex max-w-[320px] flex-col items-start gap-1"
              style={{
                // Bottom-anchored element: scale about the bottom-left corner
                // so inverse-zoom growth extends upward and the 8px gap above
                // the card stays pinned instead of sliding over the image.
                transform: 'scale(var(--canvas-inverse-zoom, 1))',
                transformOrigin: 'bottom left',
              }}
            >
              <span
                data-testid="resolution-badge"
                className="canvas-resolution rounded border border-white/10 bg-black/80 px-2 py-0.5 text-[11px] font-medium tracking-tight text-white/95 shadow-sm backdrop-blur-md"
              >
                {resolutionStr}
              </span>
              {showFileName && (
                <div
                  data-testid="image-node-filename"
                  className="canvas-title max-w-[320px] truncate rounded border border-white/10 bg-black/80 px-2 py-1 text-xs font-medium text-white/95 shadow-sm backdrop-blur-md"
                >
                  {fileName}
                </div>
              )}
            </div>
          </div>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          style={{ visibility: 'hidden' }}
        />
      </div>
    )
  },
  (previous, next) =>
    previous.id === next.id &&
    previous.data === next.data &&
    previous.selected === next.selected &&
    previous.width === next.width &&
    previous.height === next.height
)
