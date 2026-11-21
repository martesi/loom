import { Dialog } from '@base-ui-components/react/dialog'
import { plural, t } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'
import { Info } from 'lucide-react'
import { type ReactNode, memo, useEffect, useRef, useState } from 'react'
import {
  type CanvasData,
  GroupService,
  type ImageInfo,
  ImageService,
  TagService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ShortcutKeys } from '../ui/tooltip'
import { SetComparisonDialog } from './set-comparison-dialog'

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
  open: boolean
  path: string
  data: CanvasData
  selection: Selection
  change: () => Promise<void>
  go: (id: number, folder?: boolean) => void
  onError: (e: unknown) => void
  commandRequest: {
    command: string
    request: number
    selectionKey: string
    pending: boolean
  } | null
  onCommandRequestHandled: (request: number) => void
  onAction: (id: string) => void
  onSubmitField: (
    id: 'move-rename-file' | 'add-tag' | 'save-prompt',
    value: string,
    imageIds: number[],
    fileName?: string,
    expected?: { owner: Selection['surface']; revision: number }
  ) => Promise<void>
  selectionRevision: number
  restoreEnabled: boolean
}
// Memoized for the same reason as LibraryPanel: stable props across
// node-drag frames skip the Inspector subtree while dragging.
export const DetailPanel = memo(function DetailPanel({
  open,
  path,
  data,
  selection,
  change,
  go,
  onError,
  commandRequest,
  onCommandRequestHandled,
  onAction,
  onSubmitField,
  restoreEnabled,
  selectionRevision,
}: Props) {
  const [imageResult, setImageResult] = useState<{
      path: string
      key: string
      images: ImageInfo[]
    }>({ path: '', key: '', images: [] }),
    [tagResult, setTagResult] = useState<{ scope: string; lists: string[][] } | null>(null),
    [promptDraft, setPromptDraft] = useState<{ scope: string; value: string; dirty: boolean } | null>(null),
    [promptConfirmation, setPromptConfirmation] = useState<{ scope: string; ids: number[]; value: string; replacing: boolean; owner: Selection['surface']; revision: number } | null>(null),
    [tagError, setTagError] = useState(''),
    [compareGroup, setCompareGroup] = useState<number | null>(null),
    [removeRelationshipId, setRemoveRelationshipId] = useState<number | null>(null)
  const key = [...selection.ids].sort((a, b) => a - b).join(',')
  const scope = `${path}\u0000${key}`
  const imageDataLoaded = imageResult.path === path && imageResult.key === key
  const images = imageDataLoaded ? imageResult.images : []
  const group = data.groups?.find((g) => g.id === selection.group)
  const errors = useRef(onError)
  const focusedCommandRequest = useRef<number | null>(null)
  const selectionFocusKey = `${selection.surface}:${key}:${selection.group ?? ''}`
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
          setImageResult({
            path,
            key,
            images: list.filter((i): i is ImageInfo => i !== null),
          })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // Settle pending focus even when the selected image cannot be loaded.
        setImageResult({ path, key, images: [] })
        errors.current(error)
      })
    return () => {
      cancelled = true
    }
  }, [path, key, data])
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry field focus after async image data mounts the editor.
  useEffect(() => {
    if (!open) return
    if (
      !commandRequest ||
      commandRequest.request === focusedCommandRequest.current
    )
      return
    if (commandRequest.selectionKey !== selectionFocusKey) {
      focusedCommandRequest.current = commandRequest.request
      onCommandRequestHandled(commandRequest.request)
      return
    }
    if (
      !group &&
      key &&
      !imageDataLoaded &&
      ['move-rename-file', 'add-tag', 'save-prompt'].includes(
        commandRequest.command
      )
    )
      return
    const frame = requestAnimationFrame(() => {
      if (!open) return
      if (
        commandRequest.command === 'compare-set' &&
        selection.group !== null
      ) {
        setCompareGroup(selection.group)
        focusedCommandRequest.current = commandRequest.request
        onCommandRequestHandled(commandRequest.request)
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
      const target = field
        ? document.querySelector<HTMLElement>(`[name="${field}"]`)
        : null
      if (target) {
        target.focus()
      }
      // Some rendered forms, such as a selected set, do not include asset fields.
      focusedCommandRequest.current = commandRequest.request
      onCommandRequestHandled(commandRequest.request)
    })
    return () => cancelAnimationFrame(frame)
  }, [
    commandRequest,
    open,
    onCommandRequestHandled,
    group,
    imageDataLoaded,
    key,
    selection.group,
    selectionFocusKey,
    images,
  ])
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
           setTagResult({ scope, lists: lists.map((list) => (list ?? []).map((tag) => tag.name)) })
      })
      .catch(errors.current)
    return () => {
      cancelled = true
    }
  }, [path, key, data])
  const tagLists = tagResult?.scope === scope ? tagResult.lists : []
  const run = (action: () => Promise<unknown>) =>
    void action().then(change).catch(errors.current)
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
        <label htmlFor="set-name-input" className="grid gap-1 text-ink-muted">
          <Trans>Set name</Trans>
          <Input
            id="set-name-input"
            name="set-name"
            key={`${group.id}-name-${group.name}`}
            defaultValue={group.name}
          />
        </label>
        <label htmlFor="set-kind-input" className="grid gap-1 text-ink-muted">
          <Trans>Kind</Trans>
          <Input
            id="set-kind-input"
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
                aria-label={t`Go to source asset ${r.sourceImageId}`}
                onClick={() => onAction('go-to-source')}
              >
                <Trans>Go to source</Trans>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t`Go to derived asset ${r.derivedImageId}`}
                onClick={() => onAction('go-to-derived')}
              >
                <Trans>Go to derived</Trans>
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setRemoveRelationshipId(r.id)}
              >
                <Trans>Remove relationship</Trans>
              </Button>
            </div>
      ))}
      </div>
    )
  if (!images.length && selection.ids.length > 0 && !imageDataLoaded)
    return (
      <p className="p-3 text-xs text-ink-muted">
        <Trans>Loading selection…</Trans>
      </p>
    )
  if (!images.length && selection.ids.length === 0)
    return (
      <div className="flex min-h-full flex-col items-center justify-center p-6 text-center text-ink-muted">
        <Info className="mb-2 h-8 w-8 text-ink-subtle/50" />
        <h3 className="mb-1 text-xs font-semibold text-ink">
          <Trans>No Selection</Trans>
        </h3>
        <p className="max-w-[200px] text-[11px] leading-relaxed text-ink-subtle">
          <Trans>
            Select an image, set, or relationship on the Canvas or in Assets to
            view metadata and links.
          </Trans>
        </p>
        <div className="mt-4 flex flex-col gap-1.5 text-[10px] text-ink-subtle">
          <div className="flex items-center gap-2">
            <ShortcutKeys shortcut="Mod+A" />
            <span>
              <Trans>Select all on active surface</Trans>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ShortcutKeys shortcut="@" />
            <span>
              <Trans>Search assets in palette</Trans>
            </span>
          </div>
        </div>
      </div>
    )
  const image = images.length === 1 ? images[0] : null
  const unavailableCount = selection.ids.length - images.length
  const tagsReady = tagResult?.scope === scope && tagLists.length === images.length
  const tagNames = [...new Set(tagLists.flat())].sort((a, b) =>
    a.localeCompare(b)
  )
  const promptValues = images.map((current) => current.promptText)
  const promptIsCommon = promptValues.every((value) => value === promptValues[0])
  const promptBaseline = promptIsCommon ? (promptValues[0] ?? '') : ''
  const activePromptDraft = promptDraft?.scope === scope ? promptDraft : null
  const promptValue = activePromptDraft?.value ?? promptBaseline
  const promptDirty = activePromptDraft?.dirty ?? false
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
                const field = event.currentTarget.elements.namedItem(
                  'asset-path'
                ) as HTMLInputElement
                void onSubmitField(
                  'move-rename-file',
                  field.value,
                  images.map((current) => current.id),
                  image?.fileName
                ).catch(errors.current)
              }}
            >
              <Input
                name="asset-path"
                aria-label={t`File path`}
                defaultValue={image.filePath.slice(path.length + 1)}
                key={`${image.id}-${image.filePath}`}
              />
              <Button
                variant="secondary"
                size="sm"
                render={<button type="submit" />}
              >
                <Trans>Move or rename</Trans>
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
          {plural(selection.ids.length, {
            one: '# asset selected',
            other: '# assets selected',
          })}
        </strong>
      )}
      {unavailableCount > 0 && (
        <p role="alert" className="text-ink-muted">
          {images.length === 0 ? <Trans>The selected assets are unavailable. Bulk edits are disabled.</Trans> : <Plural value={unavailableCount} one="# selected asset is unavailable; bulk edits are disabled." other="# selected assets are unavailable; bulk edits are disabled." />}
        </p>
      )}
      <Section title={<Trans>Tags</Trans>}>
        {tagsReady && tagNames.length > 0 ? (
          <ul aria-label={t`Tag summary`} className="grid gap-1 text-ink-muted">
            {tagNames.map((tag) => {
              const count = tagLists.filter((list) => list.includes(tag)).length
              return <li key={tag}>{tag} — {count === images.length ? <Trans>All selected assets</Trans> : <Trans>{count} of {images.length} assets</Trans>}</li>
            })}
          </ul>
        ) : (
          <p className="text-ink-muted">
            {tagsReady ? <Trans>No tags</Trans> : <Trans>Loading tag summary…</Trans>}
          </p>
        )}
        {images.length > 1 && <p className="text-ink-muted"><Plural value={images.length} one="Apply to # asset" other="Apply to # assets" /></p>}
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!imageDataLoaded || unavailableCount > 0) return
            const field = event.currentTarget.elements.namedItem(
              'new-tag'
            ) as HTMLInputElement
            const value = field.value.trim()
            if (!value) {
              setTagError(t`Enter a tag name.`)
              field.focus()
              return
            }
            setTagError('')
            void onSubmitField(
              'add-tag',
              value,
              images.map((current) => current.id)
            )
              .then(() => {
                field.value = ''
              })
              .catch(errors.current)
          }}
        >
          <Input
            name="new-tag"
            aria-label={t`Add tag`}
            placeholder={t`Add tag`}
            aria-invalid={Boolean(tagError)}
            aria-describedby={tagError ? 'tag-validation-error' : undefined}
            disabled={!imageDataLoaded || unavailableCount > 0}
          />
          <Button
            variant="secondary"
            size="sm"
            render={<button type="submit" />}
            disabled={!imageDataLoaded || unavailableCount > 0}
          >
            <Trans>Add to selected assets</Trans>
          </Button>
        </form>
        {tagError && <p id="tag-validation-error" role="alert" className="text-danger">{tagError}</p>}
      </Section>
      <Section title={<Trans>Prompt</Trans>}>
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!promptDirty || unavailableCount > 0 || !imageDataLoaded) return
            const replacing =
              images.length > 1 &&
              promptValue.length > 0 &&
              promptValues.some((value) => value !== promptValue)
            const clearing = images.length > 1 && promptValue === '' && promptValues.some(Boolean)
            if (replacing || clearing) {
              setPromptConfirmation({ scope, ids: images.map((current) => current.id), value: promptValue, replacing, owner: selection.surface, revision: selectionRevision })
              return
            }
            void onSubmitField(
              'save-prompt',
              promptValue,
              images.map((current) => current.id)
            ).then(() => {
              setPromptDraft((draft) => draft?.scope === scope ? null : draft)
            }).catch(errors.current)
          }}
        >
          <textarea
            className="min-h-20 w-full resize-y rounded-sm border border-black/12 bg-card p-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            name="prompt-text"
            aria-label={t`Prompt`}
            aria-describedby={!promptIsCommon ? 'prompt-mixed-help' : 'prompt-scope'}
            value={promptValue}
            onChange={(event) => setPromptDraft({ scope, value: event.target.value, dirty: true })}
            placeholder={
              promptIsCommon
                ? t`No prompt`
                : t`Mixed prompts — edit to replace all`
            }
            disabled={!imageDataLoaded || unavailableCount > 0}
          />
          {!promptIsCommon && <p id="prompt-mixed-help"><Trans>Mixed values. Editing and saving replaces every selected prompt.</Trans></p>}
          <p id="prompt-scope" className="text-ink-muted"><Plural value={images.length} one="Apply to # asset" other="Apply to # assets" /></p>
          <Button
            variant="secondary"
            size="sm"
            render={<button type="submit" />}
            disabled={!promptDirty || unavailableCount > 0 || !imageDataLoaded}
          >
            <Trans>Save prompt</Trans>
          </Button>
        </form>
      </Section>
      <Dialog.Root
        open={promptConfirmation !== null}
        onOpenChange={(open) => { if (!open) setPromptConfirmation(null) }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-card p-5 shadow-lg outline-none">
            <Dialog.Title className="text-sm font-semibold text-ink">
              {promptConfirmation && <Plural value={promptConfirmation.ids.length} one={promptConfirmation.replacing ? 'Replace prompts on # selected asset?' : 'Clear prompts on # selected asset?'} other={promptConfirmation.replacing ? 'Replace prompts on # selected assets?' : 'Clear prompts on # selected assets?'} />}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs text-ink-muted">
              {promptConfirmation?.replacing ? <Trans>This replaces the prompt on every selected asset.</Trans> : <Trans>This clears the prompt on every selected asset.</Trans>}
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}><Trans>Cancel</Trans></Dialog.Close>
              <Button variant="danger" size="sm" disabled={!promptConfirmation || promptConfirmation.scope !== scope || unavailableCount > 0} onClick={() => {
                const confirmation = promptConfirmation
                if (!confirmation || confirmation.scope !== scope || unavailableCount > 0) return
                if (confirmation.owner !== selection.surface || confirmation.revision !== selectionRevision) return
                setPromptConfirmation(null)
                void onSubmitField('save-prompt', confirmation.value, confirmation.ids, undefined, { owner: confirmation.owner, revision: confirmation.revision }).then(() => {
                  setPromptDraft((draft) => draft?.scope === confirmation.scope ? null : draft)
                }).catch(errors.current)
              }}>{promptConfirmation?.replacing ? <Trans>Replace prompts</Trans> : <Trans>Clear prompts</Trans>}</Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
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
            disabled={!restoreEnabled}
            onClick={() => onAction('restore-from-trash')}
          >
            <Trans>Restore from trash</Trans>
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          disabled={!imageDataLoaded || unavailableCount > 0 || images.every((item) => item.trashed)}
          onClick={() =>
            onAction(
              selection.surface === 'canvas'
                ? 'trash-canvas-selection'
                : 'trash-selection'
            )
          }
        >
          <Trans>Move to trash</Trans>
        </Button>
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
                      ?.fileName ?? <Trans>Asset {endpointId}</Trans>}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => go(endpointId)}
                  >
                    {kind === 'sources' ? <Trans>Go to source asset</Trans> : <Trans>Go to derived asset</Trans>}
                  </Button>
                  <Button variant="ghost" size="sm" aria-label={kind === 'sources' ? t`Reveal source asset ${endpointId} in Folders` : t`Reveal derived asset ${endpointId} in Folders`} onClick={() => go(endpointId, true)}>
                    <Trans>Reveal in Folders</Trans>
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    aria-label={t`Remove relationship with ${(data.images ?? []).find((i) => i.id === endpointId)?.fileName ?? t`Asset ${endpointId}`}`}
                    onClick={() => setRemoveRelationshipId(relationship.id)}
                  >
                    <Trans>Remove relationship</Trans>
                  </Button>
                </div>
              )
            })}
          </Section>
        ))}
      <Dialog.Root open={removeRelationshipId !== null} onOpenChange={(open) => { if (!open) setRemoveRelationshipId(null) }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-card p-5 shadow-lg outline-none">
            <Dialog.Title className="text-sm font-semibold text-ink"><Trans>Remove relationship?</Trans></Dialog.Title>
            <Dialog.Description className="mt-2 text-xs text-ink-muted"><Trans>Only the relationship will be removed. The assets and their metadata will remain.</Trans></Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}><Trans>Cancel</Trans></Dialog.Close>
              <Button variant="danger" size="sm" onClick={() => {
                const id = removeRelationshipId
                setRemoveRelationshipId(null)
                if (id !== null) run(() => ImageService.UnlinkSource(path, id))
              }}><Trans>Remove relationship</Trans></Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
})
