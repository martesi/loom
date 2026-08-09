import { Trans } from '@lingui/react/macro'
import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react'
import { Layers, Star } from 'lucide-react'
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from '../../lib/node-size'
import { cn } from '../../lib/utils'

export interface GroupMember {
  id: number
  fileName: string
  thumbUrl: string
  isCover: boolean
}

export interface GroupNodeData {
  name: string
  kind: string
  coverThumbUrl: string
  members: GroupMember[]
  expanded: boolean
  focusedMemberId: number | null
  onToggleExpand: () => void
  onSetCover: (imageId: number) => void
  onRemoveMember: (imageId: number) => void
  onUngroup: () => void
  // Resizing a collapsed group card persists onto its cover image, the
  // same way the card's position is already derived from the cover's
  // canvasX/canvasY (see board.tsx's groupNodes builder) — undefined when
  // the group has no resolvable cover.
  onResizeEnd?: (x: number, y: number, w: number, h: number) => void
  [key: string]: unknown
}

// Collapsed = a stacked-card node with cover thumbnail + member-count
// badge; expanded = an inline member row + actions, per mockup section 8.
// A group node deliberately has no source Handle — it can never be the
// source of an edge (the edge<->group interaction rules require dragging
// from a specific expanded member instead).
export function GroupNode({ data, selected, width, height }: NodeProps) {
  const {
    name,
    kind,
    coverThumbUrl,
    members,
    expanded,
    focusedMemberId,
    onToggleExpand,
    onSetCover,
    onRemoveMember,
    onUngroup,
    onResizeEnd,
  } = data as unknown as GroupNodeData

  const handleClassName = cn(
    '!bg-primary opacity-0 transition-opacity group-hover:opacity-100',
    selected && 'opacity-100'
  )

  if (expanded) {
    return (
      <div className="group relative w-[280px] rounded-lg border border-black/8 bg-card p-4 shadow-lg">
        <Handle
          type="target"
          position={Position.Left}
          className={handleClassName}
        />
        <div className="mb-3 flex items-center justify-between">
          <div className="truncate text-[13px] font-semibold text-ink">
            {name || <Trans>Untitled set</Trans>}
          </div>
          <button
            type="button"
            onClick={onUngroup}
            className="shrink-0 text-[11px] font-semibold text-primary hover:underline"
          >
            <Trans>Ungroup</Trans>
          </button>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {members.map((m) => (
            <div
              key={m.id}
              className={cn(
                'flex w-[84px] flex-col gap-1',
                focusedMemberId === m.id && 'rounded-md ring-2 ring-primary'
              )}
            >
              <div className="relative h-[64px] w-[84px] overflow-hidden rounded-md border border-black/8">
                {m.thumbUrl ? (
                  <img
                    src={m.thumbUrl}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_8px,#E1DFDD_8px,#E1DFDD_16px)]" />
                )}
                {m.isCover && (
                  <div className="absolute left-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-white">
                    <Star className="h-2 w-2 fill-current" />
                  </div>
                )}
              </div>
              <div className="truncate text-[10px] text-ink-muted">
                {m.fileName}
              </div>
              <div className="flex gap-1.5">
                {!m.isCover && (
                  <button
                    type="button"
                    onClick={() => onSetCover(m.id)}
                    className="text-[9.5px] font-semibold text-primary hover:underline"
                  >
                    <Trans>Cover</Trans>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveMember(m.id)}
                  className="text-[9.5px] font-semibold text-ink-subtle hover:text-danger"
                >
                  <Trans>Remove</Trans>
                </button>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-3 border-t border-black/6 pt-2.5 text-[11.5px] font-semibold text-primary hover:underline"
        >
          <Trans>Collapse</Trans>
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onToggleExpand}
      style={{
        width: width ?? DEFAULT_NODE_WIDTH,
        height: height ?? DEFAULT_NODE_HEIGHT,
      }}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg border bg-card text-left shadow-sm',
        'border-black/8',
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
      {/* Stacked-card illusion: two offset ghost layers behind the cover. */}
      <div className="pointer-events-none absolute -right-1.5 -top-1.5 h-full w-full rounded-lg border border-black/8 bg-card" />
      <div className="pointer-events-none absolute -right-0.5 -top-0.5 h-full w-full rounded-lg border border-black/8 bg-card" />
      <div className="relative flex-1">
        {coverThumbUrl ? (
          <img
            src={coverThumbUrl}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full bg-[repeating-linear-gradient(45deg,#EDEBE9_0px,#EDEBE9_10px,#E1DFDD_10px,#E1DFDD_20px)]" />
        )}
        <div className="absolute right-1.5 top-1.5 flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-white">
          {members.length}
        </div>
        <div className="absolute bottom-1.5 right-1.5 text-white drop-shadow">
          <Layers className="h-3.5 w-3.5" />
        </div>
      </div>
      <div className="bg-card px-2 py-1.5">
        <div className="truncate text-[11px] font-semibold text-ink">
          {name || <Trans>Untitled set</Trans>}
        </div>
        <div className="truncate text-[10px] text-ink-subtle">
          {members.length} <Trans>members</Trans>
          {kind ? ` · ${kind}` : ''}
        </div>
      </div>
    </button>
  )
}
