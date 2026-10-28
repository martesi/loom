import { createRoute } from '@tanstack/react-router'
import {
  Aperture,
  ArrowUpRight,
  BoxSelect,
  ChevronDown,
  CircleDot,
  Folder,
  Grid2X2,
  Images,
  Layers3,
  Maximize2,
  Minus,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useState } from 'react'
import { rootRoute } from './root'

const assets = [
  ['portrait-study.png', 'from-[#f6b4a5] via-[#d36a58] to-[#552e2b]'],
  ['glass-house.jpg', 'from-[#b8d4d8] via-[#759497] to-[#283d43]'],
  ['look-07.png', 'from-[#f5d987] via-[#d69e4d] to-[#6c432f]'],
  ['rain-window.png', 'from-[#a9b6c5] via-[#657386] to-[#202837]'],
  ['garden-final.jpg', 'from-[#bed69d] via-[#6c8e57] to-[#35402e]'],
  ['poster-type.png', 'from-[#f1c1d7] via-[#ba7699] to-[#59394c]'],
] as const

type Concept = 'studio' | 'night' | 'contact'

export function UiMocks() {
  const initial = new URLSearchParams(window.location.search).get('concept')
  const [concept, setConcept] = useState<Concept>(
    initial === 'night' || initial === 'contact' ? initial : 'studio'
  )

  return (
    <div className="relative h-screen min-h-[640px] overflow-hidden">
      {concept === 'studio' && <StudioMock />}
      {concept === 'night' && <NightMock />}
      {concept === 'contact' && <ContactMock />}
      <MockSwitcher concept={concept} setConcept={setConcept} />
    </div>
  )
}

function MockSwitcher({
  concept,
  setConcept,
}: {
  concept: Concept
  setConcept: (concept: Concept) => void
}) {
  const options: [Concept, string, string][] = [
    ['studio', 'A', 'Studio'],
    ['night', 'B', 'Night graph'],
    ['contact', 'C', 'Contact sheet'],
  ]

  return (
    <div className="fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/20 bg-[#111]/92 p-1.5 text-[11px] font-semibold text-white shadow-2xl backdrop-blur-xl">
      <span className="px-2 text-white/45">UI MOCK</span>
      {options.map(([id, letter, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => setConcept(id)}
          className={`rounded-full px-3 py-1.5 transition ${
            concept === id
              ? 'bg-white text-black'
              : 'text-white/65 hover:bg-white/10 hover:text-white'
          }`}
        >
          {letter} · {label}
        </button>
      ))}
    </div>
  )
}

