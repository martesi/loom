import type { ReactNode } from 'react'

export function Section({
  title,
  children,
}: {
  title: ReactNode
  children: ReactNode
}) {
  return (
    <section className="grid gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
        {title}
      </h3>
      {children}
    </section>
  )
}
