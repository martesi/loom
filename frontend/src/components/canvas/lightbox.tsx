import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { ChevronRight, X } from 'lucide-react'
import { useRef, useState } from 'react'
import Lightbox, { useController, type ZoomRef } from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import type { ImageInfo } from '../../../bindings/loom/internal/service'
import { Tooltip } from '../ui/tooltip'

// The library's own toolbar close button and next-nav arrow are both
// right-anchored (`right: 0`) inside the slide area — LightboxViewer's
// `paddingRight: 300px` only shrinks where the slide itself centers, it
// doesn't move those absolutely-positioned controls, so they end up sitting
// directly under (and unclickable beneath) the metadata sidebar's
// `controls` slot. Prev's arrow is left-anchored and unaffected, so only
// these two need replacing, shifted left by the sidebar's width so they
// land in the open area instead of behind it. Real components (not inline
// closures) so useController can be called at each one's own top level.
function LightboxCloseButton() {
  const { close } = useController()
  return (
    <Tooltip label={t`Close preview`} shortcut="Escape">
      <button
        type="button"
        aria-label={t`Close preview`}
        onClick={close}
        className="fixed right-[316px] top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20"
      >
        <X className="h-4 w-4" />
      </button>
    </Tooltip>
  )
}

function LightboxPreviousButton() {
  const { prev } = useController()
  return (
    <Tooltip label={t`Previous image`} shortcut="ArrowLeft">
      <button
        type="button"
        aria-label={t`Previous image`}
        onClick={() => prev()}
        className="fixed left-4 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20"
      >
        <ChevronRight className="h-5 w-5 rotate-180" />
      </button>
    </Tooltip>
  )
}

function LightboxNextButton() {
  const { next } = useController()
  return (
    <Tooltip label={t`Next image`} shortcut="ArrowRight">
      <button
        type="button"
        aria-label={t`Next image`}
        onClick={() => next()}
        className="fixed right-[316px] top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </Tooltip>
  )
}

interface LightboxViewerProps {
  images: ImageInfo[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
  tagsForImage: (imageId: number) => string[]
  placementLabel: string
  sourcesFor: (
    imageId: number
  ) => { id: number; fileName: string; thumbUrl: string }[]
  childrenFor?: (
    imageId: number
  ) => { id: number; fileName: string; thumbUrl: string }[]
  onJumpTo: (imageId: number) => void
}

// Full-res in-canvas preview (mockup section 6: dark surface, filmstrip,
// side metadata panel) — this is a daily-use path per the spec, not
// polish, so it gets a real metadata sidebar via the library's `controls`
// render slot rather than just the bare carousel.
export function LightboxViewer({
  images,
  index,
  onClose,
  onIndexChange,
  tagsForImage,
  placementLabel,
  sourcesFor,
  childrenFor = () => [],
  onJumpTo,
}: LightboxViewerProps) {
  const current = images[index]
  const [history, setHistory] = useState<number[]>([])
  const [copyStatus, setCopyStatus] = useState('')
  const zoomRef = useRef<ZoomRef>(null)

  function jumpTo(id: number) {
    if (current) setHistory((previous) => [...previous, current.id])
    setCopyStatus('')
    onJumpTo(id)
  }

  function copyImage() {
    if (!current) return
    setCopyStatus('')
    void fetch(current.fullUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Image request failed: ${response.status}`)
        return response.blob()
      })
      .then((blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]))
      .then(() => setCopyStatus(t`Image copied`))
      .catch((cause: unknown) => {
        console.warn('Could not copy preview image', cause)
        setCopyStatus(t`Could not copy image. Try downloading it instead.`)
      })
  }

  return (
    <Lightbox
      open={index >= 0}
      close={onClose}
      index={Math.max(index, 0)}
      slides={images.map((img) => ({
        src: img.fullUrl,
        alt: img.fileName,
        width: img.width || undefined,
        height: img.height || undefined,
      }))}
      on={{ view: ({ index: i }) => onIndexChange(i) }}
      plugins={[Zoom]}
      zoom={{ ref: zoomRef }}
      toolbar={{ buttons: ['close'] }}
      carousel={{ finite: false, padding: '0px', spacing: 0 }}
      styles={{
        container: { backgroundColor: '#151414', paddingRight: '300px' },
      }}
      render={{
        buttonClose: () => <LightboxCloseButton />,
        buttonPrev: () => <LightboxPreviousButton />,
        buttonNext: () => <LightboxNextButton />,
        controls: () =>
          current ? (
            <div className="pointer-events-auto fixed right-0 top-0 flex h-full w-[300px] flex-col gap-5 overflow-y-auto border-l border-white/8 bg-[#202020] p-6">
              {history.length > 0 && (
                <button type="button" className="self-start text-sm text-white" onClick={() => {
                  const id = history[history.length - 1]
                  setHistory((previous) => previous.slice(0, -1))
                  onJumpTo(id)
                }}><Trans>Back</Trans></button>
              )}
              <div className="text-[13px] font-semibold text-white/90">
                {current.fileName}
              </div>
              <div className="flex flex-wrap gap-3 text-sm text-white">
                <button type="button" onClick={() => zoomRef.current?.zoomIn()}><Trans>Zoom in</Trans></button>
                <button type="button" onClick={() => zoomRef.current?.zoomOut()}><Trans>Zoom out</Trans></button>
                <button type="button" onClick={copyImage}><Trans>Copy image</Trans></button>
                <a href={current.fullUrl} download={current.fileName}><Trans>Download</Trans></a>
              </div>
              {copyStatus && <div role="status" className="text-xs text-white">{copyStatus}</div>}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                  <Trans>Prompt</Trans>
                </div>
                <div className="text-[12px] leading-relaxed text-white/85">
                  {current.promptText || <Trans>No prompt attached</Trans>}
                </div>
              </div>
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                  <Trans>Tags</Trans>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tagsForImage(current.id).length === 0 && (
                    <span className="text-[11.5px] text-white/40">—</span>
                  )}
                  {tagsForImage(current.id).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-white/8 px-2.5 py-0.5 text-[11px] text-white/80"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              {sourcesFor(current.id).length > 0 && (
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                    <Trans>Derived from</Trans>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {sourcesFor(current.id).map((src) => (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => jumpTo(src.id)}
                        className="flex items-center gap-2 rounded hover:bg-white/5"
                      >
                        <img
                          src={src.thumbUrl}
                          alt=""
                          className="h-8 w-8 rounded object-cover"
                        />
                        <span className="text-[11.5px] text-white/70">
                          {src.fileName}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {childrenFor(current.id).length > 0 && (
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                    <Trans>Derived images</Trans>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {childrenFor(current.id).map((child) => (
                      <button key={child.id} type="button" onClick={() => jumpTo(child.id)} className="flex items-center gap-2 rounded hover:bg-white/5">
                        <img src={child.thumbUrl} alt="" className="h-8 w-8 rounded object-cover" />
                        <span className="text-[11.5px] text-white/70">{child.fileName}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                  <Trans>Placement</Trans>
                </div>
                <div className="text-[12px] text-white/85">
                  {placementLabel || <Trans>Unplaced</Trans>}
                </div>
              </div>
            </div>
          ) : null,
      }}
    />
  )
}
