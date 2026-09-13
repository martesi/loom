import { type ReactNode, useState } from 'react'

export function FloatingPanel({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <aside
      aria-label={title}
      className="flex shrink-0 flex-col border-x border-black/10 bg-card"
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
        className="border-b border-black/10 p-3 text-left font-semibold"
      >
        {open ? title : title.slice(0, 1)}
      </button>
      {open && children}
    </aside>
  )
}
