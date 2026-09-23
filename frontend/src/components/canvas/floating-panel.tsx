import { type ReactNode, useEffect, useState } from 'react'

export function FloatingPanel({
  title,
  side,
  children,
}: {
  title: string
  side: 'left' | 'right'
  children: ReactNode
}) {
  const [open, setOpen] = useState(
    () =>
      typeof window === 'undefined' ||
      !window.matchMedia('(max-width: 1099px)').matches
  )

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 1099px)')
    const sync = (event: MediaQueryListEvent) => setOpen(!event.matches)
    compact.addEventListener('change', sync)
    return () => compact.removeEventListener('change', sync)
  }, [])

  return (
    <aside
      aria-label={title}
      className={`flex shrink-0 flex-col border-x border-black/10 bg-card max-[1099px]:absolute max-[1099px]:inset-y-0 max-[1099px]:z-20 max-[1099px]:shadow-lg ${side === 'left' ? 'max-[1099px]:left-0' : 'max-[1099px]:right-0'}`}
      style={{
        width: open ? 280 : 40,
        minWidth: open ? 200 : 40,
        maxWidth: 480,
        resize: open ? 'horizontal' : 'none',
        overflow: 'auto',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="min-h-10 border-b border-black/10 px-3 py-2 text-left font-semibold outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        {open ? title : title.slice(0, 1)}
      </button>
      {open && children}
    </aside>
  )
}
