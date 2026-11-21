import { Dialog } from '@base-ui-components/react/dialog'
import { Plural, Trans } from '@lingui/react/macro'
import type { Dispatch, SetStateAction } from 'react'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'

interface PromptConfirmation {
  scope: string
  ids: number[]
  value: string
  replacing: boolean
  owner: Selection['surface']
  revision: number
}

interface PromptDraft {
  scope: string
  value: string
  dirty: boolean
}

interface Props {
  promptConfirmation: PromptConfirmation | null
  setPromptConfirmation: Dispatch<SetStateAction<PromptConfirmation | null>>
  scope: string
  unavailableCount: number
  selection: Selection
  selectionRevision: number
  setPromptDraft: Dispatch<SetStateAction<PromptDraft | null>>
  onSubmitField: (
    id: 'move-rename-file' | 'add-tag' | 'save-prompt',
    value: string,
    imageIds: number[],
    fileName?: string,
    expected?: { owner: Selection['surface']; revision: number }
  ) => Promise<void>
  onError: (error: unknown) => void
  removeRelationshipId: number | null
  setRemoveRelationshipId: Dispatch<SetStateAction<number | null>>
  run: (action: () => Promise<unknown>) => void
  path: string
}

export function DetailPanelDialogs(props: Props) {
  const {
    promptConfirmation,
    setPromptConfirmation,
    scope,
    unavailableCount,
    selection,
    selectionRevision,
    setPromptDraft,
    onSubmitField,
    onError,
    removeRelationshipId,
    setRemoveRelationshipId,
    run,
    path,
  } = props
  return (
    <>
      <Dialog.Root
        open={promptConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setPromptConfirmation(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-card p-5 shadow-lg outline-none">
            <Dialog.Title className="text-sm font-semibold text-ink">
              {promptConfirmation && (
                <Plural
                  value={promptConfirmation.ids.length}
                  one={
                    promptConfirmation.replacing
                      ? 'Replace prompts on # selected asset?'
                      : 'Clear prompts on # selected asset?'
                  }
                  other={
                    promptConfirmation.replacing
                      ? 'Replace prompts on # selected assets?'
                      : 'Clear prompts on # selected assets?'
                  }
                />
              )}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs text-ink-muted">
              {promptConfirmation?.replacing ? (
                <Trans>This replaces the prompt on every selected asset.</Trans>
              ) : (
                <Trans>This clears the prompt on every selected asset.</Trans>
              )}
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>
                <Trans>Cancel</Trans>
              </Dialog.Close>
              <Button
                variant="danger"
                size="sm"
                disabled={
                  !promptConfirmation ||
                  promptConfirmation.scope !== scope ||
                  unavailableCount > 0
                }
                onClick={() => {
                  const confirmation = promptConfirmation
                  if (
                    !confirmation ||
                    confirmation.scope !== scope ||
                    unavailableCount > 0
                  )
                    return
                  if (
                    confirmation.owner !== selection.surface ||
                    confirmation.revision !== selectionRevision
                  )
                    return
                  setPromptConfirmation(null)
                  void onSubmitField(
                    'save-prompt',
                    confirmation.value,
                    confirmation.ids,
                    undefined,
                    {
                      owner: confirmation.owner,
                      revision: confirmation.revision,
                    }
                  )
                    .then(() => {
                      setPromptDraft((draft) =>
                        draft?.scope === confirmation.scope ? null : draft
                      )
                    })
                    .catch(onError)
                }}
              >
                {promptConfirmation?.replacing ? (
                  <Trans>Replace prompts</Trans>
                ) : (
                  <Trans>Clear prompts</Trans>
                )}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={removeRelationshipId !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveRelationshipId(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-card p-5 shadow-lg outline-none">
            <Dialog.Title className="text-sm font-semibold text-ink">
              <Trans>Remove relationship?</Trans>
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs text-ink-muted">
              <Trans>
                Only the relationship will be removed. The assets and their
                metadata will remain.
              </Trans>
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>
                <Trans>Cancel</Trans>
              </Dialog.Close>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  const id = removeRelationshipId
                  setRemoveRelationshipId(null)
                  if (id !== null)
                    run(() => ImageService.UnlinkSource(path, id))
                }}
              >
                <Trans>Remove relationship</Trans>
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
