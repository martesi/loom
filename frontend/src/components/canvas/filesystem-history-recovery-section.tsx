import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { FilesystemHistoryRecovery } from '../../../bindings/loom/internal/service'
import { Button } from '../ui/button'

interface Props {
  recoveries: FilesystemHistoryRecovery[]
  loadError: string
  working: boolean
  onResolve: (
    recovery: FilesystemHistoryRecovery,
    action: 'retry' | 'cancel'
  ) => void
}

export function FilesystemHistoryRecoverySection({
  recoveries,
  loadError,
  working,
  onResolve,
}: Props) {
  if (recoveries.length === 0 && !loadError) return null

  return (
    <section
      className="mt-3 grid gap-2 rounded border border-warning/40 p-3"
      data-testid="pending-filesystem-history-recoveries"
    >
      <h3 className="text-sm font-semibold">
        <Trans>Filesystem history recovery needs attention</Trans>
      </h3>
      {loadError && (
        <p role="alert" className="text-sm text-danger">
          {loadError}
        </p>
      )}
      {recoveries.map((recovery) => (
        <div
          key={recovery.requestId}
          data-testid="pending-filesystem-history-recovery"
          className="grid gap-2 break-all rounded border border-border p-3 text-xs"
        >
          <p>{recovery.message}</p>
          <dl className="grid gap-1 text-ink-subtle">
            <Evidence
              label={<Trans>Request ID</Trans>}
              value={recovery.requestId}
            />
            <Evidence
              label={<Trans>Direction</Trans>}
              value={recovery.direction}
            />
            <Evidence
              label={<Trans>Operation</Trans>}
              value={`${recovery.kind} #${recovery.sequence}`}
            />
            <Evidence
              label={<Trans>Image ID</Trans>}
              value={String(recovery.imageId || '—')}
            />
            <Evidence
              label={<Trans>Source</Trans>}
              value={recovery.sourcePath || '—'}
            />
            <Evidence
              label={<Trans>Chosen destination</Trans>}
              value={recovery.destinationPath || 'not recorded'}
            />
            <Evidence label={<Trans>State</Trans>} value={recovery.state} />
          </dl>
          {recovery.legacyWithoutLedger && (
            <p className="text-danger">
              <Trans>
                This request predates the evidence ledger. Do not retry or
                cancel it automatically. Preserve both paths for manual
                inspection.
              </Trans>
            </p>
          )}
          {(recovery.canRetry || recovery.canCancel) && (
            <div className="flex flex-wrap gap-2">
              {recovery.canRetry && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={working}
                  onClick={() => onResolve(recovery, 'retry')}
                >
                  <Trans>Retry verified history move</Trans>
                </Button>
              )}
              {recovery.canCancel && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={working}
                  onClick={() => onResolve(recovery, 'cancel')}
                >
                  <Trans>Cancel; keep files and cursor</Trans>
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      <p className="text-xs text-ink-subtle">
        <Trans>
          Conflicting paths remain untouched. Loom does not infer a destination
          for requests created before this evidence ledger.
        </Trans>
      </p>
    </section>
  )
}

function Evidence({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-1">
      <dt>{label}:</dt>
      <dd>{value}</dd>
    </div>
  )
}

export function EvidenceLine({
  label,
  value,
}: {
  label: ReactNode
  value: string
}) {
  return (
    <span className="text-ink-subtle">
      <strong>{label}:</strong> {value}
    </span>
  )
}
