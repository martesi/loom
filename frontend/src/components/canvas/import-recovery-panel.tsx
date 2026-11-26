import { Dialog } from '@base-ui-components/react/dialog'
import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import {
  ImageService,
  type PendingImportBatch,
  type RecoverableImport,
} from '../../../bindings/loom/internal/service'
import { Button } from '../ui/button'

interface Props {
  path: string
  refresh: number
  onRecovered: () => Promise<unknown>
}

type ReplaceRequest =
  | { kind: 'pending'; batchID: string }
  | { kind: 'retained'; imageID: number }

export function ImportRecoveryPanel({ path, refresh, onRecovered }: Props) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<PendingImportBatch[]>([])
  const [retained, setRetained] = useState<RecoverableImport[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState('')
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

  function completePending(batchID: string, replaceRedo: boolean) {
    const key = `pending:${batchID}`
    setWorking(key)
    setError('')
    setReplaceRequest(null)
    const action = replaceRedo
      ? ImageService.RecoverPendingImportBatchAndReplaceRedo(path, batchID)
      : ImageService.RecoverPendingImportBatch(path, batchID)
    void action
      .then(() => onRecovered())
      .then(() => refreshLists())
      .then(() => setOpen(false))
      .catch((cause: unknown) => {
        const message = errorMessage(cause)
        if (!replaceRedo && message.includes('redo history exists')) {
          setReplaceRequest({ kind: 'pending', batchID })
        } else {
          setError(message)
        }
      })
      .finally(() => setWorking(null))
  }

  function recoverRetained(imageID: number, replaceRedo: boolean) {
    const key = `retained:${imageID}`
    setWorking(key)
    setError('')
    setReplaceRequest(null)
    const action = replaceRedo
      ? ImageService.RecoverImportAndReplaceRedo(path, imageID)
      : ImageService.RecoverImport(path, imageID)
    void action
      .then(() => onRecovered())
      .then(() => refreshLists())
      .then(() => setOpen(false))
      .catch((cause: unknown) => {
        const message = errorMessage(cause)
        if (!replaceRedo && message.includes('redo history exists')) {
          setReplaceRequest({ kind: 'retained', imageID })
        } else {
          setError(message)
        }
      })
      .finally(() => setWorking(null))
  }

  const count = pending.length + retained.length

  return (
    <>
      <div className="px-2 pb-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
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
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-[90] max-h-[min(80vh,48rem)] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-card p-5 text-ink shadow-xl outline-none">
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
                    disabled={working !== null}
                    onClick={() => {
                      if (replaceRequest.kind === 'pending')
                        completePending(replaceRequest.batchID, true)
                      else recoverRetained(replaceRequest.imageID, true)
                    }}
                  >
                    <Trans>Replace redo history and recover</Trans>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={working !== null}
                    onClick={() => setReplaceRequest(null)}
                  >
                    <Trans>Keep redo history</Trans>
                  </Button>
                </div>
              </div>
            )}
            <section className="mt-5 grid gap-3">
              <h3 className="text-sm font-semibold">
                <Trans>Interrupted imports</Trans>
              </h3>
              {pending.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  <Trans>No interrupted imports.</Trans>
                </p>
              ) : (
                pending.map((batch) => {
                  const files = batch.files ?? []
                  const verified =
                    files.length > 0 && files.every((f) => f.verified)
                  return (
                    <div
                      key={batch.id}
                      className="grid gap-2 rounded border border-border p-3"
                    >
                      <ul className="grid gap-1 text-xs">
                        {files.map((file) => (
                          <li key={file.path} className="break-all">
                            <span className="font-medium">{file.path}</span>
                            <span className="ml-2 text-ink-muted">
                              {file.verified ? (
                                <Trans>Fingerprint verified</Trans>
                              ) : file.filePresent ? (
                                <Trans>
                                  File differs from the recorded import; manual
                                  review required
                                </Trans>
                              ) : (
                                <Trans>
                                  File is missing; reservation remains
                                </Trans>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!verified || working !== null}
                        onClick={() => completePending(batch.id, false)}
                      >
                        <Trans>Finish verified batch</Trans>
                      </Button>
                    </div>
                  )
                })
              )}
            </section>
            <section className="mt-5 grid gap-3">
              <h3 className="text-sm font-semibold">
                <Trans>Undone imports</Trans>
              </h3>
              {retained.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  <Trans>No undone imports need recovery.</Trans>
                </p>
              ) : (
                retained.map((item) => {
                  const verified =
                    item.trusted && item.filePresent && item.verified
                  return (
                    <div
                      key={item.imageId}
                      className="grid gap-2 rounded border border-border p-3"
                    >
                      <p className="break-all text-xs font-medium">
                        {item.filePath}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {!item.trusted ? (
                          <Trans>
                            Legacy record has no trusted fingerprint. The asset
                            stays hidden and unchanged.
                          </Trans>
                        ) : verified ? (
                          <Trans>Original file fingerprint verified.</Trans>
                        ) : item.filePresent ? (
                          <Trans>
                            File differs from the recorded import. Recovery is
                            blocked.
                          </Trans>
                        ) : (
                          <Trans>
                            Original file is missing. Recovery is blocked.
                          </Trans>
                        )}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!verified || working !== null}
                        onClick={() => recoverRetained(item.imageId, false)}
                      >
                        <Trans>Restore verified import</Trans>
                      </Button>
                    </div>
                  )
                })
              )}
            </section>
            <div className="mt-5 flex justify-end">
              <Dialog.Close
                render={<Button type="button" variant="secondary" />}
              >
                <Trans>Close</Trans>
              </Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
