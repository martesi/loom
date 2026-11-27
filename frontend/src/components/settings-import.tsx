import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import { SettingsService } from '../../bindings/loom/internal/service'
import { useToast } from './ui/toast'

const key = 'import_mode'
type Mode = 'copy' | 'move' | 'link'

function modeOrDefault(value: string): Mode {
  return value === 'move' || value === 'link' ? value : 'copy'
}

export function ImportSettings({ repoPath }: { repoPath: string }) {
  const toast = useToast()
  const [mode, setMode] = useState<Mode>('copy')
  const [pending, setPending] = useState(true)

  useEffect(() => {
    let current = true
    void SettingsService.Get(repoPath, key).then(
      (value) => {
        if (!current) return
        setMode(modeOrDefault(value))
        setPending(false)
      },
      () => {
        if (!current) return
        toast.add({ title: t`Could not load the import setting` })
      }
    )
    return () => {
      current = false
    }
  }, [repoPath, toast])

  async function save(value: string) {
    setPending(true)
    const next = modeOrDefault(value)
    try {
      await SettingsService.Set(repoPath, key, next)
      setMode(next)
    } catch {
      toast.add({ title: t`Could not save the import setting` })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-1">
      <label htmlFor="settings-import-mode" className="text-sm">
        <Trans>Import files as</Trans>
      </label>
      <select
        id="settings-import-mode"
        aria-describedby="settings-import-mode-description"
        className="h-8 w-fit rounded border border-border bg-card px-2 text-sm"
        value={mode}
        disabled={pending}
        onChange={(event) => void save(event.currentTarget.value)}
      >
        <option value="copy">
          <Trans>Copy</Trans>
        </option>
        <option value="move">
          <Trans>Move</Trans>
        </option>
        <option value="link">
          <Trans>Link</Trans>
        </option>
      </select>
      <p
        id="settings-import-mode-description"
        className="text-xs text-ink-muted"
      >
        <Trans>
          Applies when importing from the desktop file picker. Clipboard import
          copies unless it is explicitly marked as cut.
        </Trans>
      </p>
    </div>
  )
}
