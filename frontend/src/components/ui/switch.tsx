import { Switch as BaseSwitch } from '@base-ui-components/react/switch'
import { cn } from '../../lib/utils'

export function Switch({ className, ...props }: BaseSwitch.Root.Props) {
  return (
    <BaseSwitch.Root
      {...props}
      className={cn(
        'inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full border border-black/15 bg-black/10 p-0.5 outline-none transition-colors data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 focus-visible:ring-2 focus-visible:ring-primary/40',
        className
      )}
    >
      <BaseSwitch.Thumb className="block size-4 rounded-full bg-white shadow transition-transform data-[checked]:translate-x-3.5" />
    </BaseSwitch.Root>
  )
}
