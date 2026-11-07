import { Handle, type NodeProps, Position } from '@xyflow/react'
import { cn } from '../../lib/utils'

export function GroupNode({ data, selected }: NodeProps) {
  const count = Number(data.count ?? 0)
  const name = String(data.name ?? '')
  const thumbUrl = data.thumbUrl ? String(data.thumbUrl) : ''

  return (
    <div
      data-testid="group-node-deck"
      className={cn(
        'group/deck relative h-32 w-40 select-none transition-transform duration-150',
        selected &&
          'ring-2 ring-primary ring-offset-2 ring-offset-background rounded-lg'
      )}
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

      {/* Tactile layered card deck composition */}
      {/* Bottom layer */}
      <div
        data-testid="group-deck-bottom"
        className="absolute inset-0 rounded-lg bg-card/60 border border-border -rotate-2 -translate-x-1 translate-y-1 shadow-sm pointer-events-none transition-transform duration-150"
      />

      {/* Middle layer */}
      <div
        data-testid="group-deck-middle"
        className="absolute inset-0 rounded-lg bg-card/80 border border-border rotate-2 translate-x-1 translate-y-0.5 shadow-sm pointer-events-none transition-transform duration-150"
      />

      {/* Top cover */}
      <div
        data-testid="group-deck-top"
        className="relative flex h-full w-full flex-col overflow-hidden rounded-lg bg-card border border-border shadow-md"
      >
        <div className="relative flex-1 min-h-0 bg-muted/20">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="h-full w-full bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_10px,#E1DFDD_10px,#E1DFDD_20px)]" />
          )}

          {/* Frosted glass count pill badge */}
          <div
            data-testid="group-count-badge"
            className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-md shadow-sm border border-white/10"
          >
            Set · {count} {count === 1 ? 'asset' : 'assets'}
          </div>
        </div>

        <div
          data-testid="group-name"
          className="truncate px-2 py-1.5 text-xs font-medium text-foreground"
        >
          {name} · {count}
        </div>
      </div>
    </div>
  )
}
