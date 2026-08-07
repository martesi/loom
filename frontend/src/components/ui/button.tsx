import { useRender } from '@base-ui-components/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-sm text-[13px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-[#005ba8]',
        secondary:
          'bg-transparent text-ink border border-black/16 hover:bg-black/[0.03]',
        ghost: 'bg-transparent text-ink hover:bg-black/[0.04]',
        danger:
          'bg-transparent text-danger border border-danger/30 hover:bg-danger-soft',
      },
      size: {
        default: 'h-[34px] px-4',
        sm: 'h-8 px-3 text-xs',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  }
)

interface ButtonProps
  extends useRender.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  render = <button type="button" />,
  ...props
}: ButtonProps) {
  return useRender({
    render,
    props: {
      ...props,
      className: cn(buttonVariants({ variant, size, className })),
    },
  })
}
