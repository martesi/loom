import { t } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'
import type { Dispatch, SetStateAction } from 'react'
import type { ImageInfo } from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Section } from './detail-panel-section'

interface PromptDraft {
  scope: string
  value: string
  dirty: boolean
}

interface PromptConfirmation {
  scope: string
  ids: number[]
  value: string
  replacing: boolean
  owner: Selection['surface']
  revision: number
}

interface Props {
  path: string
  image: ImageInfo
  images: ImageInfo[]
  selection: Selection
  imageDataLoaded: boolean
  unavailableCount: number
  onSubmitField: (
    id: 'move-rename-file' | 'add-tag' | 'save-prompt',
    value: string,
    imageIds: number[],
    fileName?: string,
    expected?: { owner: Selection['surface']; revision: number }
  ) => Promise<void>
  onAction: (id: string) => void
  onError: (error: unknown) => void
  tagLists: string[][]
  tagsReady: boolean
  tagNames: string[]
  tagError: string
  setTagError: Dispatch<SetStateAction<string>>
  promptValues: (string | null | undefined)[]
  promptDirty: boolean
  promptIsCommon: boolean
  promptValue: string
  setPromptDraft: Dispatch<SetStateAction<PromptDraft | null>>
  setPromptConfirmation: Dispatch<SetStateAction<PromptConfirmation | null>>
  scope: string
  selectionRevision: number
}

export function DetailPanelFields({
  path,
  image,
  images,
  selection,
  imageDataLoaded,
  unavailableCount,
  onSubmitField,
  onAction,
  onError,
  tagLists,
  tagsReady,
  tagNames,
  tagError,
  setTagError,
  promptValues,
  promptDirty,
  promptIsCommon,
  promptValue,
  setPromptDraft,
  setPromptConfirmation,
  scope,
  selectionRevision,
}: Props) {
  return (
    <>
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
            ).catch(onError)
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
      {unavailableCount > 0 && (
        <p role="alert" className="text-ink-muted">
          {images.length === 0 ? (
            <Trans>
              The selected assets are unavailable. Bulk edits are disabled.
            </Trans>
          ) : (
            <Plural
              value={unavailableCount}
              one="# selected asset is unavailable; bulk edits are disabled."
              other="# selected assets are unavailable; bulk edits are disabled."
            />
          )}
        </p>
      )}
      <Section title={<Trans>Tags</Trans>}>
        {tagsReady && tagNames.length > 0 ? (
          <ul aria-label={t`Tag summary`} className="grid gap-1 text-ink-muted">
            {tagNames.map((tag) => {
              const count = tagLists.filter((list) => list.includes(tag)).length
              return (
                <li key={tag}>
                  {tag} —{' '}
                  {count === images.length ? (
                    <Trans>All selected assets</Trans>
                  ) : (
                    <Trans>
                      {count} of {images.length} assets
                    </Trans>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-ink-muted">
            {tagsReady ? (
              <Trans>No tags</Trans>
            ) : (
              <Trans>Loading tag summary…</Trans>
            )}
          </p>
        )}
        {images.length > 1 && (
          <p className="text-ink-muted">
            <Plural
              value={images.length}
              one="Apply to # asset"
              other="Apply to # assets"
            />
          </p>
        )}
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
              .catch(onError)
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
        {tagError && (
          <p id="tag-validation-error" role="alert" className="text-danger">
            {tagError}
          </p>
        )}
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
            const clearing =
              images.length > 1 &&
              promptValue === '' &&
              promptValues.some(Boolean)
            if (replacing || clearing) {
              setPromptConfirmation({
                scope,
                ids: images.map((current) => current.id),
                value: promptValue,
                replacing,
                owner: selection.surface,
                revision: selectionRevision,
              })
              return
            }
            void onSubmitField(
              'save-prompt',
              promptValue,
              images.map((current) => current.id)
            )
              .then(() => {
                setPromptDraft((draft) =>
                  draft?.scope === scope ? null : draft
                )
              })
              .catch(onError)
          }}
        >
          <textarea
            className="min-h-20 w-full resize-y rounded-sm border border-input bg-card p-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            name="prompt-text"
            aria-label={t`Prompt`}
            aria-describedby={
              !promptIsCommon ? 'prompt-mixed-help' : 'prompt-scope'
            }
            value={promptValue}
            onChange={(event) =>
              setPromptDraft({ scope, value: event.target.value, dirty: true })
            }
            placeholder={
              promptIsCommon
                ? t`No prompt`
                : t`Mixed prompts — edit to replace all`
            }
            disabled={!imageDataLoaded || unavailableCount > 0}
          />
          {!promptIsCommon && (
            <p id="prompt-mixed-help">
              <Trans>
                Mixed values. Editing and saving replaces every selected prompt.
              </Trans>
            </p>
          )}
          <p id="prompt-scope" className="text-ink-muted">
            <Plural
              value={images.length}
              one="Apply to # asset"
              other="Apply to # assets"
            />
          </p>
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
    </>
  )
}
