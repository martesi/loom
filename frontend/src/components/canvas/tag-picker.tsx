import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TagInfo } from '../../../bindings/loom/internal/service'
import { TagService } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'

interface TagPickerProps {
  x: number
  y: number
  repoPath: string
  imageId: number
  allTagNames: string[]
  onClose: () => void
  onChange: () => void
}

// Minimal add/remove tag UI (mockup sections 3/4: chips with a dashed
// "+ add" affordance). Tags are free-form — typing a new name creates it
// via TagService.AddTag's find-or-create. Fetches the image's current tags
// itself so the context menu that opens this doesn't need to thread stale
// tag state through.
export function TagPicker({
  x,
  y,
  repoPath,
  imageId,
  allTagNames,
  onClose,
  onChange,
}: TagPickerProps) {
  const [value, setValue] = useState('')
  const [currentTags, setCurrentTags] = useState<TagInfo[]>([])
  const ref = useRef<HTMLDivElement>(null)

  const refresh = () => {
    TagService.TagsForImage(repoPath, imageId).then((tags) =>
      setCurrentTags(tags ?? [])
    )
  }
  useEffect(refresh, [repoPath, imageId])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const submit = async () => {
    const name = value.trim()
    if (!name) return
    await TagService.AddTag(repoPath, imageId, name)
    setValue('')
    refresh()
    onChange()
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 flex w-64 flex-col gap-2 rounded-lg border border-black/8 bg-white p-3 shadow-lg"
      style={{ left: x, top: y }}
    >
      <div className="flex flex-wrap gap-1.5">
        {currentTags.map((tag) => (
          <span
            key={tag.id}
            className="flex items-center gap-1 rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted"
          >
            {tag.name}
            <button
              type="button"
              onClick={async () => {
                await TagService.RemoveTag(repoPath, imageId, tag.id)
                refresh()
                onChange()
              }}
              className="text-ink-subtle hover:text-danger"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {currentTags.length === 0 && (
          <span className="text-[11px] text-ink-subtle">
            <Trans>No tags yet</Trans>
          </span>
        )}
      </div>
      <input
        list="loom-tag-suggestions"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          e.stopPropagation()
        }}
        placeholder={t`Add a tag…`}
        className={cn(
          'w-full rounded-md border border-black/12 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary'
        )}
      />
      <datalist id="loom-tag-suggestions">
        {allTagNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  )
}
