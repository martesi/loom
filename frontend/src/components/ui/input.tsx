import { Input as BaseInput } from '@base-ui-components/react/input'
import { cn } from '../../lib/utils'

export function Input({ className, ...props }: BaseInput.Props) {
  return (
    <BaseInput
      {...props}
      className={cn(
        'h-8 w-full rounded-sm border border-black/12 bg-card px-2 text-xs text-ink outline-none placeholder:text-ink-subtle focus-visible:ring-2 focus-visible:ring-primary/40',
        className
      )}
    />
  )
}
