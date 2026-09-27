import { Handle, type NodeProps, Position } from '@xyflow/react'
export function GroupNode({ data, selected }: NodeProps) {
  return (
    <div
      className={`h-32 w-40 rounded-lg border bg-card p-2 shadow-[5px_5px_0_#ddd,10px_10px_0_#eee] ${selected ? 'ring-2 ring-primary' : ''}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ visibility: 'hidden' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ visibility: 'hidden' }}
      />
      <img
        src={String(data.thumbUrl ?? '')}
        alt=""
        draggable={false}
        className="h-20 w-full rounded object-cover"
      />
      <div className="truncate text-xs">
        {String(data.name)} · {String(data.count)}
      </div>
    </div>
  )
}
