import { t } from '@lingui/core/macro'
import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react'
import { memo, useState } from 'react'
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
  [key: string]: unknown
}

export const ImageNode = memo(
  function ImageNode({ data, selected, width, height }: NodeProps) {
    const { fileName, thumbUrl, missing, showFileName, onResizeEnd } =
      data as unknown as ImageNodeData
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
              className="h-full w-full rounded-t-lg object-cover"
              onError={() => setImgFailed(true)}
              onLoad={(e) => {
                const img = e.currentTarget
                if (!naturalSize && img.naturalWidth && img.naturalHeight) {
                  setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
                }
              }}
            />
          ) : (
            <div className="h-full w-full rounded-t-lg bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_10px,#E1DFDD_10px,#E1DFDD_20px)]" />
          )}
          {missing && (
            <div
              role="img"
              aria-label={t`File not found on disk`}
              className="absolute right-1.5 top-1.5 z-20 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-danger text-[11px] font-bold text-white shadow-sm"
            >
              !
            </div>
          )}

          {/* Metadata stays on the card; selection actions live in the Canvas Dock. */}
          <div
            data-testid="image-node-hud"
            className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
          >
            <div
              data-testid="image-node-metadata"
              className="absolute left-2 top-2 flex max-w-[320px] flex-col items-start gap-1"
              style={{
                transform: 'scale(var(--canvas-inverse-zoom, 1))',
                transformOrigin: 'top left',
              }}
            >
              <span
                data-testid="resolution-badge"
                className="rounded border border-white/10 bg-black/80 px-2 py-0.5 text-[11px] font-medium tracking-tight text-white/95 shadow-sm backdrop-blur-md"
              >
                {resolutionStr}
              </span>
              {showFileName && (
                <div
                  data-testid="image-node-filename"
                  className="max-w-[320px] truncate rounded border border-white/10 bg-black/80 px-2 py-1 text-xs font-medium text-white/95 shadow-sm backdrop-blur-md"
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
