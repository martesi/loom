import { Dialog } from '@base-ui-components/react/dialog'
import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import {
  ImageService,
  type PendingImportBatch,
  type PendingImportResolutionRequest,
  type RecoverableImport,
  type RetainedImportResolutionRequest,
} from '../../../bindings/loom/internal/service'
import { Button } from '../ui/button'
import { ImportRecoverySections } from './import-recovery-sections'

interface Props {
  path: string
  refresh: number
  onRecovered: () => Promise<unknown>
}

type ReplaceRequest =
  | { kind: 'pending'; request: PendingImportResolutionRequest }
  | { kind: 'retained'; request: RetainedImportResolutionRequest }

export function ImportRecoveryPanel({ path, refresh, onRecovered }: Props) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<PendingImportBatch[]>([])
  const [retained, setRetained] = useState<RecoverableImport[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [selectedItems, setSelectedItems] = useState<Record<string, number[]>>(
    {}
  )
  const [releasedItems, setReleasedItems] = useState<Record<string, number[]>>(
    {}
  )
  const [pendingRequests, setPendingRequests] = useState<
    Record<string, PendingImportResolutionRequest>
  >({})
  const [retainedRequests, setRetainedRequests] = useState<
    Record<string, RetainedImportResolutionRequest>
  >({})
  const [adoptionRequest, setAdoptionRequest] =
    useState<RetainedImportResolutionRequest | null>(null)
  const [releaseConfirmation, setReleaseConfirmation] = useState<{
    batchID: string
    indexes: number[]
  } | null>(null)
  const [replaceRequest, setReplaceRequest] = useState<ReplaceRequest | null>(
    null
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: repository mutations explicitly refresh the recovery ledger.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      ImageService.ListPendingImportBatches(path),
      ImageService.ListRecoverableImports(path),
    ])
      .then(([batches, imports]) => {
        if (cancelled) return
        setPending(batches ?? [])
        setRetained(imports ?? [])
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(errorMessage(cause))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path, refresh])

  function refreshLists() {
    return Promise.all([
      ImageService.ListPendingImportBatches(path),
      ImageService.ListRecoverableImports(path),
    ]).then(([batches, imports]) => {
      setPending(batches ?? [])
      setRetained(imports ?? [])
    })
  }

  function completePending(request: PendingImportResolutionRequest) {
    const key = `pending:${request.batchId}`
    setWorking(key)
    setError('')
    setReleaseConfirmation(null)
    let committed = false
    void (async () => {
      const result = await ImageService.ResolvePendingImportBatch(path, request)
      if (!result) throw new Error('Recovery returned no result')
      if (result.needsRedoConfirmation) {
        const confirmedRequest = {
          ...request,
          redoTailConfirmation: result.redoTailConfirmation,
        }
        setPendingRequests((current) => ({
          ...current,
          [request.batchId]: confirmedRequest,
        }))
        setReplaceRequest({
          kind: 'pending',
          request: confirmedRequest,
        })
        return
      }
      committed = true
      setReplaceRequest(null)
      setReleaseConfirmation(null)
      await onRecovered()
      await refreshLists()
      setSelectedItems((current) => ({ ...current, [request.batchId]: [] }))
      setReleasedItems((current) => ({ ...current, [request.batchId]: [] }))
      setPendingRequests((current) => {
        const next = { ...current }
        delete next[request.batchId]
        return next
      })
      setOpen(false)
    })()
      .catch((cause: unknown) => {
        const message = errorMessage(cause)
        setError(
          committed
            ? `Resolution committed, but the workspace refresh failed: ${message}`
            : message
        )
      })
      .finally(() => setWorking(null))
  }

  function beginPendingResolution(batchID: string) {
    const selected = selectedItems[batchID] ?? []
    const released = releasedItems[batchID] ?? []
    if (selected.length + released.length === 0) return
    if (
      released.length > 0 &&
      (releaseConfirmation?.batchID !== batchID ||
        !sameIndexes(releaseConfirmation.indexes, released))
    ) {
      setReleaseConfirmation({ batchID, indexes: released })
      return
    }
    const existing = pendingRequests[batchID]
    const request =
      existing &&
      sameIndexes(existing.selectedItemIndexes ?? [], selected) &&
      sameIndexes(existing.releasedItemIndexes ?? [], released)
        ? existing
        : {
            batchId: batchID,
            requestId: crypto.randomUUID(),
            selectedItemIndexes: selected,
            releasedItemIndexes: released,
            confirmReservationRelease: released.length > 0,
          }
    setPendingRequests((current) => ({ ...current, [batchID]: request }))
    completePending(request)
  }

  function recoverRetained(request: RetainedImportResolutionRequest) {
    const key = `retained:${request.imageId}`
    const requestKey = `${request.imageId}:${request.showUnverified}`
    setWorking(key)
    setError('')
    if (!request.showUnverified || request.confirmUnverified)
      setRetainedRequests((current) => ({ ...current, [requestKey]: request }))
    let committed = false
    void (async () => {
      const result = await ImageService.ResolveRetainedImport(path, request)
      if (!result) throw new Error('Recovery returned no result')
      if (result.needsUnverifiedConfirmation) {
        const refreshedRequest = {
          ...request,
          confirmUnverified: true,
          evidenceConfirmation: result.evidenceConfirmation,
        }
        if (result.evidenceConfirmationStale) {
          setRetainedRequests((current) => {
            const next = { ...current }
            delete next[requestKey]
            next[requestKey] = refreshedRequest
            return next
          })
          setRetained((current) =>
            current.map((item) =>
              item.imageId === request.imageId
                ? {
                    ...item,
                    status: result.status,
                    currentFingerprint: result.currentFingerprint,
                    verified: false,
                  }
                : item
            )
          )
          setError(
            result.resolutionError ||
              'Evidence changed. Review it and confirm the current state again.'
          )
        }
        setAdoptionRequest(refreshedRequest)
        return
      }
      if (result.needsRedoConfirmation) {
        setAdoptionRequest(null)
        setReplaceRequest({
          kind: 'retained',
          request: {
            ...request,
            redoTailConfirmation: result.redoTailConfirmation,
          },
        })
        return
      }
      if (!result.applied) {
        setRetainedRequests((current) => {
          const next = { ...current }
          delete next[requestKey]
          return next
        })
        setError(
          result.resolutionError ||
            `Recovery is blocked for this item (${result.status})`
        )
        return
      }
      committed = true
      setReplaceRequest(null)
      setAdoptionRequest(null)
      await onRecovered()
      await refreshLists()
      setRetainedRequests((current) => {
        const next = { ...current }
        delete next[requestKey]
        return next
      })
      setOpen(false)
    })()
      .catch((cause: unknown) => {
        const message = errorMessage(cause)
        setError(
          committed
            ? `Resolution committed, but the workspace refresh failed: ${message}`
            : message
        )
      })
      .finally(() => setWorking(null))
  }

  function toggleSelectedItem(batchID: string, index: number) {
    setSelectedItems((current) => ({
      ...current,
      [batchID]: toggleIndex(current[batchID] ?? [], index),
    }))
  }

  function toggleReleasedItem(batchID: string, index: number) {
    setReleasedItems((current) => ({
      ...current,
      [batchID]: toggleIndex(current[batchID] ?? [], index),
    }))
  }

  function startRetainedResolution(
    item: RecoverableImport,
    showUnverified: boolean
  ) {
    const requestKey = `${item.imageId}:${showUnverified}`
    const request = retainedRequests[requestKey] ?? {
      imageId: item.imageId,
      requestId: crypto.randomUUID(),
      showUnverified,
      confirmUnverified: false,
    }
    recoverRetained(request)
  }

  const count = pending.length + retained.length

  return (
    <div data-testid="import-recovery-panel">
      <div className="px-2 pb-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="import-recovery-trigger"
          onClick={() => {
            setError('')
            void refreshLists().catch((cause: unknown) =>
              setError(errorMessage(cause))
            )
            setOpen(true)
          }}
        >
          {loading ? (
            <Trans>Checking import recovery…</Trans>
          ) : count > 0 ? (
            <Trans>Import recovery ({count})</Trans>
          ) : (
            <Trans>Import recovery</Trans>
          )}
        </Button>
      </div>
      {error && !open && (
        <div role="alert" className="px-3 pb-2 text-xs text-danger">
          {error}
        </div>
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[90] bg-black/30" />
          <Dialog.Popup
            data-testid="import-recovery-dialog"
            className="fixed left-1/2 top-1/2 z-[90] max-h-[min(80vh,48rem)] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-card p-5 text-ink shadow-xl outline-none"
          >
            <Dialog.Title className="text-base font-semibold">
              <Trans>Import recovery</Trans>
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-ink-muted">
              <Trans>
                Files stay in their current repository paths. Loom does not
                delete or replace files during recovery.
              </Trans>
            </Dialog.Description>
            {error && (
              <div
                role="alert"
                className="mt-3 rounded border border-danger/30 bg-danger-soft p-2 text-sm text-danger"
              >
                {error}
              </div>
            )}
            {replaceRequest && (
              <div
                role="alert"
                data-testid="redo-replacement-confirmation"
                className="mt-3 rounded border border-danger/30 p-3 text-sm"
              >
                <p>
                  <Trans>
                    Stored redo history exists. Replacing it is permanent. Loom
                    will keep the files and record recovery as one undoable
                    action.
                  </Trans>
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    data-testid="confirm-redo-replacement"
                    disabled={working !== null}
                    onClick={() => {
                      if (replaceRequest.kind === 'pending') {
                        completePending(replaceRequest.request)
                      } else {
                        recoverRetained(replaceRequest.request)
                      }
                    }}
                  >
                    <Trans>Replace redo history and recover</Trans>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={working !== null}
                    onClick={() => {
                      if (replaceRequest.kind === 'pending') {
                        setPendingRequests((current) => {
                          const next = { ...current }
                          delete next[replaceRequest.request.batchId]
                          return next
                        })
                      } else {
                        setRetainedRequests((current) => {
                          const next = { ...current }
                          delete next[
                            `${replaceRequest.request.imageId}:${replaceRequest.request.showUnverified}`
                          ]
                          return next
                        })
                      }
                      setReplaceRequest(null)
                    }}
                  >
                    <Trans>Keep redo history</Trans>
                  </Button>
                </div>
              </div>
            )}
            {adoptionRequest && (
              <div
                role="alert"
                data-testid="show-unverified-confirmation"
                className="mt-3 grid gap-2 rounded border border-warning/40 p-3 text-sm"
              >
                <p>
                  <Trans>
                    This item has no verified original provenance. Showing it
                    will preserve its ID, metadata, relationships, and recorded
                    evidence. Loom will not change the file. Undo will hide it
                    again. Redo will be refused if the file state changes.
                  </Trans>
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    data-testid="confirm-show-unverified"
                    disabled={working !== null}
                    onClick={() => recoverRetained(adoptionRequest)}
                  >
                    <Trans>Show unverified item</Trans>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="cancel-show-unverified"
                    disabled={working !== null}
                    onClick={() => {
                      setRetainedRequests((current) => {
                        const next = { ...current }
                        delete next[
                          `${adoptionRequest.imageId}:${adoptionRequest.showUnverified}`
                        ]
                        return next
                      })
                      setAdoptionRequest(null)
                    }}
                  >
                    <Trans>Keep hidden</Trans>
                  </Button>
                </div>
              </div>
            )}
            <ImportRecoverySections
              pending={pending}
              retained={retained}
              selectedItems={selectedItems}
              releasedItems={releasedItems}
              releaseConfirmationBatch={releaseConfirmation?.batchID ?? null}
              working={working !== null}
              modalRequestActive={
                replaceRequest !== null || adoptionRequest !== null
              }
              onToggleSelected={toggleSelectedItem}
              onToggleReleased={toggleReleasedItem}
              onResolvePending={beginPendingResolution}
              onReviewRelease={(batchID) =>
                setReleaseConfirmation({
                  batchID,
                  indexes: releasedItems[batchID] ?? [],
                })
              }
              onCancelRelease={() => setReleaseConfirmation(null)}
              onRestoreVerified={(item) => startRetainedResolution(item, false)}
              onShowUnverified={(item) => startRetainedResolution(item, true)}
            />
            <div className="mt-5 flex justify-end">
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="secondary"
                    data-testid="close-import-recovery"
                  />
                }
              >
                <Trans>Close</Trans>
              </Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function toggleIndex(indexes: number[], target: number) {
  return indexes.includes(target)
    ? indexes.filter((index) => index !== target)
    : [...indexes, target].sort((left, right) => left - right)
}

function sameIndexes(left: number[], right: number[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}
