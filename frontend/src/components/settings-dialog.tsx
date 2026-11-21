import { Dialog } from '@base-ui-components/react/dialog'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { CanvasAction } from '../lib/action-catalog'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import {
  preferencesStorageKey,
  readPreferences,
  type Preferences,
} from '../routes/root'

type Section = 'repository' | 'appearance' | 'keyboard'

export function SettingsDialog({
  initialSection = 'appearance',
  actions,
  onClose,
}: {
  initialSection?: Section
  actions: CanvasAction[]
  onClose: () => void
}) {
  const [section, setSection] = useState<Section>(initialSection)
  const initial = useRef(readPreferences())
  const [preferences, setPreferences] = useState(initial.current.value)
  const [storageFailed, setStorageFailed] = useState(initial.current.failed)
  const opener = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closed = useRef(false)

  useEffect(() => {
    return () => {
      if (!closed.current) return
      const target = opener.current
      if (target?.isConnected && target.getClientRects().length > 0) target.focus()
      else {
        const host = document.querySelector<HTMLElement>('[data-canvas-host], .react-flow')
        host?.focus()
      }
    }
  }, [])

  function close() {
    closed.current = true
    onCloseRef.current()
  }

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    const next = { ...preferences, [key]: value }
    setPreferences(next)
    window.dispatchEvent(new CustomEvent('loom:preferences-change', { detail: next }))
    try {
      localStorage.setItem(preferencesStorageKey, JSON.stringify({ ...next, version: 1 }))
      setStorageFailed(false)
    } catch (cause) {
      console.warn('Could not save preferences', cause)
      setStorageFailed(true)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[80] bg-black/30" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-[80] grid max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 grid-cols-1 gap-5 overflow-auto rounded-lg border border-black/10 bg-card p-5 text-ink shadow-xl outline-none sm:grid-cols-[10rem_1fr]">
          <header className="sm:col-span-2 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold"><Trans>Settings</Trans></Dialog.Title>
             <Dialog.Close render={<Button variant="ghost" size="sm" />}><Trans>Close</Trans></Dialog.Close>
          </header>
          <nav aria-label={t`Settings sections`} className="flex gap-2 sm:flex-col">
            <Button variant="ghost" size="sm" aria-current={section === 'repository' ? 'page' : undefined} onClick={() => setSection('repository')} className="justify-start"><Trans>Repository</Trans></Button>
            <Button variant="ghost" size="sm" aria-current={section === 'appearance' ? 'page' : undefined} onClick={() => setSection('appearance')} className="justify-start"><Trans>Appearance</Trans></Button>
            <Button variant="ghost" size="sm" aria-current={section === 'keyboard' ? 'page' : undefined} onClick={() => setSection('keyboard')} className="justify-start"><Trans>Keyboard</Trans></Button>
          </nav>
          <main aria-live="polite" className="min-h-48">
            {section === 'repository' ? (
              <div className="grid gap-4">
                <h3 className="text-sm font-semibold"><Trans>Repository</Trans></h3>
                <section aria-labelledby="repository-identity-heading" className="grid gap-1">
                  <h4 id="repository-identity-heading" className="text-sm font-medium"><Trans>Repository identity</Trans></h4>
                  <p className="text-sm text-ink-muted"><Trans>The repository name uses its folder name. Display-name overrides are not available yet.</Trans></p>
                  <p className="text-sm text-ink-muted"><Trans>Repository location is available in the repository selector.</Trans></p>
                </section>
                <section aria-labelledby="repository-trash-heading" className="grid gap-1">
                  <h4 id="repository-trash-heading" className="text-sm font-medium"><Trans>Trash retention</Trans></h4>
                  <p className="text-sm"><Trans>Trashed assets are retained for 30 days, then removed automatically during repository cleanup.</Trans></p>
                  <p className="text-sm text-ink-muted"><Trans>Unplacing keeps an asset in the repository. Trash removes it from active use. Permanent purge removes it immediately and cannot be undone.</Trans></p>
                </section>
                <section aria-labelledby="repository-import-heading" className="grid gap-1">
                  <h4 id="repository-import-heading" className="text-sm font-medium"><Trans>Import defaults</Trans></h4>
                  <p className="text-sm text-ink-muted"><Trans>Explicit file imports use the repository root and add assets without placing them on the Canvas. Import destination preferences are not available yet.</Trans></p>
                  <p className="text-sm text-ink-muted"><Trans>Clipboard paste continues to use the repository root and places assets only when the Canvas has focus.</Trans></p>
                </section>
              </div>
            ) : section === 'appearance' ? (
              <div className="grid gap-4">
                <h3 className="text-sm font-semibold"><Trans>Appearance</Trans></h3>
                <label className="grid gap-1 text-sm">
                  <span><Trans>Theme</Trans></span>
                  <Select value={preferences.theme} onValueChange={(value) => {
                    const parsed = z.enum(['system', 'light', 'dark']).safeParse(value)
                    if (parsed.success) update('theme', parsed.data)
                  }}>
                    <SelectTrigger aria-label={t`Theme`} className="h-10 w-full rounded border border-black/15 bg-card px-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system"><Trans>System</Trans></SelectItem>
                      <SelectItem value="light"><Trans>Light</Trans></SelectItem>
                      <SelectItem value="dark"><Trans>Dark</Trans></SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span><Trans>Density</Trans></span>
                  <Select value={preferences.density} onValueChange={(value) => {
                    const parsed = z.enum(['comfortable', 'compact']).safeParse(value)
                    if (parsed.success) update('density', parsed.data)
                  }}>
                    <SelectTrigger aria-label={t`Density`} className="h-10 w-full rounded border border-black/15 bg-card px-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="comfortable"><Trans>Comfortable</Trans></SelectItem>
                      <SelectItem value="compact"><Trans>Compact</Trans></SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={preferences.showTitle} onChange={(event) => update('showTitle', event.target.checked)} />
                  <Trans>Show titles</Trans>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={preferences.showResolution} onChange={(event) => update('showResolution', event.target.checked)} />
                  <Trans>Show resolution</Trans>
                </label>
                {storageFailed && <p role="status"><Trans>Changes will not be saved on this device.</Trans></p>}
              </div>
            ) : (
              <div>
                <h3 className="mb-3 text-sm font-semibold"><Trans>Keyboard</Trans></h3>
                <div className="grid gap-4">
                  {[...new Set(actions.filter((action) => action.shortcut).map((action) => action.category))].map((category) => (
                    <section key={category} aria-label={category}>
                      <h4 className="mb-1 text-xs font-semibold text-ink-muted">{category}</h4>
                      <ul className="grid gap-1">
                        {actions.filter((action) => action.shortcut && action.category === category).map((action) => (
                          <li key={action.id} className="flex items-start justify-between gap-4 rounded px-2 py-1.5 text-sm">
                            <span>{action.label}<span className="ml-2 text-xs text-ink-muted">{action.context}</span></span>
                            <Kbd className="shrink-0 text-xs text-ink-muted">{action.shortcut}</Kbd>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  <p className="text-xs text-ink-muted"><Trans>Canvas gestures: scroll to pan, Ctrl/Cmd + scroll to zoom, Space + drag to pan; pinch to zoom; drag from a connection handle to create a relationship.</Trans></p>
                </div>
              </div>
            )}
          </main>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
