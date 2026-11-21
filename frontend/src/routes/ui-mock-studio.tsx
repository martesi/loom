import {
  Aperture,
  ArrowUpRight,
  BoxSelect,
  ChevronDown,
  CircleDot,
  Folder,
  Layers3,
  Minus,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import { IconButton } from './ui-mock-controls'
import { assets } from './ui-mock-data'

export function StudioMock() {
  return (
    <div className="relative h-full bg-[#eeeae1] font-sans text-[#1e211f]">
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 42%, rgba(255,255,255,.85), transparent 38%), radial-gradient(#b7b0a4 0.8px, transparent 0.8px)',
          backgroundSize: 'auto, 20px 20px',
        }}
      />

      <header className="absolute left-4 right-4 top-4 z-30 flex h-14 items-center gap-3 rounded-[18px] border border-white/70 bg-[#fffdf8]/90 px-3 shadow-[0_14px_40px_rgba(61,52,39,.10)] backdrop-blur-xl">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#315cf5] text-white shadow-sm">
          <Aperture size={17} strokeWidth={2.4} />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold">Editorial studies</span>
          <ChevronDown size={14} className="text-black/35" />
          <span className="rounded-full bg-[#ece9e2] px-2 py-1 text-[10px] font-medium text-black/45">
            38 assets
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-xl bg-black/[0.035] p-1">
          {[
            [BoxSelect, 'Select'],
            [WandSparkles, 'Arrange'],
            [Sparkles, 'Create set'],
          ].map(([Icon, label]) => (
            <button
              key={label as string}
              type="button"
              className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold text-black/55 hover:bg-white"
            >
              <Icon size={14} />
              {label as string}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-xl bg-[#1e211f] px-3 text-[11px] font-semibold text-white"
        >
          <Plus size={14} />
          Import
        </button>
      </header>

      <aside className="absolute bottom-4 left-4 top-[84px] z-20 flex w-[258px] flex-col overflow-hidden rounded-[24px] border border-white/80 bg-[#fffdf8]/94 shadow-[0_18px_55px_rgba(61,52,39,.11)] backdrop-blur-xl">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[.16em] text-black/32">
              Assets
            </div>
            <div className="mt-1 text-[15px] font-semibold">All media</div>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.04] text-black/45"
          >
            <Folder size={14} />
          </button>
        </div>
        <div className="mx-3 flex h-9 items-center gap-2 rounded-xl bg-black/[0.045] px-3 text-black/35">
          <Search size={14} />
          <span className="text-[11px]">Search assets</span>
          <SlidersHorizontal size={14} className="ml-auto" />
        </div>
        <div className="flex items-center gap-1 px-3 py-3 text-[10px] font-semibold">
          <span className="rounded-full bg-[#315cf5] px-2.5 py-1 text-white">
            Active
          </span>
          <span className="rounded-full bg-black/[0.04] px-2.5 py-1 text-black/45">
            Unplaced 14
          </span>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-hidden px-3 pb-3">
          {assets.map(([name, tone], index) => (
            <button
              type="button"
              key={name}
              className={`group relative overflow-hidden rounded-[16px] border bg-gradient-to-br ${
                index === 0
                  ? 'border-[#315cf5] ring-2 ring-[#315cf5]/15'
                  : 'border-black/5'
              } ${tone}`}
            >
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent p-2.5 pt-8 text-left">
                <div className="truncate text-[10px] font-semibold text-white">
                  {name}
                </div>
              </div>
              {index === 0 && (
                <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[#315cf5] shadow-sm">
                  <CircleDot size={10} />
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      <main className="absolute bottom-4 left-[286px] right-[318px] top-[84px] overflow-hidden rounded-[28px] border border-black/[0.035] bg-[#f8f5ef]/55">
        <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
          <path
            d="M 260 280 C 350 280, 360 190, 455 190"
            fill="none"
            stroke="#315cf5"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path
            d="M 260 300 C 390 310, 410 430, 560 430"
            fill="none"
            stroke="#7f807b"
            strokeOpacity=".48"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>

        <StudioNode
          className="left-[8%] top-[24%] h-[190px] w-[230px]"
          tone={assets[0][1]}
          name="portrait-study.png"
          selected
        />
        <StudioNode
          className="left-[48%] top-[12%] h-[145px] w-[190px]"
          tone={assets[1][1]}
          name="glass-house.jpg"
        />
        <StudioNode
          className="left-[58%] top-[53%] h-[165px] w-[210px]"
          tone={assets[4][1]}
          name="garden-final.jpg"
        />
        <div className="absolute left-[34%] top-[60%] flex -rotate-2 items-center gap-2 rounded-2xl border border-black/5 bg-[#fffdf8] px-3 py-2 shadow-md">
          <div
            className={`h-10 w-10 rounded-xl bg-gradient-to-br ${assets[2][1]}`}
          />
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[.12em] text-black/35">
              Set · 03
            </div>
            <div className="text-[11px] font-semibold">Warm references</div>
          </div>
          <Layers3 size={14} className="ml-3 text-black/35" />
        </div>

        <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-white/80 bg-[#fffdf8]/94 p-1.5 shadow-lg backdrop-blur-xl">
          <IconButton icon={Minus} />
          <span className="w-12 text-center text-[10px] font-semibold text-black/45">
            82%
          </span>
          <IconButton icon={Plus} />
          <div className="mx-1 h-5 w-px bg-black/8" />
          <button
            type="button"
            className="rounded-xl px-3 py-2 text-[10px] font-semibold text-[#315cf5]"
          >
            Fit canvas
          </button>
        </div>
      </main>

      <aside className="absolute bottom-4 right-4 top-[84px] z-20 flex w-[286px] flex-col overflow-hidden rounded-[24px] border border-white/80 bg-[#fffdf8]/94 p-4 shadow-[0_18px_55px_rgba(61,52,39,.11)] backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[.16em] text-black/32">
              Inspector
            </div>
            <div className="mt-1 text-[15px] font-semibold">portrait-study</div>
          </div>
          <MoreHorizontal size={17} className="text-black/35" />
        </div>
        <div
          className={`mt-4 aspect-[4/3] rounded-[18px] bg-gradient-to-br ${assets[0][1]} shadow-inner`}
        />
        <div className="mt-4 flex flex-wrap gap-1.5">
          {['portrait', 'warm', 'reference'].map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[#ece9e2] px-2.5 py-1 text-[10px] font-semibold text-black/55"
            >
              {tag}
            </span>
          ))}
          <button
            type="button"
            className="rounded-full border border-dashed border-black/15 px-2.5 py-1 text-[10px] font-semibold text-black/35"
          >
            + tag
          </button>
        </div>
        <InspectorSection title="Prompt">
          Editorial portrait, sun-faded palette, natural grain, 50mm...
        </InspectorSection>
        <InspectorSection title="Relationships">
          <div className="flex items-center gap-2">
            <div
              className={`h-8 w-8 rounded-lg bg-gradient-to-br ${assets[1][1]}`}
            />
            <span className="min-w-0 flex-1 truncate">glass-house.jpg</span>
            <ArrowUpRight size={13} className="text-black/35" />
          </div>
        </InspectorSection>
        <div className="mt-auto grid grid-cols-2 gap-2">
          <button
            type="button"
            className="rounded-xl bg-black/[0.045] px-3 py-2.5 text-[10px] font-semibold"
          >
            Reveal file
          </button>
          <button
            type="button"
            className="rounded-xl bg-[#315cf5] px-3 py-2.5 text-[10px] font-semibold text-white"
          >
            Edit metadata
          </button>
        </div>
      </aside>
    </div>
  )
}

function StudioNode({
  className,
  tone,
  name,
  selected = false,
}: {
  className: string
  tone: string
  name: string
  selected?: boolean
}) {
  return (
    <div
      className={`absolute overflow-hidden rounded-[22px] bg-gradient-to-br shadow-[0_18px_40px_rgba(44,37,27,.16)] ${tone} ${
        selected
          ? 'ring-[3px] ring-[#315cf5] ring-offset-4 ring-offset-[#f8f5ef]'
          : ''
      } ${className}`}
    >
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-3 pb-3 pt-10">
        <span className="text-[10px] font-semibold text-white">{name}</span>
      </div>
    </div>
  )
}
function InspectorSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-4 border-t border-black/8 pt-3">
      <div className="mb-2 text-[9px] font-bold uppercase tracking-[.13em] text-black/32">
        {title}
      </div>
      <div className="text-[10px] leading-relaxed text-black/60">
        {children}
      </div>
    </div>
  )
}
