import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react'
import { useState } from 'react'
import { cn } from '../../lib/utils'

export interface ImageNodeData {
  fileName: string
  promptText: string
  thumbUrl: string
  missing: boolean
  archived: boolean
  onResizeEnd?: (x: number, y: number, w: number, h: number) => void
  [key: string]: unknown
}

export function ImageNode({ data, selected, width, height }: NodeProps) {
  const { fileName, promptText, thumbUrl, missing, archived, onResizeEnd } =
    data as unknown as ImageNodeData
  const [imgFailed, setImgFailed] = useState(false)

  const handleClassName = cn(
    '!bg-accent opacity-0 transition-opacity group-hover:opacity-100',
    selected && 'opacity-100'
  )

  return (
    <div
      style={{ width: width ?? 150, height: height ?? 110 }}
      className={cn(
        'group flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm',
        missing
          ? 'border-[1.5px] border-dashed border-danger opacity-90'
          : 'border-black/8',
        selected && 'ring-2 ring-accent'
      )}
    >
      <NodeResizer
        minWidth={100}
        minHeight={80}
        isVisible={selected}
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border !border-accent !bg-white"
        lineClassName="!border-accent"
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
          <div className="absolute right-1.5 top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-danger text-[11px] font-bold text-white">
            !
          </div>
        )}
      </div>
      <div className="bg-card px-2 py-1.5">
        <div className="truncate text-[11px] font-semibold text-ink">
          {fileName}
        </div>
        <div
          className={cn(
            'truncate text-[10px]',
            missing ? 'text-danger' : 'text-ink-subtle'
          )}
        >
          {missing
            ? 'File not found on disk'
            : promptText || (archived ? 'Archived' : '—')}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={handleClassName}
      />
    </div>
  )
}
