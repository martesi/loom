import { ArrowUpRight, Search, SlidersHorizontal } from 'lucide-react'
import { assets } from './ui-mock-data'

export function ContactMock() {
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
