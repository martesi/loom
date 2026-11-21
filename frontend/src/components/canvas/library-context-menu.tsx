import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { LibraryRow } from '../../../bindings/loom/internal/service'

export interface AssetContextMenuState {
  x: number
  y: number
  assetIds: number[]
}

interface Props {
  menu: AssetContextMenuState | null
  mode: string
  rows: LibraryRow[]
  onClose: () => void
  onRename: (id: number, name: string) => void
  onCompress: (ids: number[]) => void
  onShowCommands: () => void
}

const fieldClass =
  'h-8 w-full rounded-sm border border-black/12 bg-card px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

export function LibraryContextMenu({
  menu,
  mode,
  rows,
  onClose,
  onRename,
  onCompress,
  onShowCommands,
}: Props) {
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(
    null
  )

  useEffect(() => {
    if (!menu) return
    const clickOutside = (event: MouseEvent) => {
      if (
        event
          .composedPath()
          .some(
            (node) =>
              node instanceof Element && node.getAttribute('role') === 'menu'
          )
      )
        return
      onClose()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('click', clickOutside)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('click', clickOutside)
      window.removeEventListener('keydown', keydown)
    }
  }, [menu, onClose])

  if (!menu) return null
  return (
    <div
      role="menu"
      className="fixed z-50 min-w-44 rounded-lg border border-black/8 bg-card p-1.5 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
    >
      {renaming ? (
        <form
          className="grid w-56 gap-1.5 p-1"
          onSubmit={(event) => {
            event.preventDefault()
            onRename(renaming.id, renaming.name.trim())
            setRenaming(null)
            onClose()
          }}
        >
          <label
            htmlFor="rename-file"
            className="text-[11px] font-semibold text-ink-muted"
          >
            <Trans>Rename file</Trans>
          </label>
          <input
            id="rename-file"
            name="rename-file"
            aria-label={t`Rename file`}
            value={renaming.name}
            className={fieldClass}
            onChange={(event) =>
              setRenaming({ ...renaming, name: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setRenaming(null)
              }
            }}
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              className="rounded-sm px-2 py-1.5 text-[12px] text-ink-muted hover:bg-black/[0.04]"
              onClick={() => setRenaming(null)}
            >
              <Trans>Cancel</Trans>
            </button>
            <button
              type="submit"
              className="rounded-sm bg-primary px-2 py-1.5 text-[12px] font-semibold text-white"
            >
              <Trans>Rename</Trans>
            </button>
          </div>
        </form>
      ) : (
        <>
          {mode === 'folders' && menu.assetIds.length === 1 && (
            <button
              type="button"
              className="block w-full rounded-md px-3 py-2 text-left text-[12.5px] text-ink hover:bg-black/[0.04]"
              onClick={() => {
                const row = rows.find((item) => item.id === menu.assetIds[0])
                if (row) setRenaming({ id: row.id, name: row.fileName })
              }}
            >
              <Trans>Rename…</Trans>
            </button>
          )}
          <button
            type="button"
            className="block w-full rounded-md px-3 py-2 text-left text-[12.5px] text-ink hover:bg-black/[0.04]"
            onClick={() => {
              onClose()
              onCompress(menu.assetIds)
            }}
          >
            <Trans>Compress…</Trans>
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-md px-3 py-2 text-left text-[12.5px] text-ink hover:bg-black/[0.04]"
            onClick={() => {
              onClose()
              requestAnimationFrame(onShowCommands)
            }}
          >
            <Trans>Show commands</Trans>
          </button>
        </>
      )}
    </div>
  )
}
