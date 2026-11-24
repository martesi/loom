import { Fragment, type ReactNode, useEffect, useRef } from 'react'
import { cn } from '../lib/utils'

export interface MenuAction {
  key: string
  label: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
}

interface PositionedMenuProps {
  x: number
  y: number
  items: MenuAction[]
  onClose: () => void
  width?: number
  restoreFocusOnSelect?: boolean
  restoreFocusOnPointerSelect?: boolean
}

// Canvas context menus open at a viewport point rather than at an anchor.
export function PositionedMenu({
  x,
  y,
  items,
  onClose,
  width = 224,
  restoreFocusOnSelect = true,
  restoreFocusOnPointerSelect = true,
}: PositionedMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef(true)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Deliberately no window 'contextmenu' listener here: right-clicking
  // elsewhere already opens (or moves) a menu through its own contextmenu
  // handler, which sets this component's x/y/items directly — a second
  // "close on any contextmenu" listener would fire on window *after* that
  // handler (window sits outside the React root in the bubble chain), so
  // it would immediately null out the very state the click just set.
  useEffect(() => {
    const menu = menuRef.current
    const previousFocus =
      document.activeElement instanceof HTMLElement ||
      document.activeElement instanceof SVGElement
        ? document.activeElement
        : null
    restoreFocusRef.current = true
    menu
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) {
        restoreFocusRef.current = false
        closeRef.current()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
      if (e.key === 'Tab' && menu?.contains(document.activeElement)) {
        restoreFocusRef.current = false
        closeRef.current()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
      if (
        restoreFocusRef.current &&
        previousFocus?.isConnected &&
        (menu?.contains(document.activeElement) ||
          document.activeElement === document.body)
      )
        previousFocus.focus()
    }
  }, [])

  const clampedX = Math.min(x, window.innerWidth - width - 8)
  const clampedY = Math.min(y, window.innerHeight - items.length * 36 - 16)

  return (
    <div
      role="menu"
      ref={menuRef}
      className="fixed z-50 flex flex-col gap-0.5 rounded-lg border border-black/8 bg-card p-1.5 shadow-lg"
      style={{ left: Math.max(clampedX, 8), top: Math.max(clampedY, 8), width }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault()
          const buttons = [
            ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)'
            ) ?? []),
          ]
          const index = buttons.findIndex(
            (button) => button === document.activeElement
          )
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                  buttons.length
          buttons[next]?.focus()
        }
        if (e.key === 'Tab') {
          closeRef.current()
          return
        }
        e.stopPropagation()
      }}
    >
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <div className="my-1 h-px bg-black/6" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            onClick={(event) => {
              if (item.disabled) return
              if (
                !restoreFocusOnSelect ||
                (event.detail > 0 && !restoreFocusOnPointerSelect)
              )
                restoreFocusRef.current = false
              item.onSelect()
              onClose()
            }}
            className={cn(
              'rounded-md px-3 py-2 text-left text-[12.5px]',
              item.danger
                ? 'text-danger hover:bg-danger-soft'
                : 'text-ink hover:bg-black/[0.04]',
              item.disabled && 'cursor-default opacity-40 hover:bg-transparent'
            )}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
