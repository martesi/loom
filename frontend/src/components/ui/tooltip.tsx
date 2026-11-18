import { Tooltip as BaseTooltip } from '@base-ui-components/react/tooltip'
import type { ReactElement, ReactNode } from 'react'
import { isMacPlatform } from '../../lib/action-catalog'
import { cn } from '../../lib/utils'
import { Kbd, KbdGroup } from './kbd'

interface TooltipProps {
  label: ReactNode
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactElement<Record<string, unknown>>
}

export function Tooltip({
  label,
  shortcut,
  side = 'top',
  children,
}: TooltipProps) {
  const keys = shortcut ? shortcutKeys(shortcut) : []
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6}>
          <BaseTooltip.Popup
            data-testid="base-tooltip-popup"
            className="z-[100] flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-ink shadow-lg"
          >
            <span>{label}</span>
            {keys.length > 0 && <ShortcutKeys shortcut={shortcut ?? ''} />}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

export function ShortcutKeys({
  shortcut,
  className,
}: {
  shortcut: string
  className?: string
}) {
  const keys = shortcutKeys(shortcut)
  return (
    <KbdGroup className={cn('shrink-0', className)}>
      {keys.map((key) => (
        <Kbd
          key={key}
          className="border border-black/12 bg-black/[0.035] px-1.5 font-mono"
        >
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  )
}

function shortcutKeys(shortcut: string) {
  const isMac = isMacPlatform()
  return shortcut.split('+').map((part) => {
    if (part === 'Mod') return isMac ? '⌘' : 'Ctrl'
    if (part === 'Ctrl') return 'Ctrl'
    if (part === 'Shift') return isMac ? '⇧' : 'Shift'
    if (part === 'Alt') return isMac ? '⌥' : 'Alt'
    if (part === 'ArrowLeft') return '←'
    if (part === 'ArrowRight') return '→'
    if (part === 'ArrowUp') return '↑'
    if (part === 'ArrowDown') return '↓'
    if (part === 'Escape') return 'Esc'
    if (part === 'Enter') return '↵'
    return part.length === 1 ? part.toUpperCase() : part
  })
}
