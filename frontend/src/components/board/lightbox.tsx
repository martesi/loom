import { Trans } from '@lingui/react/macro'
import Lightbox from 'yet-another-react-lightbox'
import 'yet-another-react-lightbox/styles.css'
import type { ImageInfo } from '../../../bindings/loom/internal/service'

interface LightboxViewerProps {
  images: ImageInfo[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
  tagsForImage: (imageId: number) => string[]
  boardName: string
  sourcesFor: (
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
  boardName,
  sourcesFor,
  onJumpTo,
}: LightboxViewerProps) {
  const current = images[index]

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
      carousel={{ finite: false, padding: '0px', spacing: 0 }}
      styles={{
        container: { backgroundColor: '#151414', paddingRight: '300px' },
      }}
      render={{
        controls: () =>
          current ? (
            <div className="pointer-events-auto fixed right-0 top-0 flex h-full w-[300px] flex-col gap-5 border-l border-white/8 bg-white/4 p-6">
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
                  <div className="flex flex-col gap-1.5">
                    {sourcesFor(current.id).map((src) => (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => onJumpTo(src.id)}
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
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">
                  <Trans>Board</Trans>
                </div>
                <div className="text-[12px] text-white/85">
                  {boardName || <Trans>Unassigned</Trans>}
                </div>
              </div>
            </div>
          ) : null,
      }}
    />
  )
}
