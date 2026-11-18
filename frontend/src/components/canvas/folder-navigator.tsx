import { t } from '@lingui/core/macro'
import type { DragEvent } from 'react'

interface Props {
  folder: string
  dirs: string[]
  onFolderChange: (folder: string) => void
  onDropInto: (event: DragEvent, folder: string) => void
}

export function FolderNavigator({
  folder,
  dirs,
  onFolderChange,
  onDropInto,
}: Props) {
  return (
    <div className="p-2">
      <div className="mb-1 flex flex-wrap items-center gap-0.5 text-ink-muted">
        {[t`Repository`, ...folder.split('/').filter(Boolean)].map(
          (part, index, parts) => {
            const target = parts.slice(1, index + 1).join('/')
            return (
              <span key={target || 'repository'} className="flex items-center">
                {index > 0 && <span className="text-ink-subtle">/</span>}
                <button
                  type="button"
                  className="rounded-sm px-1.5 py-1 font-medium outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
                  onClick={() => onFolderChange(target)}
                  onDragOver={(event) => allowMove(event)}
                  onDrop={(event) => onDropInto(event, target)}
                >
                  {part}
                </button>
              </span>
            )
          }
        )}
      </div>
      {dirs.map((directory) => {
        const target = [folder, directory].filter(Boolean).join('/')
        return (
          <button
            className="block w-full rounded-sm px-2 py-1.5 text-left text-ink outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
            type="button"
            key={directory}
            onClick={() => onFolderChange(target)}
            onDragOver={(event) => allowMove(event)}
            onDrop={(event) => onDropInto(event, target)}
          >
            📁 {directory}
          </button>
        )
      })}
    </div>
  )
}

function allowMove(event: DragEvent) {
  if (!event.dataTransfer.types.includes('application/x-loom-assets')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}
