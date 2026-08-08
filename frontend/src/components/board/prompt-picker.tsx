import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import type { PromptInfo } from '../../../bindings/loom/internal/service'
import { PromptService } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'

interface PromptPickerProps {
  x: number
  y: number
  repoPath: string
  imageId: number
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
  onClose,
  onChange,
}: PromptPickerProps) {
  const [prompts, setPrompts] = useState<PromptInfo[]>([])
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [negative, setNegative] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    PromptService.ListPrompts(repoPath).then((list) => setPrompts(list ?? []))
  }, [repoPath])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const attach = async (promptId: number) => {
    await PromptService.AttachPrompt(repoPath, imageId, promptId)
    onChange()
    onClose()
  }

  const createAndAttach = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    await PromptService.CreateAndAttachPrompt(
      repoPath,
      imageId,
      name.trim(),
      trimmed,
      negative.trim()
    )
    onChange()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 flex w-72 flex-col gap-2 rounded-lg border border-black/8 bg-white p-3 shadow-lg"
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
                className="flex flex-col items-start rounded-sm px-2 py-1 text-left hover:bg-accent-soft"
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
            className={cn(
              'w-full rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent'
            )}
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t`Prompt text…`}
            rows={3}
            className={cn(
              'w-full resize-none rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent'
            )}
          />
          <input
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
            placeholder={t`Negative prompt (optional)`}
            className={cn(
              'w-full rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent'
            )}
          />
          <button
            type="button"
            onClick={createAndAttach}
            disabled={!text.trim()}
            className="rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
          >
            <Trans>Attach</Trans>
          </button>
        </div>
      </div>
    </div>
  )
}