function StudioMock() {
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

function NightMock() {
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

function ContactMock() {
  return (
    <div className="relative h-full overflow-hidden bg-[#f5f2e9] font-mono text-[#161616]">
      <header className="absolute inset-x-0 top-0 z-30 flex h-[52px] items-center border-b-2 border-black bg-[#f5f2e9] px-4">
        <div className="flex items-center gap-3">
          <span className="flex h-7 w-7 items-center justify-center bg-[#ff5c35] text-[11px] font-black text-white">
            L
          </span>
          <span className="text-[11px] font-black uppercase tracking-[.1em]">
            Loom / Editorial studies
          </span>
        </div>
        <div className="ml-8 flex h-full items-center border-x-2 border-black">
          {['ASSETS', 'CANVAS', 'INSPECTOR'].map((label, index) => (
            <span
              key={label}
              className={`flex h-full items-center border-r border-black px-4 text-[9px] font-bold ${
                index === 1 ? 'bg-black text-white' : ''
              }`}
            >
              {label}
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[9px] font-bold">038 FILES</span>
          <button
            type="button"
            className="border-2 border-black bg-[#ff5c35] px-3 py-2 text-[9px] font-black uppercase text-white shadow-[3px_3px_0_#000]"
          >
            + Import
          </button>
        </div>
      </header>

      <aside className="absolute bottom-0 left-0 top-[52px] z-20 w-[252px] border-r-2 border-black bg-[#eee9dc]">
        <div className="grid grid-cols-[1fr_42px] border-b-2 border-black">
          <div className="flex h-10 items-center gap-2 px-3">
            <Search size={13} />
            <span className="text-[9px] font-bold text-black/45">
              SEARCH ASSETS
            </span>
          </div>
          <button
            type="button"
            className="flex items-center justify-center border-l-2 border-black"
          >
            <SlidersHorizontal size={13} />
          </button>
        </div>
        <div className="flex items-center justify-between border-b border-black px-3 py-2 text-[8px] font-black uppercase tracking-[.12em]">
          <span>All assets</span>
          <span>24 placed</span>
        </div>
        <div className="grid grid-cols-2">
          {assets.map(([name, tone], index) => (
            <div
              key={name}
              className={`group border-b border-r border-black ${
                index === 0 ? 'bg-[#ff5c35]' : 'bg-[#f5f2e9]'
              }`}
            >
              <div className={`m-2 aspect-square bg-gradient-to-br ${tone}`} />
              <div className="border-t border-black px-2 py-1.5">
                <div className="text-[7px] font-black text-black/40">
                  {String(index + 1).padStart(2, '0')}
                </div>
                <div className="mt-0.5 truncate text-[8px] font-bold">
                  {name}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main
        className="absolute bottom-0 left-[252px] right-[272px] top-[52px] overflow-hidden bg-[#f8f6ef]"
        style={{
          backgroundImage:
            'linear-gradient(#d6d0c3 1px, transparent 1px), linear-gradient(90deg, #d6d0c3 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        <div className="absolute left-4 top-4 flex items-center gap-2 bg-[#f8f6ef] pr-2 text-[8px] font-black uppercase">
          <span className="bg-black px-2 py-1 text-white">Canvas</span>
          <span>02 relationships</span>
          <span>·</span>
          <span>03 nodes</span>
        </div>
        <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
          <path
            d="M 290 295 L 470 210"
            fill="none"
            stroke="#161616"
            strokeWidth="2"
          />
          <path
            d="M 290 318 L 570 490"
            fill="none"
            stroke="#ff5c35"
            strokeWidth="3"
          />
          <circle cx="290" cy="295" r="4" fill="#161616" />
          <circle cx="470" cy="210" r="4" fill="#161616" />
        </svg>

        <ContactNode
          className="left-[8%] top-[24%] h-[180px] w-[220px]"
          tone={assets[0][1]}
          number="01"
          name="portrait-study.png"
          selected
        />
        <ContactNode
          className="left-[49%] top-[13%] h-[145px] w-[180px]"
          tone={assets[1][1]}
          number="02"
          name="glass-house.jpg"
        />
        <ContactNode
          className="left-[61%] top-[58%] h-[155px] w-[195px]"
          tone={assets[4][1]}
          number="03"
          name="garden-final.jpg"
        />
        <div className="absolute bottom-4 left-4 flex border-2 border-black bg-[#f5f2e9] text-[8px] font-black uppercase shadow-[3px_3px_0_#000]">
          <button type="button" className="border-r-2 border-black px-3 py-2">
            −
          </button>
          <span className="border-r-2 border-black px-3 py-2">82%</span>
          <button type="button" className="border-r-2 border-black px-3 py-2">
            +
          </button>
          <button type="button" className="px-3 py-2 text-[#ff5c35]">
            FIT
          </button>
        </div>
      </main>

      <aside className="absolute bottom-0 right-0 top-[52px] z-20 w-[272px] border-l-2 border-black bg-[#f5f2e9]">
        <div className="border-b-2 border-black p-3">
          <div className="text-[8px] font-black uppercase tracking-[.16em] text-black/45">
            01 / Selected asset
          </div>
          <div className="mt-1.5 text-[11px] font-black">
            portrait-study.png
          </div>
        </div>
        <div
          className={`m-3 aspect-[4/3] border-2 border-black bg-gradient-to-br ${assets[0][1]} shadow-[4px_4px_0_#000]`}
        />
        <ContactField label="TYPE">PNG · 2048×1536</ContactField>
        <ContactField label="TAGS">
          <span className="bg-black px-1.5 py-1 text-white">PORTRAIT</span>{' '}
          <span className="bg-[#ff5c35] px-1.5 py-1 text-white">WARM</span>
        </ContactField>
        <ContactField label="PROMPT">
          EDITORIAL PORTRAIT, SUN-FADED PALETTE, NATURAL GRAIN, 50MM...
        </ContactField>
        <div className="border-b-2 border-black">
          <div className="border-b border-black px-3 py-2 text-[8px] font-black uppercase">
            Derived / 01
          </div>
          <div className="flex items-center gap-2 p-3">
            <div
              className={`h-9 w-9 border border-black bg-gradient-to-br ${assets[1][1]}`}
            />
            <span className="min-w-0 flex-1 truncate text-[8px] font-bold">
              glass-house.jpg
            </span>
            <ArrowUpRight size={13} />
          </div>
        </div>
        <div className="absolute inset-x-3 bottom-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="border-2 border-black bg-[#f5f2e9] px-2 py-2 text-[8px] font-black uppercase"
          >
            Reveal
          </button>
          <button
            type="button"
            className="border-2 border-black bg-black px-2 py-2 text-[8px] font-black uppercase text-white"
          >
            Edit
          </button>
        </div>
      </aside>
    </div>
  )
}

function ContactNode({
  className,
  tone,
  number,
  name,
  selected = false,
}: {
  className: string
  tone: string
  number: string
  name: string
  selected?: boolean
}) {
  return (
    <div className={`absolute ${className}`}>
      <div
        className={`h-[calc(100%-27px)] border-2 border-black bg-gradient-to-br ${tone} ${
          selected ? 'shadow-[6px_6px_0_#ff5c35]' : 'shadow-[4px_4px_0_#000]'
        }`}
      />
      <div className="mt-1 flex items-center gap-2 text-[8px] font-black">
        <span className={selected ? 'text-[#ff5c35]' : ''}>{number}</span>
        <span className="truncate">{name}</span>
      </div>
    </div>
  )
}

function ContactField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[58px_1fr] border-b-2 border-black text-[8px]">
      <div className="border-r-2 border-black p-3 font-black uppercase text-black/45">
        {label}
      </div>
      <div className="p-3 font-bold leading-relaxed">{children}</div>
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

function IconButton({
  icon: Icon,
  dark = false,
}: {
  icon: typeof Plus
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

export const uiMocksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ui-mocks',
  component: UiMocks,
})
