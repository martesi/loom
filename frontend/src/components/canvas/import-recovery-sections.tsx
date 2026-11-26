import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import {
  ImportResolutionStatus,
  type PendingImportBatch,
  type RecoverableImport,
  type ReplacementResult,
  type UnverifiedReplacementRedoTail,
} from '../../../bindings/loom/internal/service'
import { Button } from '../ui/button'

interface Props {
  pending: PendingImportBatch[]
  retained: RecoverableImport[]
  replacementRecoveries: ReplacementResult[]
  legacyRedoTail: UnverifiedReplacementRedoTail | null
  legacyTailLoadError: string
  pendingLoadError: string
  retainedLoadError: string
  replacementLoadError: string
  selectedItems: Record<string, number[]>
  releasedItems: Record<string, number[]>
  releaseConfirmationBatch: string | null
  working: boolean
  modalRequestActive: boolean
  onToggleSelected: (batchID: string, itemIndex: number) => void
  onToggleReleased: (batchID: string, itemIndex: number) => void
  onResolvePending: (batchID: string) => void
  onReviewRelease: (batchID: string) => void
  onCancelRelease: () => void
  onRestoreVerified: (item: RecoverableImport) => void
  onShowUnverified: (item: RecoverableImport) => void
  onRetryReplacement: (requestID: string) => void
  onRetryLegacyTail: () => void
  onResolveLegacyTail: () => void
}

