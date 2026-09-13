import { useEffect, useRef, useState } from 'react'
import {
  type CanvasData,
  GroupService,
  type ImageInfo,
  ImageService,
  PromptService,
  TagService,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'

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
    [tags, setTags] = useState<string[]>([])
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
  if (group)
    return (
      <div className="grid gap-3 p-3 text-xs">
        <label>
          Set name
          <input
            key={`${group.id}-name-${group.name}`}
            defaultValue={group.name}
            onBlur={(e) =>
              run(() =>
                GroupService.UpdateMetadata(
                  path,
                  group.id,
                  e.target.value,
                  group.kind
                )
              )
            }
          />
        </label>
        <label>
          Kind
          <input
            key={`${group.id}-kind-${group.kind}`}
            defaultValue={group.kind}
            onBlur={(e) =>
              run(() =>
                GroupService.UpdateMetadata(
                  path,
                  group.id,
                  group.name,
                  e.target.value
                )
              )
            }
          />
        </label>
        <p>{(group.memberIds ?? []).length} assets</p>
        <button
          type="button"
          onClick={() => run(() => GroupService.Ungroup(path, group.id))}
        >
          Dissolve set
        </button>
      </div>
    )
  if (selection.edges.length)
    return (
      <div className="p-3 text-xs">
        <p>{selection.edges.length} relationships</p>
        {(data.relationships ?? [])
          .filter((r) => selection.edges.includes(r.id))
          .map((r) => (
            <div key={r.id}>
              <button type="button" onClick={() => go(r.sourceImageId)}>
                Go to source
              </button>
              <button type="button" onClick={() => go(r.derivedImageId)}>
                Go to derived
              </button>
              <button
                type="button"
                onClick={() => run(() => ImageService.UnlinkSource(path, r.id))}
              >
                Remove relationship
              </button>
            </div>
          ))}
      </div>
    )
  if (!images.length)
    return (
      <p className="p-3 text-xs text-ink-subtle">
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
    <div className="grid gap-3 overflow-auto p-3 text-xs">
      {image ? (
        <>
          <img
            src={image.fullUrl}
            alt={image.fileName}
            className="max-h-64 w-full object-contain"
          />
          <strong>{image.fileName}</strong>
          <p>
            {image.width} × {image.height}
          </p>
          <p>
            {image.missing
              ? 'Missing'
              : image.trashed
                ? 'Trashed'
                : image.placed
                  ? 'Placed'
                  : 'Unplaced'}
          </p>
          <p className="break-all">{image.filePath}</p>
          <button type="button" onClick={() => go(image.id, true)}>
            Show in Folders
          </button>
          <button
            type="button"
            onClick={() => {
              const name = window.prompt(
                'New path relative to repository',
                image.fileName
              )
              if (name) run(() => ImageService.MoveFile(path, image.id, name))
            }}
          >
            Move / rename
          </button>
        </>
      ) : (
        <strong>{images.length} assets selected</strong>
      )}
      <p>Common tags: {tags.join(', ') || 'None'}</p>
      <button
        type="button"
        onClick={() => {
          const tag = window.prompt('Add tag')
          if (tag)
            run(() =>
              Promise.all(images.map((i) => TagService.AddTag(path, i.id, tag)))
            )
        }}
      >
        Add tag
      </button>
      <p>
        {images.every((i) => i.promptText === images[0].promptText)
          ? images[0].promptText
          : 'Mixed prompts'}
      </p>
      <button
        type="button"
        onClick={() => {
          const prompt = window.prompt('Prompt')
          if (prompt !== null)
            run(() =>
              Promise.all(
                images.map((i) =>
                  PromptService.CreateAndAttachPrompt(
                    path,
                    i.id,
                    '',
                    prompt,
                    ''
                  )
                )
              )
            )
        }}
      >
        Edit prompt
      </button>
      <button
        type="button"
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
      </button>
      {images.some((i) => i.trashed) && (
        <button
          type="button"
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
        </button>
      )}
      {image &&
        [
          ['Sources', incoming],
          ['Derived', outgoing],
        ].map(
          ([title, rels]) =>
            typeof title === 'string' &&
            Array.isArray(rels) && (
              <section key={title}>
                <h3 className="font-semibold">{title}</h3>
                {rels.map((r) => {
                  const id =
                    title === 'Sources' ? r.sourceImageId : r.derivedImageId
                  return (
                    <div key={r.id} className="my-2">
                      <span>
                        {(data.images ?? []).find((i) => i.id === id)
                          ?.fileName ?? `Asset ${id}`}
                      </span>
                      <button type="button" onClick={() => go(id)}>
                        Go to
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          run(() => ImageService.UnlinkSource(path, r.id))
                        }
                      >
                        Remove relationship
                      </button>
                    </div>
                  )
                })}
              </section>
            )
        )}
    </div>
  )
}
