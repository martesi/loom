import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import type { PromptInfo } from '../../../bindings/loom/internal/service'
import { PromptService } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'
import type { CanvasBoardOwner } from './canvas-board-owner'
import { canvasEffects } from './canvas-operation-effects'

interface PromptPickerProps {
  x: number
  y: number
  repoPath: string
  imageId: number
  owner: CanvasBoardOwner
  onClose: () => void
  onChange: () => void
}

// Manual prompt attach/reuse picker (docs/init.md Stage 1's "browse-and-pick
// list over the managed prompt library... backed by FindOrCreate-by-hash so
// picking and dedup don't fight" — never built until now). Two halves, same
// shape as tag-picker.tsx: a "reuse" list of existing prompts (name, falling
// back to a text snippet when unnamed, per spec) and an "attach new" form
// that creates one via find-or-create.
export function PromptPicker({
  x,
  y,
  repoPath,
  imageId,
  owner,
  onClose,
  onChange,
}: PromptPickerProps) {
  const [prompts, setPrompts] = useState<PromptInfo[]>([])
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [negative, setNegative] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void owner
      .submit(
        {
          kind: 'read',
          capability: 'metadata',
          board: owner.getSnapshot(),
        },
        (context) => context.prepare(() => PromptService.ListPrompts(repoPath))
      )
      .then((outcome) => {
        if (outcome.status === 'success') setPrompts(outcome.value ?? [])
        else if (outcome.status === 'failed') console.error(outcome.error)
        else if (outcome.status === 'rejected')
          console.error('prompt list operation rejected', outcome.reason)
      })
  }, [owner, repoPath])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const attach = async (promptId: number) => {
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'metadata',
        board: owner.getSnapshot(),
      },
      (context) =>
        canvasEffects.attachPrompt(context, repoPath, imageId, promptId)
    )
    if (outcome.status !== 'success') return
    onChange()
    onClose()
  }

  const createAndAttach = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    const outcome = await owner.submit(
      {
        kind: 'mutation',
        capability: 'metadata',
        board: owner.getSnapshot(),
      },
      (context) =>
        canvasEffects.createAndAttachPrompt(
          context,
          repoPath,
          imageId,
          name.trim(),
          trimmed,
          negative.trim()
        )
    )
    if (outcome.status !== 'success') return
    onChange()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 flex w-72 flex-col gap-2 rounded-lg border border-black/8 bg-card p-3 shadow-lg"
      style={{ left: x, top: y }}
    >
      {prompts.length > 0 && (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-subtle">
            <Trans>Reuse a prompt</Trans>
          </div>
          <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {prompts.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => attach(p.id)}
                className="flex flex-col items-start rounded-sm px-2 py-1 text-left hover:bg-primary-soft"
              >
                <span className="truncate text-[11.5px] font-medium text-ink">
                  {p.name || p.text}
                </span>
                {p.name && (
                  <span className="truncate text-[10.5px] text-ink-subtle">
                    {p.text}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-subtle">
          <Trans>Attach new prompt</Trans>
        </div>
        <div className="flex flex-col gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t`Name (optional)`}
            aria-label={t`Prompt name (optional)`}
            className={cn(
              'w-full rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary'
            )}
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t`Prompt text…`}
            aria-label={t`Prompt text`}
            rows={3}
            className={cn(
              'w-full resize-none rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary'
            )}
          />
          <input
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
            placeholder={t`Negative prompt (optional)`}
            aria-label={t`Negative prompt (optional)`}
            className={cn(
              'w-full rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary'
            )}
          />
          <button
            type="button"
            onClick={createAndAttach}
            disabled={!text.trim()}
            className="rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
          >
            <Trans>Attach</Trans>
          </button>
        </div>
      </div>
    </div>
  )
}
