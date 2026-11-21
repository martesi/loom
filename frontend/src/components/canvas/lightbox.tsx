import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Info,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Lightbox, {
  useController,
  type ZoomRef,
} from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import type { ImageInfo } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'
import { Tooltip } from '../ui/tooltip'

const actionButtonClass =
  'flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/20 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent'

interface LightboxChromeProps {
  fileName: string
  fullUrl: string
  canGoBack: boolean
  canGoForward: boolean
  canStep: boolean
  infoOpen: boolean
  zoomRef: React.RefObject<ZoomRef | null>
  onHistoryBack: () => void
  onHistoryForward: () => void
  onCopy: () => void
  onToggleInfo: () => void
}

// Custom chrome rendered through the library's `controls` slot, so it lives
// inside the lightbox controller context (useController works) and above the
// slide. Close sits top-left; everything else clusters top-right; the info
// panel is opt-in via the Info toggle instead of always-on.
function LightboxChrome({
  fileName,
  fullUrl,
  canGoBack,
  canGoForward,
  canStep,
  infoOpen,
  zoomRef,
  onHistoryBack,
  onHistoryForward,
  onCopy,
  onToggleInfo,
}: LightboxChromeProps) {
  const { close, prev, next } = useController()
  return (
    <>
      <div className="pointer-events-auto fixed left-4 top-4 z-10">
        <Tooltip label={t`Close preview`} shortcut="Escape" side="bottom">
          <button
            type="button"
            data-testid="lightbox-close"
            aria-label={t`Close preview`}
            onClick={close}
            className={actionButtonClass}
          >
            <X className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <div
        data-testid="lightbox-toolbar"
        role="toolbar"
        aria-label={t`Preview actions`}
        className={cn(
          'pointer-events-auto fixed top-4 z-10 flex items-center gap-0.5 rounded-full bg-black/60 p-1 backdrop-blur transition-[right] duration-200',
          infoOpen ? 'right-[316px]' : 'right-4'
        )}
      >
        <Tooltip label={t`Back`} shortcut="Alt+ArrowLeft" side="bottom">
          <button
            type="button"
            data-testid="lightbox-history-back"
            aria-label={t`Back`}
            onClick={onHistoryBack}
            disabled={!canGoBack}
            className={actionButtonClass}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label={t`Forward`} shortcut="Alt+ArrowRight" side="bottom">
          <button
            type="button"
            data-testid="lightbox-history-forward"
            aria-label={t`Forward`}
            onClick={onHistoryForward}
            disabled={!canGoForward}
            className={actionButtonClass}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label={t`Previous image`} shortcut="ArrowLeft" side="bottom">
          <button
            type="button"
            data-testid="lightbox-prev"
            aria-label={t`Previous image`}
            onClick={() => prev()}
            disabled={!canStep}
            className={actionButtonClass}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        </Tooltip>
        <Tooltip label={t`Next image`} shortcut="ArrowRight" side="bottom">
          <button
            type="button"
            data-testid="lightbox-next"
            aria-label={t`Next image`}
            onClick={() => next()}
            disabled={!canStep}
            className={actionButtonClass}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </Tooltip>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/15" />
        <Tooltip label={t`Zoom in`} shortcut="+" side="bottom">
          <button
            type="button"
            data-testid="lightbox-zoom-in"
            aria-label={t`Zoom in`}
            onClick={() => zoomRef.current?.zoomIn()}
            className={actionButtonClass}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label={t`Zoom out`} shortcut="-" side="bottom">
          <button
            type="button"
            data-testid="lightbox-zoom-out"
            aria-label={t`Zoom out`}
            onClick={() => zoomRef.current?.zoomOut()}
            className={actionButtonClass}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label={t`Copy image`} side="bottom">
          <button
            type="button"
            data-testid="lightbox-copy"
            aria-label={t`Copy image`}
            onClick={onCopy}
            className={actionButtonClass}
          >
            <Copy className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label={t`Download`} side="bottom">
          <a
            data-testid="lightbox-download"
            aria-label={t`Download`}
            href={fullUrl}
            download={fileName}
            className={cn(actionButtonClass, 'items-center')}
          >
            <Download className="h-4 w-4" />
          </a>
        </Tooltip>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/15" />
        <Tooltip
          label={infoOpen ? t`Hide info panel` : t`Show info panel`}
          shortcut="I"
          side="bottom"
        >
          <button
            type="button"
            data-testid="lightbox-info-toggle"
            aria-label={infoOpen ? t`Hide info panel` : t`Show info panel`}
            aria-pressed={infoOpen}
            onClick={onToggleInfo}
            className={cn(actionButtonClass, infoOpen && 'bg-white/20')}
          >
            <Info className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
    </>
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
  infoOpen: boolean
  onInfoOpenChange: (open: boolean) => void
}

// Full-res in-canvas preview: dark surface, carousel, opt-in metadata panel.
// Close is top-left, actions cluster top-right, and the info panel stays
// closed until the Info toggle opens it.
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
  infoOpen,
  onInfoOpenChange,
}: LightboxViewerProps) {
  const current = images[index]
  const [history, setHistory] = useState<number[]>([])
  const [forward, setForward] = useState<number[]>([])
  const [copyStatus, setCopyStatus] = useState('')
  const zoomRef = useRef<ZoomRef>(null)
  // History jumps change the index prop from the parent, which fires the
  // library `view` event — flag them so the view handler doesn't wipe the
  // forward stack it just pushed to.
  const navigatingHistory = useRef(false)

  // 'i' toggles the info panel; Escape/arrows stay with the library.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'i' && event.key !== 'I') return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      const element = target instanceof Element ? target : null
      if (
        element?.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable=false])'
        )
      )
        return
      event.preventDefault()
      onInfoOpenChange(!infoOpen)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [infoOpen, onInfoOpenChange])

  function jumpTo(id: number) {
    if (current) setHistory((previous) => [...previous, current.id])
    setForward([])
    setCopyStatus('')
    onJumpTo(id)
  }

  function goBack() {
    if (!current || history.length === 0) return
    const id = history[history.length - 1]
    navigatingHistory.current = true
    setHistory((previous) => previous.slice(0, -1))
    setForward((previous) => [...previous, current.id])
    setCopyStatus('')
    onJumpTo(id)
  }

  function goForward() {
    if (!current || forward.length === 0) return
    const id = forward[forward.length - 1]
    navigatingHistory.current = true
    setForward((previous) => previous.slice(0, -1))
    setHistory((previous) => [...previous, current.id])
    setCopyStatus('')
    onJumpTo(id)
  }

  function handleView(i: number) {
    // Linear carousel moves invalidate redo; history jumps preserve it.
    if (navigatingHistory.current) navigatingHistory.current = false
    else if (forward.length > 0) setForward([])
    onIndexChange(i)
  }

  function copyImage() {
    if (!current) return
    setCopyStatus('')
    void fetch(current.fullUrl)
      .then((response) => {
        if (!response.ok)
          throw new Error(`Image request failed: ${response.status}`)
        return response.blob()
      })
      .then((blob) =>
        navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      )
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
      on={{ view: ({ index: i }) => handleView(i) }}
      plugins={[Zoom]}
      zoom={{ ref: zoomRef, scrollToZoom: true, maxZoomPixelRatio: 2 }}
      toolbar={{ buttons: [] }}
      carousel={{ finite: false, padding: '0px', spacing: 0 }}
      styles={{
        container: {
          backgroundColor: '#151414',
          paddingRight: infoOpen ? '300px' : '0px',
        },
      }}
      render={{
        buttonPrev: () => <></>,
        buttonNext: () => <></>,
        buttonClose: () => <></>,
        controls: () =>
          current ? (
            <>
              <LightboxChrome
                fileName={current.fileName}
                fullUrl={current.fullUrl}
                canGoBack={history.length > 0}
                canGoForward={forward.length > 0}
                canStep={images.length > 1}
                infoOpen={infoOpen}
                zoomRef={zoomRef}
                onHistoryBack={goBack}
                onHistoryForward={goForward}
                onCopy={copyImage}
                onToggleInfo={() => onInfoOpenChange(!infoOpen)}
              />
              {copyStatus && (
                <div
                  role="status"
                  className="pointer-events-none fixed bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/70 px-4 py-2 text-xs text-white"
                >
                  {copyStatus}
                </div>
              )}
              {infoOpen && (
                <aside
                  data-testid="lightbox-info-panel"
                  aria-label={t`Image info`}
                  className="pointer-events-auto fixed right-0 top-0 flex h-full w-[300px] flex-col gap-5 overflow-y-auto border-l border-white/8 bg-[#202020] p-6"
                >
                  <div className="text-[13px] font-semibold text-white/90">
                    {current.fileName}
                  </div>
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
                      <div className="flex flex-wrap gap-2">
                        {sourcesFor(current.id).map((src) => (
                          <Tooltip
                            key={src.id}
                            label={src.fileName}
                            side="bottom"
                          >
                            <button
                              type="button"
                              aria-label={src.fileName}
                              onClick={() => jumpTo(src.id)}
                              className="h-16 w-16 overflow-hidden rounded-md outline-none hover:ring-2 hover:ring-white/40 focus-visible:ring-2 focus-visible:ring-white/60"
                            >
                              <img
                                src={src.thumbUrl}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            </button>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  )}
                  {childrenFor(current.id).length > 0 && (
                    <div>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                        <Trans>Derived images</Trans>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {childrenFor(current.id).map((child) => (
                          <Tooltip
                            key={child.id}
                            label={child.fileName}
                            side="bottom"
                          >
                            <button
                              type="button"
                              aria-label={child.fileName}
                              onClick={() => jumpTo(child.id)}
                              className="h-16 w-16 overflow-hidden rounded-md outline-none hover:ring-2 hover:ring-white/40 focus-visible:ring-2 focus-visible:ring-white/60"
                            >
                              <img
                                src={child.thumbUrl}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            </button>
                          </Tooltip>
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
                </aside>
              )}
            </>
          ) : null,
      }}
    />
  )
}
