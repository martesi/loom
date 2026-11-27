import { Dialog } from '@base-ui-components/react/dialog'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { type ReactNode, useRef, useState } from 'react'
import { Button } from './ui/button'
import { useToast } from './ui/toast'

type Operation = 'rescan' | 'invalidate'

interface Props {
  children?: ReactNode
  repoPath: string | null
  rescanRepository: (repoPath: string) => Promise<number>
  invalidateRenditions: (repoPath: string) => Promise<number>
  refreshRepository: () => Promise<void>
  onRenditionsInvalidated: () => void
  sectionRef: (element: HTMLElement | null) => void
}

export function RepositorySettings(props: Props) {
  const {
    repoPath,
    rescanRepository,
    invalidateRenditions,
    refreshRepository,
    onRenditionsInvalidated,
    sectionRef,
  } = props
  const toast = useToast()
  const [pending, setPending] = useState<Operation | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const pendingRef = useRef(false)
  const unavailable = !repoPath

  function run(operation: Operation) {
    if (pendingRef.current || !repoPath) return
    pendingRef.current = true
    setPending(operation)
    setFeedback('')
    const request =
      operation === 'rescan'
        ? rescanRepository(repoPath)
        : invalidateRenditions(repoPath)
    void request
      .then((count) => {
        if (operation === 'invalidate') onRenditionsInvalidated()
        const result =
          operation === 'rescan'
            ? plural(count, {
                one: '# new or changed asset found.',
                other: '# new or changed assets found.',
              })
            : plural(count, {
                one: '# generated rendition removed.',
                other: '# generated renditions removed.',
              })
        return refreshRepository().then(
          () => {
            setFeedback(result)
            toast.add({ title: result })
          },
          (error: unknown) => {
            const message = t`${result} The operation succeeded, but the repository view could not be refreshed: ${errorMessage(error)}`
            setFeedback(message)
            toast.add({
              title: t`Repository refresh failed`,
              description: message,
            })
          }
        )
      })
      .catch((error: unknown) => {
        const detail = errorMessage(error)
        const message =
          operation === 'rescan'
            ? t`Rescan failed: ${detail}`
            : t`Cache invalidation failed: ${detail}`
        setFeedback(message)
        toast.add({ title: message })
      })
      .finally(() => {
        pendingRef.current = false
        setPending(null)
      })
  }

  return (
    <section
      ref={sectionRef}
      data-section="repository"
      aria-labelledby="settings-repository-heading"
      className="grid scroll-mt-16 content-start gap-3"
    >
      <h3 id="settings-repository-heading" className="text-sm font-semibold">
        <Trans>Repository</Trans>
      </h3>
      <p className="text-xs text-ink-muted">
        <Trans>Scan for source changes or remove generated renditions.</Trans>
      </p>
      {!repoPath && (
        <p className="text-xs text-ink-muted" role="status">
          <Trans>Open a repository to use repository actions.</Trans>
        </p>
      )}
      {props.children}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={unavailable || pending !== null}
          onClick={() => run('rescan')}
        >
          {pending === 'rescan' ? (
            <Trans>Rescanning…</Trans>
          ) : (
            <Trans>Rescan repository</Trans>
          )}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={unavailable || pending !== null}
          onClick={() => setConfirmOpen(true)}
        >
          <Trans>Invalidate cache</Trans>
        </Button>
      </div>
      <p
        aria-live="polite"
        role={feedback ? 'status' : undefined}
        className="min-h-4 text-xs text-ink-muted"
      >
        {pending === 'rescan' && <Trans>Rescanning repository…</Trans>}
        {pending === 'invalidate' && (
          <Trans>Removing generated renditions…</Trans>
        )}
        {feedback}
      </p>
      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[90] bg-black/30" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-[90] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-ink shadow-xl outline-none">
            <Dialog.Title className="text-sm font-semibold">
              <Trans>Invalidate generated renditions?</Trans>
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs leading-relaxed text-ink-muted">
              <Trans>
                This deletes generated renditions only. It never deletes source
                files.
              </Trans>
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>
                <Trans>Cancel</Trans>
              </Dialog.Close>
              <Button
                variant="danger"
                size="sm"
                disabled={pending !== null || unavailable}
                onClick={() => {
                  setConfirmOpen(false)
                  run('invalidate')
                }}
              >
                <Trans>Invalidate cache</Trans>
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
