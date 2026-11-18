import { plural, t } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type CanvasData,
  GroupService,
  type ImageInfo,
  ImageService,
  TagService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'
import { SetComparisonDialog } from './set-comparison-dialog'

const fieldClass =
  'h-8 w-full rounded-sm border border-black/12 bg-card px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

function Section({
  title,
  children,
}: {
  title: ReactNode
  children: ReactNode
}) {
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
  commandRequest: { command: string; request: number } | null
  onAction: (id: string) => void
}
export function DetailPanel({
  path,
  data,
  selection,
  change,
  go,
  onError,
  commandRequest,
  onAction,
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
  useEffect(() => {
    if (!commandRequest) return
    const frame = requestAnimationFrame(() => {
      if (
        commandRequest.command === 'compare-set' &&
        selection.group !== null
      ) {
        setCompareGroup(selection.group)
        return
      }
      const fieldByCommand: Record<string, string> = {
        'move-rename-file': 'asset-path',
        'add-tag': 'new-tag',
        'save-prompt': 'prompt-text',
        'edit-set-name': 'set-name',
        'edit-set-kind': 'set-kind',
      }
      const field = fieldByCommand[commandRequest.command]
      if (field)
        document.querySelector<HTMLElement>(`[name="${field}"]`)?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [commandRequest, selection.group])
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
        <h2 className="text-sm font-semibold text-ink">
          <Trans>Set</Trans>
        </h2>
        <label className="grid gap-1 text-ink-muted">
          <Trans>Set name</Trans>
          <input
            className={fieldClass}
            name="set-name"
            key={`${group.id}-name-${group.name}`}
            defaultValue={group.name}
          />
        </label>
        <label className="grid gap-1 text-ink-muted">
          <Trans>Kind</Trans>
          <input
            className={fieldClass}
            name="set-kind"
            key={`${group.id}-kind-${group.kind}`}
            defaultValue={group.kind}
          />
        </label>
        <p className="text-ink-muted">
          {plural((group.memberIds ?? []).length, {
            one: '# asset',
            other: '# assets',
          })}
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={memberImages.length < 2}
          onClick={() => onAction('compare-set')}
        >
          <Trans>Compare</Trans>
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
          onClick={() => onAction('dissolve-set')}
        >
          <Trans>Dissolve set</Trans>
        </Button>
      </form>
    )
  }
  if (selection.edges.length)
    return (
      <div className="loom-detail-panel grid gap-3 overflow-auto p-3 text-xs">
        <h2 className="text-sm font-semibold text-ink">
          <Plural
            value={selection.edges.length}
            one="# relationship"
            other="# relationships"
          />
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
                onClick={() => onAction('go-to-source')}
              >
                <Trans>Go to source</Trans>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAction('go-to-derived')}
              >
                <Trans>Go to derived</Trans>
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => run(() => ImageService.UnlinkSource(path, r.id))}
              >
                <Trans>Remove relationship</Trans>
              </Button>
            </div>
          ))}
      </div>
    )
  if (!images.length)
    return (
      <p className="p-3 text-xs text-ink-muted">
        <Trans>Select an asset, set, or relationship.</Trans>
      </p>
    )
  const image = images.length === 1 ? images[0] : null
  const incoming = image
    ? (data.relationships ?? []).filter((r) => r.derivedImageId === image.id)
    : []
  const outgoing = image
    ? (data.relationships ?? []).filter((r) => r.sourceImageId === image.id)
    : []
  const relationshipSections = [
    { kind: 'sources', title: t`Sources`, relationships: incoming },
    { kind: 'derived', title: t`Derived`, relationships: outgoing },
  ] as const
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
              {image.missing ? (
                <Trans>Missing</Trans>
              ) : image.trashed ? (
                <Trans>Trashed</Trans>
              ) : image.placed ? (
                <Trans>Placed</Trans>
              ) : (
                <Trans>Unplaced</Trans>
              )}
            </p>
          </div>
          {selection.surface === 'canvas' && (
            <p className="rounded-md bg-black/[0.035] px-2 py-1.5 text-ink-muted">
              <Trans>
                Ctrl/Cmd-drag this image onto another image or set to create a
                relationship.
              </Trans>
            </p>
          )}
          <Section title={<Trans>File</Trans>}>
            <p className="break-all text-ink-muted">{image.filePath}</p>
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                onAction('move-rename-file')
              }}
            >
              <input
                className={fieldClass}
                name="asset-path"
                aria-label={t`File path`}
                defaultValue={image.fileName}
                key={`${image.id}-${image.filePath}`}
              />
              <Button
                variant="secondary"
                size="sm"
                render={<button type="submit" />}
              >
                <Trans>Move</Trans>
              </Button>
            </form>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onAction('show-in-folders')}
            >
              <Trans>Show in Folders</Trans>
            </Button>
          </Section>
        </>
      ) : (
        <strong className="text-sm text-ink">
          {plural(images.length, {
            one: '# asset selected',
            other: '# assets selected',
          })}
        </strong>
      )}
      <Section title={<Trans>Tags</Trans>}>
        <p className="text-ink-muted">
          <Trans>Common:</Trans>{' '}
          {tags.length ? tags.join(', ') : <Trans>None</Trans>}
        </p>
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            onAction('add-tag')
          }}
        >
          <input
            className={fieldClass}
            name="new-tag"
            aria-label={t`Add tag`}
            placeholder={t`Add tag`}
          />
          <Button
            variant="secondary"
            size="sm"
            render={<button type="submit" />}
          >
            <Trans>Add</Trans>
          </Button>
        </form>
      </Section>
      <Section title={<Trans>Prompt</Trans>}>
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            onAction('save-prompt')
          }}
        >
          <textarea
            className="min-h-20 w-full resize-y rounded-sm border border-black/12 bg-card p-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            name="prompt-text"
            aria-label={t`Prompt`}
            key={`prompt-${key}-${images.map((i) => i.promptText).join('|')}`}
            defaultValue={
              images.every((i) => i.promptText === images[0].promptText)
                ? images[0].promptText
                : ''
            }
            placeholder={
              images.every((i) => i.promptText === images[0].promptText)
                ? t`No prompt`
                : t`Mixed prompts — enter text to replace all`
            }
          />
          <Button
            variant="secondary"
            size="sm"
            render={<button type="submit" />}
          >
            <Trans>Save prompt</Trans>
          </Button>
        </form>
      </Section>
      <Section title={<Trans>State</Trans>}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            onAction(
              images.every((image) => image.archived)
                ? 'unarchive-selection'
                : 'archive-selection'
            )
          }
        >
          {images.every((i) => i.archived) ? (
            <Trans>Unarchive</Trans>
          ) : (
            <Trans>Archive</Trans>
          )}
        </Button>
        {images.some((i) => i.trashed) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onAction('restore-from-trash')}
          >
            <Trans>Restore from trash</Trans>
          </Button>
        )}
      </Section>
      {image &&
        relationshipSections.map(({ kind, title, relationships }) => (
          <Section key={kind} title={title}>
            {relationships.length === 0 && (
              <p className="text-ink-muted">
                <Trans>None</Trans>
              </p>
            )}
            {relationships.map((relationship) => {
              const endpointId =
                kind === 'sources'
                  ? relationship.sourceImageId
                  : relationship.derivedImageId
              return (
                <div
                  key={relationship.id}
                  className="grid gap-1.5 rounded-md border border-black/8 p-2"
                >
                  <span className="truncate text-ink">
                    {(data.images ?? []).find((i) => i.id === endpointId)
                      ?.fileName ?? `Asset ${endpointId}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => go(endpointId)}
                  >
                    <Trans>Go to</Trans>
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      run(() =>
                        ImageService.UnlinkSource(path, relationship.id)
                      )
                    }
                  >
                    <Trans>Remove relationship</Trans>
                  </Button>
                </div>
              )
            })}
          </Section>
        ))}
    </div>
  )
}
