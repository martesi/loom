import { plural, t } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'
import { Info } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import {
  type CanvasData,
  type ImageInfo,
  ImageService,
  TagService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'
import { ShortcutKeys } from '../ui/tooltip'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { enqueueCanvasMutation } from './canvas-mutation-queue'
import { DetailPanelDialogs } from './detail-panel-dialogs'
import { DetailPanelFields } from './detail-panel-fields'
import { DetailPanelRelations } from './detail-panel-relations'

interface Props {
  owner: CanvasBoardOwner
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
  canMutateRelationships?: () => boolean
  graphOrder?: number[]
}
// Memoized for the same reason as LibraryPanel: stable props across
// node-drag frames skip the Inspector subtree while dragging.
export const DetailPanel = memo(function DetailPanel({
  owner,
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
  canMutateRelationships = () => true,
  graphOrder,
}: Props) {
  const [imageResult, setImageResult] = useState<{
      path: string
      key: string
      images: ImageInfo[]
    }>({ path: '', key: '', images: [] }),
    [tagResult, setTagResult] = useState<{
      scope: string
      lists: string[][]
    } | null>(null),
    [promptDraft, setPromptDraft] = useState<{
      scope: string
      value: string
      dirty: boolean
    } | null>(null),
    [promptConfirmation, setPromptConfirmation] = useState<{
      scope: string
      ids: number[]
      value: string
      replacing: boolean
      owner: Selection['surface']
      revision: number
    } | null>(null),
    [tagError, setTagError] = useState(''),
    [removeRelationshipId, setRemoveRelationshipId] = useState<number | null>(
      null
    )
  const key = [...selection.ids].sort((a, b) => a - b).join(',')
  const scope = `${path}\u0000${key}`
  const imageDataLoaded = imageResult.path === path && imageResult.key === key
  const images = imageDataLoaded ? imageResult.images : []
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
      key &&
      !imageDataLoaded &&
      ['move-rename-file', 'add-tag', 'save-prompt'].includes(
        commandRequest.command
      )
    )
      return
    const frame = requestAnimationFrame(() => {
      if (!open) return
      const fieldByCommand: Record<string, string> = {
        'move-rename-file': 'asset-path',
        'add-tag': 'new-tag',
        'save-prompt': 'prompt-text',
      }
      const field = fieldByCommand[commandRequest.command]
      const target = field
        ? document.querySelector<HTMLElement>(`[name="${field}"]`)
        : null
      if (target) {
        target.focus()
      }
      focusedCommandRequest.current = commandRequest.request
      onCommandRequestHandled(commandRequest.request)
    })
    return () => cancelAnimationFrame(frame)
  }, [
    commandRequest,
    open,
    onCommandRequestHandled,
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
          setTagResult({
            scope,
            lists: lists.map((list) => (list ?? []).map((tag) => tag.name)),
          })
      })
      .catch(errors.current)
    return () => {
      cancelled = true
    }
  }, [path, key, data])
  const tagLists = tagResult?.scope === scope ? tagResult.lists : []
  const removeRelationship = (id: number) => {
    void enqueueCanvasMutation(
      owner,
      'relationship',
      async () => {
        await ImageService.UnlinkSource(path, id)
        await change()
      },
      () => owner.allowsAdmitted('relationship')
    ).catch(errors.current)
  }
  const unavailableCount = selection.ids.length - images.length
  const dialogs = (
    <DetailPanelDialogs
      promptConfirmation={promptConfirmation}
      setPromptConfirmation={setPromptConfirmation}
      scope={scope}
      unavailableCount={unavailableCount}
      selection={selection}
      selectionRevision={selectionRevision}
      setPromptDraft={setPromptDraft}
      onSubmitField={onSubmitField}
      onError={onError}
      removeRelationshipId={removeRelationshipId}
      setRemoveRelationshipId={setRemoveRelationshipId}
      removeRelationship={removeRelationship}
      canMutateRelationships={canMutateRelationships}
    />
  )
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
                disabled={!canMutateRelationships()}
                onClick={() => setRemoveRelationshipId(r.id)}
              >
                <Trans>Remove relationship</Trans>
              </Button>
            </div>
          ))}
        {dialogs}
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
            Select an image or relationship on the Canvas or in Assets to view
            metadata and links.
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
  const tagsReady =
    tagResult?.scope === scope && tagLists.length === images.length
  const tagNames = [...new Set(tagLists.flat())].sort((a, b) =>
    a.localeCompare(b)
  )
  const promptValues = images.map((current) => current.promptText)
  const promptIsCommon = promptValues.every(
    (value) => value === promptValues[0]
  )
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
  if (graphOrder) {
    const rank = new Map(graphOrder.map((id, index) => [id, index]))
    const compare = (a: number, b: number) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b) ?? Number.MAX_SAFE_INTEGER) || a - b
    incoming.sort((a, b) => compare(a.sourceImageId, b.sourceImageId))
    outgoing.sort((a, b) => compare(a.derivedImageId, b.derivedImageId))
  }
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
                Ctrl/Cmd-drag this image onto another image to create a
                relationship.
              </Trans>
            </p>
          )}
          <DetailPanelFields
            path={path}
            image={image}
            images={images}
            selection={selection}
            imageDataLoaded={imageDataLoaded}
            unavailableCount={unavailableCount}
            onSubmitField={onSubmitField}
            onAction={onAction}
            onError={onError}
            tagLists={tagLists}
            tagsReady={tagsReady}
            tagNames={tagNames}
            tagError={tagError}
            setTagError={setTagError}
            promptValues={promptValues}
            promptDirty={promptDirty}
            promptIsCommon={promptIsCommon}
            promptValue={promptValue}
            setPromptDraft={setPromptDraft}
            setPromptConfirmation={setPromptConfirmation}
            scope={scope}
            selectionRevision={selectionRevision}
          />
        </>
      ) : (
        <strong className="text-sm text-ink">
          {plural(selection.ids.length, {
            one: '# asset selected',
            other: '# assets selected',
          })}
        </strong>
      )}
      {dialogs}
      <DetailPanelRelations
        images={images}
        imageDataLoaded={imageDataLoaded}
        unavailableCount={unavailableCount}
        restoreEnabled={restoreEnabled}
        onAction={onAction}
        selection={selection}
        image={image}
        relationshipSections={relationshipSections}
        data={data}
        go={go}
        setRemoveRelationshipId={setRemoveRelationshipId}
        canMutateRelationships={canMutateRelationships}
      />
    </div>
  )
})
