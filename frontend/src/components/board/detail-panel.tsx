import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardSummary,
  ImageInfo,
  RepoInfo,
  TagInfo,
} from '../../../bindings/loom/internal/service'
import {
  BoardService,
  ImageService,
  TagService,
} from '../../../bindings/loom/internal/service'
import { useToast } from '../ui/toast'

interface DetailPanelProps {
  repo: RepoInfo
  // Which image to show, or null when nothing's been selected/requested
  // yet. Owned by board.tsx (see its detailImageId state + the
  // singleSelectedImage-keyed effect that drives it).
  detailImageId: number | null
  // The currently-loaded board's images, so an image that's a member of
  // this board can be shown without a redundant round-trip — only images
  // reached via a Library/Explorer ctrl/cmd+click on something NOT on this
  // board fall back to ImageService.GetImage below.
  boardImages: ImageInfo[]
  boards: BoardSummary[]
  // Refreshes the parent's board data — called after any mutation that
  // could affect canvas/board membership (tags don't need it, board
  // add/remove does).
  onChange: () => void
}

// Detail tab content (Stage 9): the same image inspector that used to be
// board.tsx's absolutely-positioned SidePanel overlay, now a plain panel
// body — FloatingPanel already supplies the dock/backdrop/tab chrome, so
// this component only owns what's actually image-specific. Archive/Trash
// live on CanvasToolbar (which now also falls back to detailImageId when
// nothing else is selected, see board.tsx's activeSelectionImageIds) and
// "Link source" is superseded by dragging one canvas node onto another —
// both were removed from here to avoid two ways to do the same thing.
export function DetailPanel({
  repo,
  detailImageId,
  boardImages,
  boards,
  onChange,
}: DetailPanelProps) {
  const boardImage = useMemo(
    () =>
      detailImageId != null
        ? (boardImages.find((img) => img.id === detailImageId) ?? null)
        : null,
    [boardImages, detailImageId]
  )

  const toast = useToast()

  // Surfaces a rejected GetImage call (image deleted mid-flight, etc.) as a
  // toast instead of a silent unhandled rejection — same pattern used for
  // link-rejection errors on the canvas (see board.tsx's reportError / the
  // "silent link-error swallowing" fix).
  //
  // Stashed in a ref rather than passed through the fetch effect's
  // dependency array below: Base UI's useToastManager() does not return a
  // referentially stable object across renders, so a reportError that
  // depends on it is recreated every render too. Depending on it directly
  // would re-run the fetch effect (and re-fire GetImage) on every unrelated
  // re-render of this panel, not just on an actual detailImageId change —
  // the ref lets the effect always call the latest reportError without
  // needing it as a trigger.
  const reportError = useCallback(
    (title: string) => (err: unknown) => {
      toast.add({
        title,
        description: err instanceof Error ? err.message : String(err),
        type: 'danger',
      })
    },
    [toast]
  )
  const reportErrorRef = useRef(reportError)
  reportErrorRef.current = reportError

  const [fetchedImage, setFetchedImage] = useState<ImageInfo | null>(null)

  // Only fetch when the requested image isn't already sitting in the
  // loaded board's data — e.g. a ctrl/cmd+click on a Library/Explorer row
  // for an image that lives on a different board (or no board at all).
  useEffect(() => {
    if (detailImageId == null || boardImage) {
      setFetchedImage(null)
      return
    }
    // `cancelled` guards against a stale response overwriting state: if
    // detailImageId changes again (or the board catches up and boardImage
    // becomes truthy) before this fetch resolves, the cleanup below flips
    // it before the .then/.catch can touch fetchedImage — so a slow
    // response for an old id can never clobber what's showing for a newer
    // one.
    let cancelled = false
    ImageService.GetImage(repo.path, detailImageId)
      .then((img) => {
        if (!cancelled) setFetchedImage(img ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        // Clear rather than leave the previous image's data lingering —
        // otherwise a failed fetch for image A followed by a request for
        // image B could briefly (or, if B's fetch also fails, permanently)
        // keep showing A's stale detail.
        setFetchedImage(null)
        reportErrorRef.current(t`Couldn't load image`)(err)
      })
    return () => {
      cancelled = true
    }
  }, [repo.path, detailImageId, boardImage])

  const image = boardImage ?? fetchedImage

  const [tags, setTags] = useState<TagInfo[]>([])
  const [imageBoards, setImageBoards] = useState<BoardSummary[]>([])
  const [tagInput, setTagInput] = useState('')

  useEffect(() => {
    if (!image) {
      setTags([])
      setImageBoards([])
      return
    }
    TagService.TagsForImage(repo.path, image.id).then((t2) => setTags(t2 ?? []))
    BoardService.BoardsForImage(repo.path, image.id).then((b) =>
      setImageBoards(b ?? [])
    )
  }, [repo.path, image])

  if (!image) {
    return (
      <div className="p-4 text-[12.5px] text-ink-subtle">
        <Trans>
          Select a single image on the canvas, or ctrl/cmd+click a row in
          Library or Explorer, to see its details here.
        </Trans>
      </div>
    )
  }

  const addTag = async () => {
    const name = tagInput.trim()
    if (!name) return
    await TagService.AddTag(repo.path, image.id, name)
    setTagInput('')
    TagService.TagsForImage(repo.path, image.id).then((t2) => setTags(t2 ?? []))
    onChange()
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="truncate text-[13px] font-semibold text-ink">
        {image.fileName}
      </div>

      {image.missing && (
        <div className="rounded-md bg-danger-soft px-3 py-2 text-[11.5px] text-danger">
          <Trans>File not found on disk</Trans>
        </div>
      )}

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          <Trans>Prompt</Trans>
        </div>
        <div className="rounded-md bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-muted">
          {image.promptText || <Trans>No prompt attached</Trans>}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          <Trans>Tags</Trans>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={async () => {
                await TagService.RemoveTag(repo.path, image.id, tag.id)
                setTags((prev) => prev.filter((t2) => t2.id !== tag.id))
                onChange()
              }}
              title={t`Remove tag`}
              className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted hover:bg-danger-soft hover:text-danger"
            >
              {tag.name}
            </button>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            placeholder={t`+ add`}
            className="w-16 rounded-full border border-dashed border-black/18 bg-transparent px-2.5 py-0.5 text-[11px] text-ink-subtle outline-none focus:border-accent"
          />
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          <Trans>Boards</Trans>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {imageBoards.map((b) => (
            <button
              key={b.id}
              type="button"
              title={t`Remove from board`}
              onClick={async () => {
                await BoardService.RemoveImagesFromBoard(repo.path, b.id, [
                  image.id,
                ])
                onChange()
              }}
              className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] text-accent hover:bg-danger-soft hover:text-danger"
            >
              {b.name}
            </button>
          ))}
          {boards
            .filter((b) => !imageBoards.some((ib) => ib.id === b.id))
            .map((b) => (
              <button
                key={b.id}
                type="button"
                title={t`Add to board`}
                onClick={async () => {
                  await BoardService.AddImagesToBoard(repo.path, b.id, [
                    image.id,
                  ])
                  onChange()
                }}
                className="rounded-full border border-dashed border-black/18 px-2.5 py-0.5 text-[11px] text-ink-subtle hover:border-accent hover:text-accent"
              >
                + {b.name}
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}
