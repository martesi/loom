import { Handle, type NodeProps, Position } from '@xyflow/react'
import { useState } from 'react'
import { cn } from '../../lib/utils'

export interface ImageNodeData {
  fileName: string
  promptText: string
  thumbUrl: string
  missing: boolean
  archived: boolean
  [key: string]: unknown
}

export function ImageNode({ data, selected }: NodeProps) {
  const { fileName, promptText, thumbUrl, missing, archived } =
    data as unknown as ImageNodeData
  const [imgFailed, setImgFailed] = useState(false)

  return (
    <div
      className={cn(
        'flex h-[110px] w-[150px] flex-col overflow-hidden rounded-lg border bg-card shadow-sm',
        missing
          ? 'border-[1.5px] border-dashed border-danger opacity-90'
          : 'border-black/8',
        selected && 'ring-2 ring-accent'
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-accent" />
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
      <Handle type="source" position={Position.Right} className="!bg-accent" />
    </div>
  )
}
