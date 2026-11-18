import type React from 'react'
import { cn } from '../../lib/utils'

interface KbdProps extends React.ComponentProps<'kbd'> {
  variant?: 'default' | 'outline'
}

export function Kbd({ className, variant = 'default', ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center rounded px-1 font-sans text-[10px] font-medium text-ink-muted',
        variant === 'outline'
          ? 'border border-black/12 border-b-2 px-1.5'
          : 'bg-black/[0.06]',
        className
      )}
      {...props}
    />
  )
}

export function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}
