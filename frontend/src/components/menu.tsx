import { Fragment, type ReactNode, useEffect } from 'react'
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
}

// A small hand-rolled dropdown positioned at a fixed viewport point —
// backs both the canvas node right-click menu (mockup section 5) and the
// list view's row context menu. Deliberately not built on a generic
// anchor-to-trigger menu primitive, since both call sites open it from an
// arbitrary click point (contextmenu event / a "..." button) rather than a
// DOM-adjacent trigger.
export function PositionedMenu({
  x,
  y,
  items,
  onClose,
  width = 224,
}: PositionedMenuProps) {
  // Deliberately no window 'contextmenu' listener here: right-clicking
  // elsewhere already opens (or moves) a menu through its own contextmenu
  // handler, which sets this component's x/y/items directly — a second
  // "close on any contextmenu" listener would fire on window *after* that
  // handler (window sits outside the React root in the bubble chain), so
  // it would immediately null out the very state the click just set.
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const clampedX = Math.min(x, window.innerWidth - width - 8)
  const clampedY = Math.min(y, window.innerHeight - items.length * 36 - 16)

  return (
    <div
      role="menu"
      className="fixed z-50 flex flex-col gap-0.5 rounded-lg border border-black/8 bg-white p-1.5 shadow-lg"
      style={{ left: Math.max(clampedX, 8), top: Math.max(clampedY, 8), width }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <div className="my-1 h-px bg-black/6" />}
          <button
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
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
