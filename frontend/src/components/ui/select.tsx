import { Select as SelectPrimitive } from '@base-ui-components/react/select'
import { useRender } from '@base-ui-components/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Groups all parts of the select. Renders no element of its own.
 */
export const Select = SelectPrimitive.Root

const selectTriggerVariants = cva(
  'inline-flex items-center justify-between gap-1.5 rounded-full border border-black/12 px-3 py-1.5 text-[12px] font-medium text-ink-muted outline-none transition-colors hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:bg-black/[0.03]',
  {
    variants: {
      variant: {
        pill: '',
      },
    },
    defaultVariants: {
      variant: 'pill',
    },
  }
)

interface SelectTriggerProps
  extends useRender.ComponentProps<'button'>,
    VariantProps<typeof selectTriggerVariants> {}

/**
 * The button that opens the select popup. Wraps `Select.Trigger` — no native
 * `<select>` chrome exists here, so there's nothing for a custom border to
 * fight (the double-border bug this component replaces).
 */
export function SelectTrigger({
  className,
  variant,
  render = <SelectPrimitive.Trigger />,
  children,
  ...props
}: SelectTriggerProps) {
  return useRender({
    render,
    props: {
      ...props,
      className: cn(selectTriggerVariants({ variant, className })),
      children: (
        <>
          {children}
          <SelectPrimitive.Icon className="flex items-center text-ink-subtle">
            <ChevronDown className="h-3.5 w-3.5" />
          </SelectPrimitive.Icon>
        </>
      ),
    },
  })
}

interface SelectValueProps extends useRender.ComponentProps<'span'> {}

/**
 * Displays the label of the currently selected item inside the trigger.
 */
export function SelectValue({
  className,
  render = <SelectPrimitive.Value />,
  ...props
}: SelectValueProps) {
  return useRender({
    render,
    props: {
      ...props,
      className: cn('truncate', className),
    },
  })
}

const selectPopupVariants = cva(
  'z-50 max-h-[min(24rem,var(--available-height))] overflow-y-auto rounded-md border border-black/10 bg-white py-1 text-[12.5px] text-ink shadow-lg outline-none'
)

interface SelectContentProps
  extends useRender.ComponentProps<'div'>,
    VariantProps<typeof selectPopupVariants> {
  /** Distance in pixels between the trigger and the popup. @default 4 */
  sideOffset?: number
  /** Alignment of the popup relative to the trigger. @default 'start' */
  align?: 'start' | 'center' | 'end'
}

/**
 * The dropdown content. Renders `Select.Popup`, positioned via
 * `Select.Positioner` and teleported through `Select.Portal` — the shape
 * base-ui's select requires for a working, correctly-positioned dropdown.
 */
export function SelectContent({
  className,
  render = <SelectPrimitive.Popup />,
  sideOffset = 4,
  align = 'start',
  ...props
}: SelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        className="z-50 outline-none"
      >
        {useRender({
          render,
          props: {
            ...props,
            className: cn(selectPopupVariants({ className })),
          },
        })}
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

const selectItemVariants = cva(
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-[12.5px] text-ink outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-primary-soft'
)

interface SelectItemProps
  extends useRender.ComponentProps<'div'>,
    VariantProps<typeof selectItemVariants> {
  /** The value identifying this item. */
  value?: unknown
}

/**
 * A single selectable option in the popup. Wraps `Select.Item`.
 */
export function SelectItem({
  className,
  render = <SelectPrimitive.Item />,
  children,
  ...props
}: SelectItemProps) {
  return useRender({
    render,
    props: {
      ...props,
      className: cn(selectItemVariants({ className })),
      children: (
        <>
          <SelectPrimitive.ItemIndicator className="flex w-3.5 shrink-0 items-center justify-center text-primary">
            <Check className="h-3.5 w-3.5" />
          </SelectPrimitive.ItemIndicator>
          <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </>
      ),
    },
  })
}
