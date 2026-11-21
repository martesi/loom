import {
  Aperture,
  ArrowUpRight,
  BoxSelect,
  Folder,
  Grid2X2,
  Images,
  Layers3,
  Maximize2,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { IconButton } from './ui-mock-controls'
import { assets } from './ui-mock-data'

export function NightMock() {
  return (
    <div className="relative h-full overflow-hidden bg-[#090a0b] font-sans text-[#f3f4ef]">
      <div
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.022) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
      <div className="absolute left-0 top-0 z-40 flex h-full w-[54px] flex-col items-center border-r border-white/8 bg-[#0d0e10]/90 py-3 backdrop-blur-xl">
        <div className="mb-5 flex h-8 w-8 items-center justify-center rounded-lg bg-[#c7ff58] text-black">
          <Aperture size={16} strokeWidth={2.6} />
        </div>
        {[
          ['assets', Images],
          ['canvas', Grid2X2],
          ['sets', Layers3],
        ].map(([key, Icon], index) => (
          <button
            key={key as string}
            type="button"
            className={`mb-1 flex h-9 w-9 items-center justify-center rounded-lg ${
              index === 1 ? 'bg-white/10 text-white' : 'text-white/35'
            }`}
          >
            <Icon size={16} />
          </button>
        ))}
        <button
          type="button"
          className="mt-auto flex h-9 w-9 items-center justify-center rounded-lg text-white/35"
        >
          <SlidersHorizontal size={16} />
        </button>
      </div>

      <header className="absolute left-[74px] right-5 top-4 z-30 flex h-11 items-center">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold tracking-tight">
            Editorial studies
          </span>
          <span className="text-white/25">/</span>
          <span className="text-[11px] text-white/40">Canvas</span>
        </div>
        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/8 bg-[#121416]/85 p-1 shadow-2xl backdrop-blur-xl">
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-lg bg-white/8 px-2.5 text-[10px] font-semibold"
          >
            <BoxSelect size={13} />
            Select
          </button>
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[10px] font-semibold text-white/45"
          >
            <WandSparkles size={13} />
            Arrange
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg border border-white/8 bg-white/[0.035] px-2.5 text-[10px] font-semibold text-white/65"
          >
            <Search size={13} />
            Search
          </button>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-lg bg-[#c7ff58] px-3 text-[10px] font-bold text-black"
          >
            <Plus size={13} />
            Import
          </button>
        </div>
      </header>

      <aside className="absolute bottom-5 left-[74px] top-[72px] z-20 w-[220px] rounded-[16px] border border-white/8 bg-[#111315]/86 p-2 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between px-2 py-2">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[.18em] text-[#c7ff58]/70">
              Assets
            </div>
            <div className="mt-0.5 text-[12px] font-semibold">38 files</div>
          </div>
          <Folder size={14} className="text-white/35" />
        </div>
        <div className="mb-2 flex h-8 items-center gap-2 rounded-lg bg-white/[0.045] px-2.5 text-[10px] text-white/35">
          <Search size={12} />
          Filter media
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {assets.map(([name, tone], index) => (
            <div
              key={name}
              className={`relative aspect-[4/3] overflow-hidden rounded-[10px] bg-gradient-to-br ${tone} ${
                index === 0 ? 'ring-2 ring-[#c7ff58]' : ''
              }`}
            >
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1.5 text-[8px] font-medium">
                {name}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 border-t border-white/7 px-2 pt-2 text-[9px] text-white/30">
          24 placed · 14 unplaced
        </div>
      </aside>

      <main className="absolute bottom-0 left-[54px] right-0 top-0 overflow-hidden">
        <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
          <path
            d="M 530 335 C 665 335, 680 255, 805 255"
            fill="none"
            stroke="#c7ff58"
            strokeWidth="2"
          />
          <path
            d="M 530 355 C 690 390, 730 540, 890 540"
            fill="none"
            stroke="#66e2ff"
            strokeOpacity=".55"
            strokeWidth="1.5"
          />
          <circle cx="531" cy="335" r="3.5" fill="#c7ff58" />
          <circle cx="804" cy="255" r="3.5" fill="#c7ff58" />
        </svg>

        <NightNode
          className="left-[30%] top-[25%] h-[180px] w-[240px]"
          tone={assets[0][1]}
          name="portrait-study.png"
          selected
        />
        <NightNode
          className="left-[56%] top-[17%] h-[145px] w-[195px]"
          tone={assets[1][1]}
          name="glass-house.jpg"
        />
        <NightNode
          className="left-[63%] top-[57%] h-[150px] w-[210px]"
          tone={assets[4][1]}
          name="garden-final.jpg"
        />
        <div className="absolute left-[45%] top-[60%] flex w-[180px] items-center gap-2 rounded-xl border border-white/8 bg-[#111315]/90 p-2.5 shadow-xl">
          <div className="grid h-11 w-12 grid-cols-2 gap-0.5 overflow-hidden rounded-lg">
            <div className={`bg-gradient-to-br ${assets[2][1]}`} />
            <div className={`bg-gradient-to-br ${assets[5][1]}`} />
            <div className={`bg-gradient-to-br ${assets[3][1]}`} />
            <div className={`bg-gradient-to-br ${assets[4][1]}`} />
          </div>
          <div>
            <div className="text-[9px] font-bold text-[#c7ff58]">SET / 4</div>
            <div className="text-[10px] font-semibold">Warm references</div>
          </div>
        </div>
      </main>

      <aside className="absolute bottom-5 right-5 top-[72px] z-30 w-[254px] rounded-[16px] border border-white/8 bg-[#111315]/90 p-3.5 shadow-2xl backdrop-blur-xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[.18em] text-[#c7ff58]/70">
              Inspect
            </div>
            <div className="mt-1 text-[12px] font-semibold">
              portrait-study.png
            </div>
          </div>
          <MoreHorizontal size={15} className="text-white/35" />
        </div>
        <div
          className={`mt-3 aspect-[16/10] rounded-xl bg-gradient-to-br ${assets[0][1]}`}
        />
        <div className="mt-3 grid grid-cols-3 gap-1">
          {['portrait', 'warm', 'ref'].map((tag) => (
            <span
              key={tag}
              className="rounded-lg bg-white/[0.055] px-2 py-1.5 text-center text-[9px] text-white/55"
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="mt-4 border-t border-white/7 pt-3">
          <div className="text-[9px] font-bold uppercase tracking-[.13em] text-white/28">
            Prompt
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-white/55">
            Editorial portrait, sun-faded palette, natural grain, 50mm...
          </p>
        </div>
        <div className="mt-4 border-t border-white/7 pt-3">
          <div className="mb-2 text-[9px] font-bold uppercase tracking-[.13em] text-white/28">
            Derived
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-white/[0.035] p-2">
            <div
              className={`h-8 w-8 rounded-md bg-gradient-to-br ${assets[1][1]}`}
            />
            <span className="min-w-0 flex-1 truncate text-[9px]">
              glass-house.jpg
            </span>
            <ArrowUpRight size={12} className="text-[#c7ff58]" />
          </div>
        </div>
      </aside>

      <div className="absolute bottom-5 left-[312px] z-40 flex items-center gap-1 rounded-xl border border-white/8 bg-[#111315]/92 p-1 backdrop-blur-xl">
        <IconButton icon={ZoomOut} dark />
        <span className="w-10 text-center text-[9px] font-semibold text-white/45">
          82%
        </span>
        <IconButton icon={ZoomIn} dark />
        <IconButton icon={Maximize2} dark />
      </div>
    </div>
  )
}

function NightNode({
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
      className={`absolute overflow-hidden rounded-[14px] bg-gradient-to-br shadow-[0_24px_60px_rgba(0,0,0,.45)] ${tone} ${
        selected
          ? 'ring-2 ring-[#c7ff58] ring-offset-4 ring-offset-[#090a0b]'
          : 'ring-1 ring-white/10'
      } ${className}`}
    >
      <span className="absolute bottom-2 left-2 rounded-md bg-black/65 px-2 py-1 text-[9px] font-semibold">
        {name}
      </span>
    </div>
  )
}
