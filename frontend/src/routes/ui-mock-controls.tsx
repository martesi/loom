import type { LucideIcon } from 'lucide-react'

export function IconButton({
  icon: Icon,
  dark = false,
}: {
  icon: LucideIcon
  dark?: boolean
}) {
  return (
    <button
      type="button"
      className={`flex h-8 w-8 items-center justify-center rounded-xl ${
        dark
          ? 'text-white/45 hover:bg-white/8 hover:text-white'
          : 'text-black/45 hover:bg-black/[0.04]'
      }`}
    >
      <Icon size={13} />
    </button>
  )
}