export function ImportRecoverySections({
  pending,
  retained,
  replacementRecoveries,
  legacyRedoTail,
  legacyTailLoadError,
  pendingLoadError,
  retainedLoadError,
  replacementLoadError,
  selectedItems,
  releasedItems,
  releaseConfirmationBatch,
  working,
  modalRequestActive,
  onToggleSelected,
  onToggleReleased,
  onResolvePending,
  onReviewRelease,
  onCancelRelease,
  onRestoreVerified,
  onShowUnverified,
  onRetryReplacement,
  onRetryLegacyTail,
  onResolveLegacyTail,
}: Props) {
  return (
    <>
      {(replacementRecoveries.length > 0 || replacementLoadError) && (
        <section
          className="mt-3 grid gap-2 rounded border border-warning/40 p-3"
          data-testid="pending-replacement-recoveries"
        >
          <h3 className="text-sm font-semibold">
            <Trans>Replacement recovery needs attention</Trans>
          </h3>
          {replacementLoadError && (
            <div role="alert" className="grid gap-2 text-sm text-danger">
              <p>{replacementLoadError}</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={working}
                onClick={() => onRetryReplacement('')}
              >
                <Trans>Retry replacement status and recovery</Trans>
              </Button>
            </div>
          )}
          {replacementRecoveries.map((replacement) => (
            <div
              key={replacement.requestId}
              data-testid="pending-replacement-recovery"
              className="grid gap-1 break-all text-xs"
            >
              <span>{replacement.message}</span>
              <span className="text-ink-subtle">
                <Trans>Request ID</Trans>: {replacement.requestId};{' '}
                <Trans>Phase</Trans>: {replacement.phase || 'unknown'}
              </span>
              <dl className="grid gap-1 text-ink-subtle">
                <EvidenceLine
                  label={<Trans>Current path</Trans>}
                  value={replacement.currentPath || '—'}
                />
                <EvidenceLine
                  label={<Trans>Outgoing stash</Trans>}
                  value={replacement.outgoingPath || '—'}
                />
                <EvidenceLine
                  label={<Trans>Incoming stash</Trans>}
                  value={replacement.incomingPath || '—'}
                />
                <EvidenceLine
                  label={<Trans>Target path</Trans>}
                  value={replacement.activePath || '—'}
                />
                <EvidenceLine
                  label={<Trans>Current fingerprint</Trans>}
                  value={replacement.currentFingerprint || '—'}
                />
                <EvidenceLine
                  label={<Trans>Incoming fingerprint</Trans>}
                  value={replacement.incomingFingerprint || '—'}
                />
              </dl>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="justify-self-start"
                disabled={working}
                onClick={() => onRetryReplacement(replacement.requestId)}
              >
                <Trans>Retry safe recovery</Trans>
              </Button>
            </div>
          ))}
          <p className="text-xs text-ink-subtle">
            <Trans>
              Loom preserves ambiguous files and blocks related changes until
              the journal can be verified. Do not move or edit these paths.
            </Trans>
          </p>
        </section>
      )}
      {(legacyRedoTail?.available || legacyTailLoadError) && (
        <section
          className="mt-3 grid gap-2 rounded border border-danger/30 p-3"
          data-testid="unverified-legacy-redo-tail"
        >
          <h3 className="text-sm font-semibold">
            <Trans>Unverified legacy replacement history</Trans>
          </h3>
          {legacyTailLoadError ? (
            <div role="alert" className="grid gap-2 text-sm text-danger">
              <p>{legacyTailLoadError}</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={working}
                onClick={onRetryLegacyTail}
              >
                <Trans>Retry legacy history status</Trans>
              </Button>
            </div>
          ) : legacyRedoTail?.available ? (
            <>
              <p className="text-sm">{legacyRedoTail.warning}</p>
              <dl className="grid gap-1 break-all text-xs text-ink-subtle">
                <EvidenceLine
                  label={<Trans>History cursor</Trans>}
                  value={String(legacyRedoTail.cursor)}
                />
                <EvidenceLine
                  label={<Trans>Redo tail</Trans>}
                  value={`${legacyRedoTail.startSeq}–${legacyRedoTail.endSeq} (${legacyRedoTail.operationCount})`}
                />
                <EvidenceLine
                  label={<Trans>Status</Trans>}
                  value={legacyRedoTail.status || 'unverified'}
                />
              </dl>
              <p className="text-xs text-ink-muted">
                <Trans>
                  This action removes history entries only. It does not delete,
                  move, or change files and does not create provenance.
                </Trans>
              </p>
              <Button
                type="button"
                size="sm"
                variant="danger"
                data-testid="discard-unverified-redo-tail"
                disabled={working}
                onClick={onResolveLegacyTail}
              >
                <Trans>Discard the entire confirmed redo tail</Trans>
              </Button>
            </>
          ) : null}
        </section>
      )}
      <section className="mt-5 grid gap-3">
        <h3 className="text-sm font-semibold">
          <Trans>Interrupted imports</Trans>
        </h3>
        {pendingLoadError ? (
          <p role="alert" className="text-sm text-danger">
            {pendingLoadError}
          </p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-ink-muted">
            <Trans>No interrupted imports.</Trans>
          </p>
        ) : (
          pending.map((batch) => {
            const files = batch.files ?? []
            const selected = selectedItems[batch.id] ?? []
            const released = releasedItems[batch.id] ?? []
            const pendingRelease = releaseConfirmationBatch === batch.id
            return (
              <div
                key={batch.id}
                data-testid="pending-import-batch"
                className="grid gap-2 rounded border border-border p-3"
              >
                <ul className="grid gap-1 text-xs">
                  {files.map((file) => {
                    const itemIndex = file.itemIndex
                    const canImport =
                      file.status ===
                      ImportResolutionStatus.ImportStatusVerified
                    const canRelease =
                      file.status ===
                        ImportResolutionStatus.ImportStatusMissing ||
                      file.status === ImportResolutionStatus.ImportStatusChanged
                    return (
                      <li
                        key={file.path}
                        data-testid="pending-import-file"
                        data-recovery-status={file.status}
                        className="grid gap-1 break-all border-b border-border/50 py-2 last:border-0"
                      >
                        <span className="font-medium">{file.path}</span>
                        <span className="text-ink-muted">
                          {statusLabel(file.status)}
                        </span>
                        <EvidenceLine
                          label={<Trans>Recorded fingerprint</Trans>}
                          value={file.recordedFingerprint || file.fingerprint}
                        />
                        <EvidenceLine
                          label={<Trans>Current fingerprint</Trans>}
                          value={file.currentFingerprint || '—'}
                        />
                        {file.resolutionError && (
                          <span role="note" className="text-danger">
                            {file.resolutionError}
                          </span>
                        )}
                        {canImport && (
                          <label className="flex items-center gap-2 py-1">
                            <input
                              type="checkbox"
                              data-testid="select-pending-import"
                              checked={selected.includes(itemIndex)}
                              disabled={
                                working || pendingRelease || modalRequestActive
                              }
                              onChange={() =>
                                onToggleSelected(batch.id, itemIndex)
                              }
                            />
                            <Trans>Import this verified file</Trans>
                          </label>
                        )}
                        {canRelease && (
                          <label className="flex items-center gap-2 py-1">
                            <input
                              type="checkbox"
                              data-testid="select-pending-release"
                              checked={released.includes(itemIndex)}
                              disabled={
                                working || pendingRelease || modalRequestActive
                              }
                              onChange={() =>
                                onToggleReleased(batch.id, itemIndex)
                              }
                            />
                            <Trans>Release this safe reservation</Trans>
                          </label>
                        )}
                      </li>
                    )
                  })}
                </ul>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid="resolve-pending-import"
                  disabled={
                    selected.length + released.length === 0 ||
                    working ||
                    modalRequestActive
                  }
                  onClick={() => onResolvePending(batch.id)}
                >
                  <Trans>Resolve selected items</Trans>
                </Button>
                {pendingRelease && (
                  <div
                    role="alert"
                    data-testid="release-reservation-confirmation"
                    className="grid gap-2 rounded border border-warning/40 p-3 text-xs"
                  >
                    <p>
                      <Trans>
                        This releases only the selected reservation. Loom will
                        not move, delete, overwrite, or recreate any file. A
                        safe present file may be discovered as a new asset
                        later.
                      </Trans>
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        data-testid="confirm-reservation-release"
                        disabled={working || modalRequestActive}
                        onClick={() => onResolvePending(batch.id)}
                      >
                        <Trans>Confirm reservation release</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={working}
                        onClick={onCancelRelease}
                      >
                        <Trans>Keep reservation</Trans>
                      </Button>
                    </div>
                  </div>
                )}
                {released.length > 0 && !pendingRelease && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="request-reservation-release"
                    disabled={modalRequestActive || working}
                    onClick={() => onReviewRelease(batch.id)}
                  >
                    <Trans>Review reservation release</Trans>
                  </Button>
                )}
              </div>
            )
          })
        )}
      </section>
      <section className="mt-5 grid gap-3">
        <h3 className="text-sm font-semibold">
          <Trans>Undone imports</Trans>
        </h3>
        {retainedLoadError ? (
          <p role="alert" className="text-sm text-danger">
            {retainedLoadError}
          </p>
        ) : retained.length === 0 ? (
          <p className="text-sm text-ink-muted">
            <Trans>No undone imports need recovery.</Trans>
          </p>
        ) : (
          retained.map((item) => {
            const verified =
              item.trusted &&
              item.status === ImportResolutionStatus.ImportStatusVerified &&
              item.verified
            const canShowUnverified =
              !verified &&
              !item.resolutionError &&
              (item.status === ImportResolutionStatus.ImportStatusMissing ||
                item.status === ImportResolutionStatus.ImportStatusChanged ||
                item.status === ImportResolutionStatus.ImportStatusUntrusted)
            return (
              <div
                key={item.imageId}
                data-testid="retained-import"
                data-image-id={item.imageId}
                data-recovery-status={item.status}
                data-current-fingerprint={item.currentFingerprint ?? ''}
                className="grid gap-2 rounded border border-border p-3"
              >
                <p className="break-all text-xs font-medium">{item.filePath}</p>
                <p className="text-xs text-ink-muted">
                  {statusLabel(item.status)}
                </p>
                {!item.trusted && (
                  <p className="text-xs text-ink-subtle">
                    <Trans>
                      Legacy provenance is untrusted. Loom preserves the old
                      evidence and does not infer an original hash.
                    </Trans>
                  </p>
                )}
                <EvidenceLine
                  label={<Trans>Recorded fingerprint</Trans>}
                  value={item.recordedFingerprint || item.fingerprint || '—'}
                />
                <EvidenceLine
                  label={<Trans>Current fingerprint</Trans>}
                  value={item.currentFingerprint || '—'}
                />
                {item.resolutionError && (
                  <span role="note" className="text-danger text-xs">
                    {item.resolutionError}
                  </span>
                )}
                {canShowUnverified && (
                  <span className="text-xs text-ink-subtle">
                    <Trans>
                      This identity remains protected until you confirm a
                      separate unverified visibility action.
                    </Trans>
                  </span>
                )}
                {canShowUnverified && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="show-unverified-retained"
                    disabled={working || modalRequestActive}
                    onClick={() => onShowUnverified(item)}
                  >
                    <Trans>Show unverified item…</Trans>
                  </Button>
                )}
                {!verified && !canShowUnverified && item.resolutionError && (
                  <span className="text-xs text-danger">
                    {item.resolutionError}
                  </span>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid="restore-retained-import"
                  disabled={!verified || working || modalRequestActive}
                  onClick={() => onRestoreVerified(item)}
                >
                  <Trans>Restore verified import</Trans>
                </Button>
              </div>
            )
          })
        )}
      </section>
    </>
  )
}

function statusLabel(status: ImportResolutionStatus) {
  switch (status) {
    case ImportResolutionStatus.ImportStatusVerified:
      return <Trans>Verified against recorded fingerprint</Trans>
    case ImportResolutionStatus.ImportStatusMissing:
      return <Trans>Missing; reservation remains in place</Trans>
    case ImportResolutionStatus.ImportStatusChanged:
      return <Trans>Changed; current file differs from recorded evidence</Trans>
    case ImportResolutionStatus.ImportStatusUntrusted:
      return <Trans>Untrusted legacy evidence</Trans>
    default:
      return <Trans>Ambiguous or unsafe; resolution is blocked</Trans>
  }
}

function EvidenceLine({ label, value }: { label: ReactNode; value: string }) {
  return (
    <span className="text-ink-subtle">
      <strong>{label}:</strong> {value}
    </span>
  )
}
