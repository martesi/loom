import { Dialog } from '@base-ui-components/react/dialog'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  type CanvasAction,
  displayShortcut,
  isMacPlatform,
  normalizeShortcut,
  shortcutForEvent,
} from '../lib/action-catalog'
import {
  type Preferences,
  preferencesStorageKey,
  readPreferences,
} from '../lib/preferences'
import {
  readShortcutOverrides,
  shortcutParts,
  writeShortcutOverrides,
} from '../lib/shortcut-overrides'
import { AppearanceSettings } from './settings-appearance'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'

type Section = 'appearance' | 'keyboard'

const sections: Section[] = ['appearance', 'keyboard']

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

// Glyphs for multi-character keys; everything else goes through
// displayShortcut per part so combos render as separate Kbd chips with no
// '+' separators.
const KEY_GLYPHS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  escape: 'Esc',
  enter: '↵',
  delete: 'Del',
  backspace: '⌫',
  tab: 'Tab',
  ' ': 'Space',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
}

function prettyKey(part: string, isMac: boolean): string {
  return (
    KEY_GLYPHS[part] ??
    (/^f\d{1,2}$/.test(part)
      ? part.toUpperCase()
      : displayShortcut(part, isMac))
  )
}

export function SettingsDialog({
  initialSection = 'appearance',
  actions,
  defaultShortcuts,
  onClose,
}: {
  initialSection?: Section
  actions: CanvasAction[]
  defaultShortcuts: Record<string, string>
  onClose: () => void
}) {
  const [active, setActive] = useState<Section>(initialSection)
  const initial = useRef(readPreferences())
  const [preferences, setPreferences] = useState(initial.current.value)
  const [storageFailed, setStorageFailed] = useState(initial.current.failed)
  const [overrides, setOverrides] = useState(readShortcutOverrides)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const isMac = isMacPlatform()
  const popupRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<Section, HTMLElement | null>>({
    appearance: null,
    keyboard: null,
  })
  const opener = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  )
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closed = useRef(false)

  useEffect(() => {
    return () => {
      if (!closed.current) return
      const target = opener.current
      if (target?.isConnected && target.getClientRects().length > 0)
        target.focus()
      else {
        const host = document.querySelector<HTMLElement>(
          '[data-canvas-host], .react-flow'
        )
        host?.focus()
      }
    }
  }, [])

  // Menu scroll-spy: highlight the section currently at the top of the dialog.
  useEffect(() => {
    const root = popupRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const id = (entry.target as HTMLElement).dataset.section as Section
          if (id) setActive(id)
        }
      },
      { root, rootMargin: '-16px 0px -70% 0px', threshold: 0 }
    )
    for (const section of sections) {
      const element = sectionRefs.current[section]
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [])

  // Opening from the keyboard-shortcuts help lands on that section.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial section only.
  useEffect(() => {
    sectionRefs.current[initialSection]?.scrollIntoView({ block: 'start' })
  }, [])

  function scrollTo(section: Section) {
    setActive(section)
    sectionRefs.current[section]?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  function saveOverride(id: string, shortcut: string | null) {
    setOverrides((current) => {
      const next = { ...current }
      const fallback = defaultShortcuts[id]
      if (
        shortcut === null ||
        (fallback &&
          normalizeShortcut(shortcut) === normalizeShortcut(fallback))
      ) {
        delete next[id]
      } else if (shortcut) {
        next[id] = normalizeShortcut(shortcut)
      }
      writeShortcutOverrides(next)
      return next
    })
  }

  // Capture the next key press as the shortcut. Escape cancels instead of
  // recording (it stays a dialog-dismiss key).
  // biome-ignore lint/correctness/useExhaustiveDependencies: capture the saveOverride set at recording start.
  useEffect(() => {
    if (!recordingId) return
    const capture = (event: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(event.key) || event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      const id = recordingId
      setRecordingId(null)
      if (
        event.key === 'Escape' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      )
        return
      saveOverride(id, shortcutForEvent(event))
    }
    window.addEventListener('keydown', capture, true)
    return () => window.removeEventListener('keydown', capture, true)
  }, [recordingId])

  function close() {
    closed.current = true
    setRecordingId(null)
    onCloseRef.current()
  }

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    const next = { ...preferences, [key]: value }
    setPreferences(next)
    window.dispatchEvent(
      new CustomEvent('loom:preferences-change', { detail: next })
    )
    try {
      localStorage.setItem(
        preferencesStorageKey,
        JSON.stringify({ ...next, version: 1 })
      )
      setStorageFailed(false)
    } catch (cause) {
      console.warn('Could not save preferences', cause)
      setStorageFailed(true)
    }
  }

  const effectiveOf = (action: CanvasAction) =>
    overrides[action.id] ?? action.shortcut ?? ''
  const conflictsOf = (action: CanvasAction) => {
    const combo = effectiveOf(action)
    if (!combo) return null
    const normalized = normalizeShortcut(combo)
    return (
      actions.find(
        (other) =>
          other.id !== action.id &&
          other.shortcut &&
          normalizeShortcut(other.shortcut) === normalized
      ) ?? null
    )
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[80] bg-black/30" />
        <Dialog.Popup
          ref={popupRef}
          className="fixed left-1/2 top-1/2 z-[80] grid max-h-[calc(100dvh-2rem)] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 grid-cols-1 gap-4 overflow-auto rounded-lg border border-black/10 bg-card p-4 text-ink shadow-xl outline-none sm:grid-cols-[10rem_1fr]"
        >
          <header className="sm:col-span-2 flex items-center justify-between gap-2">
            <Dialog.Title className="text-base font-semibold">
              <Trans>Settings</Trans>
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t`Close`}
                  className="h-8 w-8 !px-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              }
            />
          </header>
          <nav
            aria-label={t`Settings sections`}
            className="flex gap-2 sm:sticky sm:top-0 sm:self-start sm:flex-col"
          >
            {sections.map((section) => (
              <Button
                key={section}
                variant="ghost"
                size="sm"
                aria-current={active === section ? 'page' : undefined}
                onClick={() => scrollTo(section)}
                className="justify-start"
              >
                {section === 'appearance' ? (
                  <Trans>Appearance</Trans>
                ) : (
                  <Trans>Keyboard</Trans>
                )}
              </Button>
            ))}
          </nav>
          <main aria-live="polite" className="grid min-h-48 gap-6">
            <AppearanceSettings
              preferences={preferences}
              storageFailed={storageFailed}
              onChange={update}
              sectionRef={(element) => {
                sectionRefs.current.appearance = element
              }}
            />
            <section
              ref={(element) => {
                sectionRefs.current.keyboard = element
              }}
              data-section="keyboard"
              aria-labelledby="settings-keyboard-heading"
              className="grid scroll-mt-2 content-start gap-3"
            >
              <h3
                id="settings-keyboard-heading"
                className="text-sm font-semibold"
              >
                <Trans>Keyboard</Trans>
              </h3>
              <div className="grid gap-4">
                {[
                  ...new Set(
                    actions
                      .filter((action) => action.shortcut)
                      .map((action) => action.category)
                  ),
                ].map((category) => (
                  <section key={category} aria-label={category}>
                    <h4 className="mb-1 text-xs font-semibold text-ink-muted">
                      {category}
                    </h4>
                    <ul className="grid gap-1">
                      {actions
                        .filter(
                          (action) =>
                            action.shortcut && action.category === category
                        )
                        .map((action) => {
                          const effective = effectiveOf(action)
                          const customized = overrides[action.id] !== undefined
                          const conflict = action.customizable
                            ? conflictsOf(action)
                            : null
                          return (
                            <li
                              key={action.id}
                              className="flex items-start justify-between gap-4 rounded px-2 py-1.5 text-sm"
                            >
                              <span>
                                {action.label}
                                <span className="ml-2 text-xs text-ink-muted">
                                  {action.context}
                                </span>
                              </span>
                              <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                {conflict && (
                                  <span className="text-[11px] text-danger">
                                    <Trans>
                                      Also triggers {conflict.label}
                                    </Trans>
                                  </span>
                                )}
                                {action.customizable ? (
                                  <>
                                    <button
                                      type="button"
                                      data-testid="shortcut-change"
                                      aria-label={t`Change shortcut for ${action.label}`}
                                      title={t`Change shortcut`}
                                      onClick={() =>
                                        setRecordingId(
                                          recordingId === action.id
                                            ? null
                                            : action.id
                                        )
                                      }
                                      className="flex h-8 min-w-24 items-center justify-center gap-1 rounded border border-black/15 bg-card px-2 outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40"
                                    >
                                      {recordingId === action.id ? (
                                        <span className="text-xs text-ink-muted">
                                          <Trans>Press keys…</Trans>
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1">
                                          {shortcutParts(effective).map(
                                            (part) => (
                                              <Kbd
                                                key={part}
                                                className="text-xs text-ink-muted"
                                              >
                                                {prettyKey(part, isMac)}
                                              </Kbd>
                                            )
                                          )}
                                        </span>
                                      )}
                                    </button>
                                    {customized && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        data-testid="shortcut-reset"
                                        onClick={() =>
                                          saveOverride(action.id, null)
                                        }
                                      >
                                        <Trans>Reset</Trans>
                                      </Button>
                                    )}
                                  </>
                                ) : (
                                  <span className="inline-flex items-center gap-1">
                                    {shortcutParts(effective).map((part) => (
                                      <Kbd
                                        key={part}
                                        className="text-xs text-ink-muted"
                                      >
                                        {prettyKey(part, isMac)}
                                      </Kbd>
                                    ))}
                                  </span>
                                )}
                              </span>
                            </li>
                          )
                        })}
                    </ul>
                  </section>
                ))}
                <p className="text-xs text-ink-muted">
                  <Trans>
                    Canvas gestures: scroll to pan, Ctrl/Cmd + scroll to zoom,
                    Space + drag to pan; pinch to zoom; drag from a connection
                    handle to create a relationship.
                  </Trans>
                </p>
              </div>
            </section>
          </main>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
