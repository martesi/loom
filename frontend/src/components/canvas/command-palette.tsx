import { Dialog } from '@base-ui-components/react/dialog'
import { t } from '@lingui/core/macro'
import { Command, Search } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import {
  type CanvasAction,
  fuzzyMatch,
  searchActions,
} from '../../lib/action-catalog'
import { Input } from '../ui/input'
import { ShortcutKeys } from '../ui/tooltip'

export interface PaletteAsset {
  id: number
  fileName: string
  filePath: string
  tags: string[]
}

interface Props {
  open: boolean
  shortcutsOnly?: boolean
  initialQuery?: string
  actions: CanvasAction[]
  recentActionIds?: string[]
  assets: PaletteAsset[]
  onOpenChange: (open: boolean) => void
  onRunAction: (action: CanvasAction) => void
  onChooseAsset: (asset: PaletteAsset) => void
}

export function CommandPalette({
  open,
  shortcutsOnly = false,
  initialQuery = '',
  actions,
  recentActionIds = [],
  assets,
  onOpenChange,
  onRunAction,
  onChooseAsset,
}: Props) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const trimmed = query.trim()
  const assetMode = trimmed.startsWith('@')
  const search = trimmed.replace(/^[>@]\s*/, '')
  const searchedCommands = searchActions(
    shortcutsOnly ? actions.filter((action) => action.shortcut) : actions,
    search
  )
  const recentCommands =
    !shortcutsOnly && !search
      ? recentActionIds.flatMap((id) => {
          const action = actions.find((candidate) => candidate.id === id)
          return action
            ? [
                {
                  action,
                  match: { score: Number.MAX_SAFE_INTEGER, positions: [] },
                },
              ]
            : []
        })
      : []
  const recentIds = new Set(recentCommands.map(({ action }) => action.id))
  const commandResults = [
    ...recentCommands,
    ...searchedCommands.filter(({ action }) => !recentIds.has(action.id)),
  ]
  const assetResults = assetMode
    ? assets
        .flatMap((asset) => {
          const match = [asset.fileName, asset.filePath, ...asset.tags]
            .map((value) => fuzzyMatch(search, value))
            .filter((match) => match !== null)
            .sort((left, right) => right.score - left.score)[0]
          return match ? [{ asset, match }] : []
        })
        .sort((left, right) => right.match.score - left.match.score)
        .slice(0, 50)
    : []
  const resultCount = assetMode ? assetResults.length : commandResults.length
  const selectedIndex = Math.min(activeIndex, Math.max(0, resultCount - 1))
  const activeResultId = assetMode
    ? assetResults[selectedIndex]?.asset.id
    : commandResults[selectedIndex]?.action.id
  function optionId(index: number, resultId: string | number) {
    return `${listId}-option-${encodeURIComponent(search)}-${resultCount}-${index}-${resultId}`
  }
  const activeOptionId =
    activeResultId === undefined
      ? undefined
      : optionId(selectedIndex, activeResultId)

  useEffect(() => {
    if (open) {
      setQuery(initialQuery)
      setActiveIndex(0)
    }
  }, [open, initialQuery])

  useEffect(() => {
    if (!open || !activeOptionId) return
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeOptionId, open])

  function runActive() {
    if (assetMode) {
      const result = assetResults[selectedIndex]
      if (result) onChooseAsset(result.asset)
      return
    }
    const result = commandResults[selectedIndex]
    if (result?.action.enabled) onRunAction(result.action)
  }

  function focusResult(index: number) {
    const resultId = assetMode
      ? assetResults[index]?.asset.id
      : commandResults[index]?.action.id
    if (resultId === undefined) return
    document.getElementById(optionId(index, resultId))?.focus()
  }

  function moveActive(delta: number) {
    const nextIndex = Math.max(
      0,
      Math.min(resultCount - 1, selectedIndex + delta)
    )
    const focusIsOnResult =
      document.activeElement?.getAttribute('role') === 'option'
    setActiveIndex(nextIndex)
    if (focusIsOnResult) focusResult(nextIndex)
  }

  function activateHoveredResult(index: number) {
    if (document.activeElement?.getAttribute('role') === 'option') return
    setActiveIndex(index)
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] motion-reduce:backdrop-blur-none" />
        <Dialog.Popup
          data-testid="command-palette"
          className="fixed left-1/2 top-[min(18vh,140px)] z-50 flex max-h-[min(620px,75vh)] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveActive(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveActive(-1)
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              runActive()
            }
          }}
        >
          <Dialog.Title className="sr-only">
            {shortcutsOnly ? t`Keyboard shortcuts` : t`Command palette`}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {t`Search commands or type at sign to search repository assets.`}
          </Dialog.Description>
          <div
            data-testid="command-palette-input-shell"
            className="flex h-11 shrink-0 items-center border-b border-border px-3.5"
          >
            {assetMode ? (
              <span className="mr-2 shrink-0 text-sm font-semibold text-ink-subtle">
                @
              </span>
            ) : trimmed.startsWith('>') ? (
              <Command className="mr-2 h-4 w-4 shrink-0 text-ink-subtle" />
            ) : (
              <Search className="mr-2 h-4 w-4 shrink-0 text-ink-subtle" />
            )}
            <Input
              data-testid="command-palette-input"
              role="combobox"
              aria-label={
                shortcutsOnly
                  ? t`Search keyboard shortcuts`
                  : t`Search commands`
              }
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              placeholder={
                shortcutsOnly
                  ? t`Search shortcuts`
                  : t`Search commands or @ assets`
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              className="h-11 rounded-none border-0 bg-transparent px-1 text-sm font-normal text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-0 focus-visible:ring-0"
            />
          </div>
          <div className="flex items-center justify-between px-4 py-2 text-[11px] text-ink-muted">
            <span>
              {assetMode
                ? t`Repository assets`
                : shortcutsOnly
                  ? t`Keyboard shortcuts`
                  : t`Commands`}
            </span>
            <span
              aria-live="polite"
              role="status"
            >{t`${resultCount} results`}</span>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={assetMode ? t`Repository assets` : t`Commands`}
            className="min-h-0 overflow-y-auto p-1.5"
          >
            {assetMode
              ? assetResults.map(({ asset }, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    id={optionId(index, asset.id)}
                    key={asset.id}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      event.stopPropagation()
                      onChooseAsset(asset)
                    }}
                    onMouseMove={() => activateHoveredResult(index)}
                    onClick={() => onChooseAsset(asset)}
                    className="flex w-full items-center justify-between gap-4 rounded-md px-3 py-2.5 text-left aria-selected:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">
                        {asset.fileName}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {asset.filePath}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-subtle">{t`Asset`}</span>
                  </button>
                ))
              : commandResults.map(({ action }, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    aria-disabled={!action.enabled}
                    id={optionId(index, action.id)}
                    key={action.id}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      event.stopPropagation()
                      if (action.enabled) onRunAction(action)
                    }}
                    onMouseMove={() => activateHoveredResult(index)}
                    onClick={() => action.enabled && onRunAction(action)}
                    className="flex w-full items-start justify-between gap-4 rounded-md px-3 py-2.5 text-left aria-selected:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 aria-disabled:opacity-55"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-sm font-medium text-ink">
                          {highlight(action.label, search)}
                        </span>
                        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
                          {recentIds.has(action.id)
                            ? `${t`Recent`} · ${action.category}`
                            : action.category}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {action.enabled
                          ? action.description
                          : action.disabledReason}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1 text-[10px] text-ink-subtle">
                      {action.shortcut && (
                        <ShortcutKeys shortcut={action.shortcut} />
                      )}
                      <span>{action.context}</span>
                    </span>
                  </button>
                ))}
            {resultCount === 0 && (
              <p className="px-3 py-8 text-center text-sm text-ink-muted">
                {assetMode ? t`No matching assets` : t`No matching commands`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[10px] text-ink-subtle">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> {t`Navigate`}
            </span>
            <span>
              <kbd>↵</kbd> {t`Run`}
            </span>
            <span>
              <kbd>Esc</kbd> {t`Close`}
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function highlight(label: string, query: string) {
  const match = fuzzyMatch(query, label)
  const positions = new Set(match?.positions ?? [])
  const occurrenceByCharacter = new Map<string, number>()
  return [...label].map((character, index) => {
    const occurrence = occurrenceByCharacter.get(character) ?? 0
    occurrenceByCharacter.set(character, occurrence + 1)
    return positions.has(index) ? (
      <mark
        key={`${character}-${occurrence}`}
        className="rounded-sm bg-primary/20 text-inherit"
      >
        {character}
      </mark>
    ) : (
      character
    )
  })
}
