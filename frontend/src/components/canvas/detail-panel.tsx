import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type CanvasData,
  GroupService,
  type ImageInfo,
  ImageService,
  PromptService,
  TagService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'
import { SetComparisonDialog } from './set-comparison-dialog'

const fieldClass =
  'h-8 w-full rounded-sm border border-black/12 bg-card px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-t border-black/6 pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
        {title}
      </h3>
      {children}
    </section>
  )
}

interface Props {
  path: string
  data: CanvasData
  selection: Selection
  change: () => Promise<void>
  go: (id: number, folder?: boolean) => void
  onError: (e: unknown) => void
}
export function DetailPanel({
  path,
  data,
  selection,
  change,
  go,
  onError,
}: Props) {
  const [images, setImages] = useState<ImageInfo[]>([]),
    [tags, setTags] = useState<string[]>([]),
    [compareGroup, setCompareGroup] = useState<number | null>(null)
  const key = selection.ids.join(',')
  const errors = useRef(onError)
  errors.current = onError
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      (key ? key.split(',').map(Number) : []).map((id) =>
        Promise.resolve(
          (data.images ?? []).find((i) => i.id === id) ??
            ImageService.GetImage(path, id)
        )
      )
    )
      .then((list) => {
        if (!cancelled)
          setImages(list.filter((i): i is ImageInfo => i !== null))
      })
      .catch(errors.current)
    return () => {
      cancelled = true
    }
  }, [path, key, data])
  // biome-ignore lint/correctness/useExhaustiveDependencies: data refresh invalidates metadata fetched from the repository.
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      (key ? key.split(',').map(Number) : []).map((id) =>
        TagService.TagsForImage(path, id)
      )
    )
      .then((lists) => {
        if (!cancelled)
          setTags(
            (lists[0] ?? [])
              .filter((t) =>
                lists.every((list) => list?.some((x) => x.name === t.name))
              )
              .map((t) => t.name)
          )
      })
      .catch(errors.current)
    return () => {
      cancelled = true
    }
  }, [path, key, data])
  const run = (action: () => Promise<unknown>) =>
    void action().then(change).catch(errors.current)
  const group = data.groups?.find((g) => g.id === selection.group)
  if (group) {
    const memberImages = (data.images ?? []).filter(
      (image) => (group.memberIds ?? []).includes(image.id) && !image.trashed
    )
    const saveMetadata = (form: HTMLFormElement) => {
      const name = form.elements.namedItem('set-name') as HTMLInputElement
      const kind = form.elements.namedItem('set-kind') as HTMLInputElement
      run(() =>
        GroupService.UpdateMetadata(path, group.id, name.value, kind.value)
      )
    }
    return (
      <form
        className="loom-detail-panel grid gap-3 overflow-auto p-3 text-xs"
        onBlur={(event) => {
          if (event.target instanceof HTMLInputElement)
            saveMetadata(event.currentTarget)
        }}
      >
        <h2 className="text-sm font-semibold text-ink">Set</h2>
        <label className="grid gap-1 text-ink-muted">
          Set name
          <input
            className={fieldClass}
            name="set-name"
            key={`${group.id}-name-${group.name}`}
            defaultValue={group.name}
          />
        </label>
        <label className="grid gap-1 text-ink-muted">
          Kind
          <input
            className={fieldClass}
            name="set-kind"
            key={`${group.id}-kind-${group.kind}`}
            defaultValue={group.kind}
          />
        </label>
        <p className="text-ink-muted">
          {(group.memberIds ?? []).length} assets
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={memberImages.length < 2}
          onClick={() => setCompareGroup(group.id)}
        >
          Compare
        </Button>
        <SetComparisonDialog
          open={compareGroup === group.id}
          name={group.name}
          images={memberImages}
          coverImageId={group.coverImageId}
          onClose={() => setCompareGroup(null)}
          onSetCover={(imageId) =>
            run(() => GroupService.SetCover(path, group.id, imageId))
          }
        />
        <Button
          variant="danger"
          size="sm"
          onClick={() => run(() => GroupService.Ungroup(path, group.id))}
        >
          Dissolve set
        </Button>
      </form>
    )
  }
  if (selection.edges.length)
    return (
      <div className="loom-detail-panel grid gap-3 overflow-auto p-3 text-xs">
        <h2 className="text-sm font-semibold text-ink">
          {selection.edges.length} relationship
          {selection.edges.length === 1 ? '' : 's'}
        </h2>
        {(data.relationships ?? [])
          .filter((r) => selection.edges.includes(r.id))
          .map((r) => (
            <div
              key={r.id}
              className="grid gap-1.5 rounded-md border border-black/8 p-2"
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={() => go(r.sourceImageId)}
              >
                Go to source
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => go(r.derivedImageId)}
              >
                Go to derived
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => run(() => ImageService.UnlinkSource(path, r.id))}
              >
                Remove relationship
              </Button>
            </div>
          ))}
      </div>
    )
  if (!images.length)
    return (
      <p className="p-3 text-xs text-ink-muted">
        Select an asset, set, or relationship.
      </p>
    )
  const image = images.length === 1 ? images[0] : null
  const incoming = image
    ? (data.relationships ?? []).filter((r) => r.derivedImageId === image.id)
    : []
  const outgoing = image
    ? (data.relationships ?? []).filter((r) => r.sourceImageId === image.id)
    : []
  return (
    <div className="loom-detail-panel grid gap-3 overflow-auto p-3 text-xs">
      {image ? (
        <>
          <img
            src={image.fullUrl}
            alt={image.fileName}
            className="max-h-64 w-full object-contain"
          />
          <div className="grid gap-1">
            <strong className="text-[13px] text-ink">{image.fileName}</strong>
            <p className="text-ink-muted">
              {image.width} × {image.height} ·{' '}
              {image.missing
                ? 'Missing'
                : image.trashed
                  ? 'Trashed'
                  : image.placed
                    ? 'Placed'
                    : 'Unplaced'}
            </p>
          </div>
          {selection.surface === 'canvas' && (
            <p className="rounded-md bg-black/[0.035] px-2 py-1.5 text-ink-muted">
              Ctrl/Cmd-drag this image onto another image or set to create a
              relationship.
            </p>
          )}
          <Section title="File">
            <p className="break-all text-ink-muted">{image.filePath}</p>
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                const input = event.currentTarget.elements.namedItem(
                  'asset-path'
                ) as HTMLInputElement
                const value = input.value.trim()
                if (value && value !== image.fileName)
                  run(() => ImageService.MoveFile(path, image.id, value))
              }}
            >
              <input
                className={fieldClass}
                name="asset-path"
                aria-label="File path"
                defaultValue={image.fileName}
                key={`${image.id}-${image.filePath}`}
              />
              <Button
                variant="secondary"
                size="sm"
                render={<button type="submit" />}
              >
                Move
              </Button>
            </form>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go(image.id, true)}
            >
              Show in Folders
            </Button>
          </Section>
        </>
      ) : (
        <strong className="text-sm text-ink">
          {images.length} assets selected
        </strong>
      )}
      <Section title="Tags">
        <p className="text-ink-muted">
          Common: {tags.length ? tags.join(', ') : 'None'}
        </p>
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            const input = event.currentTarget.elements.namedItem(
              'new-tag'
            ) as HTMLInputElement
            const tag = input.value.trim()
            if (!tag) return
            run(async () => {
              await Promise.all(
                images.map((i) => TagService.AddTag(path, i.id, tag))
              )
              input.value = ''
            })
          }}
        >
          <input
            className={fieldClass}
            name="new-tag"
            aria-label="Add tag"
            placeholder="Add tag"
          />
          <Button
            variant="secondary"
            size="sm"
            render={<button type="submit" />}
          >
            Add
          </Button>
        </form>
      </Section>
      <Section title="Prompt">
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            const input = event.currentTarget.elements.namedItem(
              'prompt-text'
            ) as HTMLTextAreaElement
            run(() =>
              Promise.all(
                images.map((i) =>
                  PromptService.CreateAndAttachPrompt(
                    path,
                    i.id,
                    '',
                    input.value,
                    ''
                  )
                )
              )
            )
          }}
        >
          <textarea
            className="min-h-20 w-full resize-y rounded-sm border border-black/12 bg-card p-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            name="prompt-text"
            aria-label="Prompt"
            key={`prompt-${key}-${images.map((i) => i.promptText).join('|')}`}
            defaultValue={
              images.every((i) => i.promptText === images[0].promptText)
                ? images[0].promptText
                : ''
            }
            placeholder={
              images.every((i) => i.promptText === images[0].promptText)
                ? 'No prompt'
                : 'Mixed prompts — enter text to replace all'
            }
          />
          <Button
            variant="secondary"
            size="sm"
            render={<button type="submit" />}
          >
            Save prompt
          </Button>
        </form>
      </Section>
      <Section title="State">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            run(() =>
              Promise.all(
                images.map((i) =>
                  ImageService.SetArchived(
                    path,
                    i.id,
                    !images.every((x) => x.archived)
                  )
                )
              )
            )
          }
        >
          {images.every((i) => i.archived) ? 'Unarchive' : 'Archive'}
        </Button>
        {images.some((i) => i.trashed) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              run(() =>
                Promise.all(
                  images
                    .filter((i) => i.trashed)
                    .map((i) => ImageService.RestoreImage(path, i.id))
                )
              )
            }
          >
            Restore from trash
          </Button>
        )}
      </Section>
      {image &&
        [
          ['Sources', incoming],
          ['Derived', outgoing],
        ].map(
          ([title, rels]) =>
            typeof title === 'string' &&
            Array.isArray(rels) && (
              <Section key={title} title={title}>
                {rels.length === 0 && <p className="text-ink-muted">None</p>}
                {rels.map((r) => {
                  const id =
                    title === 'Sources' ? r.sourceImageId : r.derivedImageId
                  return (
                    <div
                      key={r.id}
                      className="grid gap-1.5 rounded-md border border-black/8 p-2"
                    >
                      <span className="truncate text-ink">
                        {(data.images ?? []).find((i) => i.id === id)
                          ?.fileName ?? `Asset ${id}`}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => go(id)}>
                        Go to
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() =>
                          run(() => ImageService.UnlinkSource(path, r.id))
                        }
                      >
                        Remove relationship
                      </Button>
                    </div>
                  )
                })}
              </Section>
            )
        )}
    </div>
  )
}
