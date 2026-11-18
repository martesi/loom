import { Dialog } from '@base-ui-components/react/dialog'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ImageInfo } from '../../../bindings/loom/internal/service'

interface Props {
  open: boolean
  name: string
  images: ImageInfo[]
  coverImageId: number
  onClose: () => void
  onSetCover: (imageId: number) => void
}

export function SetComparisonDialog({
  open,
  name,
  images,
  coverImageId,
  onClose,
  onSetCover,
}: Props) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const drag = useRef<{
    x: number
    y: number
    panX: number
    panY: number
  } | null>(null)

  useEffect(() => {
    if (open) setView({ zoom: 1, x: 0, y: 0 })
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Popup className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#151414] text-white shadow-2xl outline-none">
          <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
            <div className="min-w-48 flex-1">
              <Dialog.Title className="truncate text-sm font-semibold">
                {name ? (
                  <Trans>Compare {name}</Trans>
                ) : (
                  <Trans>Compare set</Trans>
                )}
              </Dialog.Title>
              <Dialog.Description className="text-xs text-white/50">
                <Trans>
                  Drag any image to pan all views. Zoom applies to every
                  variant.
                </Trans>
              </Dialog.Description>
            </div>
            <button
              type="button"
              aria-label={t`Zoom out`}
              onClick={() =>
                setView((current) => ({
                  ...current,
                  zoom: Math.max(0.5, current.zoom - 0.25),
                }))
              }
              className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
            >
              −
            </button>
            <span className="w-12 text-center text-xs text-white/60">
              {Math.round(view.zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label={t`Zoom in`}
              onClick={() =>
                setView((current) => ({
                  ...current,
                  zoom: Math.min(4, current.zoom + 0.25),
                }))
              }
              className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
              className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
            >
              <Trans>Reset</Trans>
            </button>
            <Dialog.Close
              aria-label={t`Close comparison`}
              className="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-auto bg-white/10 md:grid-cols-2 xl:grid-cols-3">
            {images.map((image) => (
              <article
                key={image.id}
                aria-label={image.fileName}
                className="flex min-h-[320px] flex-col bg-[#151414]"
              >
                <div className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-white/80">
                    {image.fileName}
                  </span>
                  {image.id === coverImageId ? (
                    <span className="rounded bg-white/10 px-2 py-1 text-white/70">
                      <Trans>Cover</Trans>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSetCover(image.id)}
                      className="rounded border border-white/15 px-2 py-1 text-white/70 hover:bg-white/10"
                    >
                      <Trans>Use as cover</Trans>
                    </button>
                  )}
                </div>
                <div
                  className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-black/20 active:cursor-grabbing"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    drag.current = {
                      x: event.clientX,
                      y: event.clientY,
                      panX: view.x,
                      panY: view.y,
                    }
                  }}
                  onPointerMove={(event) => {
                    const start = drag.current
                    if (!start) return
                    setView((current) => ({
                      ...current,
                      x: start.panX + event.clientX - start.x,
                      y: start.panY + event.clientY - start.y,
                    }))
                  }}
                  onPointerUp={() => {
                    drag.current = null
                  }}
                  onPointerCancel={() => {
                    drag.current = null
                  }}
                >
                  <img
                    src={image.fullUrl}
                    alt={image.fileName}
                    draggable={false}
                    className="h-full w-full select-none object-contain"
                    style={{
                      transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                    }}
                  />
                </div>
              </article>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
