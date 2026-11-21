import { Dialog } from '@base-ui-components/react/dialog'
import { t } from '@lingui/core/macro'
import { Command, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import {
  type CanvasAction,
  fuzzyMatch,
  searchActions,
} from '../../lib/action-catalog'
import { Input } from '../ui/input'
import { Kbd, KbdGroup } from '../ui/kbd'
import { CommandPaletteResults } from './command-palette-results'

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
  assetsLoading?: boolean
  assetsError?: boolean
  onRetryAssets?: () => void
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
  assetsLoading = false,
  assetsError = false,
  onRetryAssets,
  onOpenChange,
  onRunAction,
  onChooseAsset,
}: Props) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const composing = useRef(false)
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
  const groupedShortcutResults = shortcutsOnly
    ? commandResults.reduce(
        (groups, result) => {
          const category = result.action.category
          const group = groups.find((item) => item.category === category)
          if (group) group.results.push(result)
          else groups.push({ category, results: [result] })
          return groups
        },
        [] as { category: string; results: typeof commandResults }[]
      )
    : []
  const navigableCommands = shortcutsOnly
    ? groupedShortcutResults.flatMap(({ results }) => results)
    : commandResults
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
  const resultCount = assetMode ? assetResults.length : navigableCommands.length
  const selectedIndex = Math.min(activeIndex, Math.max(0, resultCount - 1))
  const activeResultId = assetMode
    ? assetResults[selectedIndex]?.asset.id
    : navigableCommands[selectedIndex]?.action.id
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
    const result = navigableCommands[selectedIndex]
    if (result?.action.enabled) onRunAction(result.action)
  }

  function focusResult(index: number) {
    const resultId = assetMode
      ? assetResults[index]?.asset.id
      : navigableCommands[index]?.action.id
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
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveActive(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveActive(-1)
            }
            if (event.key === 'Enter') {
              if ((event.target as HTMLElement).tagName === 'BUTTON') return
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
                  : t`Commands · > commands · @ assets`
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
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
          <CommandPaletteResults
            listId={listId}
            assetMode={assetMode}
            assetsLoading={assetsLoading}
            assetsError={assetsError}
            onRetryAssets={onRetryAssets}
            assetResults={assetResults}
            selectedIndex={selectedIndex}
            optionId={optionId}
            onChooseAsset={onChooseAsset}
            composing={composing}
            setActiveIndex={setActiveIndex}
            activateHoveredResult={activateHoveredResult}
            shortcutsOnly={shortcutsOnly}
            groupedShortcutResults={groupedShortcutResults}
            navigableCommands={navigableCommands}
            commandResults={commandResults}
            recentIds={recentIds}
            search={search}
            resultCount={resultCount}
            onRunAction={onRunAction}
          />
          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[10px] text-ink-subtle">
            <span className="inline-flex items-center gap-1">
              <KbdGroup>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>{' '}
              {t`Navigate`}
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> {t`Run`}
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> {t`Close`}
            </span>
            {!shortcutsOnly && (
              <span className="ml-auto inline-flex items-center gap-1">
                <Kbd>?</Kbd> {t`Help`}
              </span>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
