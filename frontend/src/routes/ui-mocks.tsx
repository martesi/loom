import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { rootRoute } from './root'
import { ContactMock } from './ui-mock-contact'
import { NightMock } from './ui-mock-night'
import { StudioMock } from './ui-mock-studio'

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

export const uiMocksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ui-mocks',
  component: UiMocks,
})
