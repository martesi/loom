import { t } from '@lingui/core/macro'
import {
  type CanvasAction,
  type FuzzyMatch,
  fuzzyMatch,
  type searchActions,
} from '../../lib/action-catalog'
import { Button } from '../ui/button'
import { ShortcutKeys } from '../ui/tooltip'
import type { PaletteAsset } from './command-palette'

type CommandResult = ReturnType<typeof searchActions>[number]
type AssetResult = { asset: PaletteAsset; match: FuzzyMatch }

interface Props {
  listId: string
  assetMode: boolean
  assetsLoading: boolean
  assetsError: boolean
  onRetryAssets?: () => void
  assetResults: AssetResult[]
  selectedIndex: number
  optionId: (index: number, resultId: string | number) => string
  onChooseAsset: (asset: PaletteAsset) => void
  composing: { current: boolean }
  setActiveIndex: (index: number) => void
  activateHoveredResult: (index: number) => void
  shortcutsOnly: boolean
  groupedShortcutResults: { category: string; results: CommandResult[] }[]
  navigableCommands: CommandResult[]
  commandResults: CommandResult[]
  recentIds: Set<string>
  search: string
  resultCount: number
  onRunAction: (action: CanvasAction) => void
}

export function CommandPaletteResults({
  listId,
  assetMode,
  assetsLoading,
  assetsError,
  onRetryAssets,
  assetResults,
  selectedIndex,
  optionId,
  onChooseAsset,
  composing,
  setActiveIndex,
  activateHoveredResult,
  shortcutsOnly,
  groupedShortcutResults,
  navigableCommands,
  commandResults,
  recentIds,
  search,
  resultCount,
  onRunAction,
}: Props) {
  return (
    <div
      id={listId}
      role="listbox"
      aria-label={assetMode ? t`Repository assets` : t`Commands`}
      className="min-h-0 overflow-y-auto p-1.5"
    >
      {assetMode && assetsLoading ? (
        <p
          role="status"
          className="px-3 py-8 text-center text-sm text-ink-muted"
        >{t`Loading assets…`}</p>
      ) : assetMode && assetsError ? (
        <div className="px-3 py-8 text-center text-sm text-ink-muted">
          <p>{t`Could not load repository assets.`}</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onRetryAssets}
            className="mt-2"
          >{t`Retry`}</Button>
        </div>
      ) : assetMode ? (
        assetResults.map(({ asset }, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            id={optionId(index, asset.id)}
            key={asset.id}
            onFocus={() => setActiveIndex(index)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                composing.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              )
                return
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
                {highlight(asset.fileName, search)}
              </span>
              <span className="block truncate text-xs text-ink-muted">
                {highlight(asset.filePath, search)}
              </span>
              {asset.tags.length > 0 && (
                <span className="block truncate text-[10px] text-ink-subtle">
                  {asset.tags.map((tag, tagIndex) => (
                    <span key={tag}>
                      {tagIndex > 0 ? ' · ' : ''}
                      {highlight(tag, search)}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-subtle">{t`Asset`}</span>
          </button>
        ))
      ) : shortcutsOnly ? (
        groupedShortcutResults.map(({ category, results }) => (
          <section key={category} aria-label={category}>
            <h3 className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
              {category}
            </h3>
            {results.map(({ action }) => {
              const index = navigableCommands.findIndex(
                (result) => result.action.id === action.id
              )
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  aria-disabled={!action.enabled}
                  id={optionId(index, action.id)}
                  key={action.id}
                  onFocus={() => setActiveIndex(index)}
                  onKeyDown={(event) => {
                    if (
                      event.key !== 'Enter' ||
                      composing.current ||
                      event.nativeEvent.isComposing ||
                      event.keyCode === 229
                    )
                      return
                    event.preventDefault()
                    event.stopPropagation()
                    if (action.enabled) onRunAction(action)
                  }}
                  onMouseMove={() => activateHoveredResult(index)}
                  onClick={() => action.enabled && onRunAction(action)}
                  className="flex w-full items-start justify-between gap-4 rounded-md px-3 py-2.5 text-left aria-selected:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 aria-disabled:opacity-55"
                >
                  <span className="text-sm font-medium text-ink">
                    {action.label}
                    <span className="ml-2 text-xs text-ink-muted">
                      {action.context}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-subtle">
                    {(
                      action.shortcuts ??
                      (action.shortcut ? [action.shortcut] : [])
                    ).map((shortcut) => (
                      <ShortcutKeys key={shortcut} shortcut={shortcut} />
                    ))}
                  </span>
                </button>
              )
            })}
          </section>
        ))
      ) : (
        commandResults.map(({ action }, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            aria-disabled={!action.enabled}
            id={optionId(index, action.id)}
            key={action.id}
            onFocus={() => setActiveIndex(index)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                composing.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              )
                return
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
                {action.enabled ? action.description : action.disabledReason}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1 text-[10px] text-ink-subtle">
              {action.shortcut && <ShortcutKeys shortcut={action.shortcut} />}
              <span>{action.context}</span>
            </span>
          </button>
        ))
      )}
      {resultCount === 0 && !(assetMode && (assetsLoading || assetsError)) && (
        <p className="px-3 py-8 text-center text-sm text-ink-muted">
          {assetMode
            ? t`No matching assets. Search is limited to the first 50 matches.`
            : t`No matching commands`}
        </p>
      )}
    </div>
  )
}

function highlight(label: string, query: string) {
  const match = fuzzyMatch(query, label)
  const normalizedPositions = new Set(match?.positions ?? [])
  const originalIndexByNormalizedOffset: number[] = []
  let normalizedOffset = 0
  const characters = [...label]
  characters.forEach((character, index) => {
    const part = character
      .normalize('NFKD')
      .toLocaleLowerCase()
      .replace(/\p{Diacritic}/gu, '')
    for (let offset = 0; offset < part.length; offset++) {
      originalIndexByNormalizedOffset[normalizedOffset++] = index
    }
  })
  const positions = new Set<number>()
  for (const position of normalizedPositions) {
    const originalIndex = originalIndexByNormalizedOffset[position]
    if (originalIndex !== undefined) positions.add(originalIndex)
  }
  return characters.map((character, index) =>
    positions.has(index) ? (
      <mark
        key={label.slice(0, index + 1)}
        className="rounded-sm bg-primary/20 text-inherit"
      >
        {character}
      </mark>
    ) : (
      character
    )
  )
}
