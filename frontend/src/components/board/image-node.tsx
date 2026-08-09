import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react'
import { useState } from 'react'
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from '../../lib/node-size'
import { cn } from '../../lib/utils'

export interface ImageNodeData {
  fileName: string
  thumbUrl: string
  missing: boolean
  showFileName: boolean
  onResizeEnd?: (x: number, y: number, w: number, h: number) => void
  [key: string]: unknown
}

export function ImageNode({ data, selected, width, height }: NodeProps) {
  const { fileName, thumbUrl, missing, showFileName, onResizeEnd } =
    data as unknown as ImageNodeData
  const [imgFailed, setImgFailed] = useState(false)

  const handleClassName = cn(
    '!bg-primary opacity-0 transition-opacity group-hover:opacity-100',
    selected && 'opacity-100'
  )

  return (
    <div
      style={{
        width: width ?? DEFAULT_NODE_WIDTH,
        height: height ?? DEFAULT_NODE_HEIGHT,
      }}
      className={cn(
        'group flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm',
        missing
          ? 'border-[1.5px] border-dashed border-danger opacity-90'
          : 'border-black/8',
        selected && 'ring-2 ring-primary'
      )}
    >
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
      <Handle
        type="target"
        position={Position.Left}
        className={handleClassName}
      />
      <div className={cn('relative flex-1', missing && 'grayscale')}>
        {thumbUrl && !imgFailed ? (
          <img
            src={thumbUrl}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="h-full w-full bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_10px,#E1DFDD_10px,#E1DFDD_20px)]" />
        )}
        {missing && (
          <div
            title="File not found on disk"
            className="absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-danger text-[11px] font-bold text-white"
          >
            !
          </div>
        )}
        {showFileName && (
          <div className="absolute bottom-1 right-1 max-w-[80%] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            {fileName}
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={handleClassName}
      />
    </div>
  )
}
