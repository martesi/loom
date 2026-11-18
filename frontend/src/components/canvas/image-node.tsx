import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react'
import { Ellipsis, Eye } from 'lucide-react'
import { type MouseEvent, useState } from 'react'
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from '../../lib/node-size'
import { cn } from '../../lib/utils'

export interface ImageNodeData {
  fileName: string
  thumbUrl: string
  missing: boolean
  showFileName: boolean
  width?: number
  height?: number
  onResizeEnd?: (x: number, y: number, w: number, h: number) => void
  onPreview?: () => void
  onMore?: (event: MouseEvent<HTMLButtonElement>) => void
  [key: string]: unknown
}

export function ImageNode({ data, selected, width, height }: NodeProps) {
  const {
    fileName,
    thumbUrl,
    missing,
    showFileName,
    onResizeEnd,
    onPreview,
    onMore,
  } = data as unknown as ImageNodeData
  const [imgFailed, setImgFailed] = useState(false)
  const [naturalSize, setNaturalSize] = useState<{
    w: number
    h: number
  } | null>(null)

  const nodeData = data as unknown as ImageNodeData
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
        'group flex flex-col overflow-hidden rounded-lg bg-card border shadow-[0_1px_3px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.05)] transition-shadow duration-150 hover:shadow-[0_2px_6px_rgba(0,0,0,0.12),0_8px_20px_rgba(0,0,0,0.08)]',
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
        isVisible={selected}
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border !border-primary !bg-white"
        lineClassName="!border-primary"
        onResizeEnd={(_event, params) =>
          onResizeEnd?.(params.x, params.y, params.width, params.height)
        }
      />
      <div className={cn('relative flex-1 min-h-0', missing && 'grayscale')}>
        {thumbUrl && !imgFailed ? (
          <img
            src={thumbUrl}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
            onError={() => setImgFailed(true)}
            onLoad={(e) => {
              const img = e.currentTarget
              if (!naturalSize && img.naturalWidth && img.naturalHeight) {
                setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
              }
            }}
          />
        ) : (
          <div className="h-full w-full bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_10px,#E1DFDD_10px,#E1DFDD_20px)]" />
        )}
        {missing && (
          <div
            title={t`File not found on disk`}
            className="absolute right-1.5 top-1.5 z-20 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-danger text-[11px] font-bold text-white shadow-sm"
          >
            !
          </div>
        )}

        {/* Smooth hover HUD overlay with zero layout shift */}
        <div
          data-testid="image-node-hud"
          className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
        >
          {/* Keep drag gestures on the image while button targets opt in to pointer input. */}
          <div className="flex items-center justify-between gap-1">
            <span
              data-testid="resolution-badge"
              className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white/95 backdrop-blur-md shadow-sm border border-white/10"
            >
              {resolutionStr}
            </span>
            <div className="pointer-events-auto flex items-center gap-1">
              <button
                type="button"
                aria-label={t`Preview ${fileName}`}
                title={t`Preview`}
                data-testid="image-preview-action"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onPreview?.()
                }}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-white/15 bg-black/75 px-2 text-[10px] font-semibold text-white shadow-sm backdrop-blur-md hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Eye className="h-3 w-3" />
                <Trans>Preview</Trans>
              </button>
              <button
                type="button"
                aria-label={t`More actions for ${fileName}`}
                title={t`More actions`}
                data-testid="image-more-action"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onMore?.(event)
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/75 text-white shadow-sm backdrop-blur-md hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <Ellipsis className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Bottom row: file name */}
          {showFileName && (
            <div
              data-testid="image-node-filename"
              className="max-w-full truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white/95 backdrop-blur-md shadow-sm border border-white/10"
            >
              {fileName}
            </div>
          )}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ visibility: 'hidden' }}
      />
    </div>
  )
}
