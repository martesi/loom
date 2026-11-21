export interface CanvasAction {
  id: string
  label: string
  description: string
  category: string
  aliases: string[]
  shortcut?: string
  shortcuts?: string[]
  context: string
  enabled: boolean
  disabledReason?: string
  dangerous?: boolean
  /** Opt-in: listed in Settings for rebinding plus a Control-mode switch. */
  customizable?: boolean
  execute: () => void | Promise<void>
}

export interface FuzzyMatch {
  score: number
  positions: number[]
}

export interface ShortcutEvent {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function normalizeShortcut(shortcut: string) {
  return shortcut
    .toLowerCase()
    .replace(/controlorcommand/g, 'mod')
    .replace(/controlormeta/g, 'mod')
    .replace(/command/g, 'mod')
    .replace(/control/g, 'ctrl')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort(
      (left, right) =>
        modifierOrder(left) - modifierOrder(right) || left.localeCompare(right)
    )
    .join('+')
}

export function shortcutForEvent(event: ShortcutEvent) {
  const key = event.code.startsWith('Digit')
    ? event.code.slice('Digit'.length)
    : event.code.startsWith('Key')
      ? event.code.slice('Key'.length).toLowerCase()
      : event.key.toLowerCase()
  const parts = [
    ...(event.ctrlKey || event.metaKey ? ['mod'] : []),
    ...(event.ctrlKey ? ['ctrl'] : []),
    ...(event.altKey ? ['alt'] : []),
    ...(event.shiftKey ? ['shift'] : []),
    key,
  ]
  return normalizeShortcut(parts.join('+'))
}

export function shortcutMatches(event: ShortcutEvent, shortcut: string) {
  if (shortcut === '?')
    return (
      event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey
    )
  const eventShortcut = shortcutForEvent(event)
  if (eventShortcut === normalizeShortcut(shortcut)) return true
  if (!event.ctrlKey || event.metaKey) return false
  const modShortcut = eventShortcut?.replace('+ctrl', '')
  const ctrlShortcut = eventShortcut?.replace(/^mod\+ctrl\+/, 'ctrl+')
  return [modShortcut, ctrlShortcut].includes(normalizeShortcut(shortcut))
}

export function fuzzyMatch(query: string, value: string): FuzzyMatch | null {
  const needle = normalizeText(query)
  const haystack = normalizeText(value)
  if (!needle) return { score: 0, positions: [] }

  const positions: number[] = []
  let cursor = 0
  let previous = -2
  let score = 0
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor)
    if (index < 0) return null
    positions.push(index)
    const wordStart = index === 0 || /[\s/_-]/.test(haystack[index - 1] ?? '')
    score += wordStart ? 10 : 0
    score += index === previous + 1 ? 8 : 0
    score -= Math.max(0, index - previous - 1)
    previous = index
    cursor = index + 1
  }
  if (haystack.startsWith(needle)) score += 20
  return { score, positions }
}

export function actionEligibility(enabled: boolean, disabledReason?: string) {
  return enabled
    ? { enabled: true, disabledReason: undefined }
    : {
        enabled: false,
        disabledReason: disabledReason ?? 'Unavailable right now',
      }
}

export function displayShortcut(shortcut: string, isMac: boolean) {
  return shortcut
    .split('+')
    .map((part) => {
      if (part === 'Mod') return isMac ? '⌘' : 'Ctrl'
      if (part === 'Ctrl') return 'Ctrl'
      if (part === 'Shift') return isMac ? '⇧' : 'Shift'
      if (part === 'Alt') return isMac ? '⌥' : 'Alt'
      return part.length === 1 ? part.toUpperCase() : part
    })
    .join(isMac ? '' : '+')
}

export function isMacPlatform() {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  )
}

export function searchActions(actions: CanvasAction[], query: string) {
  const needle = query.trim()
  return actions
    .flatMap((action) => {
      const matches = [
        action.label,
        action.description,
        action.category,
        ...action.aliases,
      ]
        .map((value) => fuzzyMatch(needle, value))
        .filter((match): match is FuzzyMatch => match !== null)
      if (!matches.length) return []
      return [{ action, match: matches.sort((a, b) => b.score - a.score)[0] }]
    })
    .sort(
      (left, right) =>
        right.match.score - left.match.score ||
        Number(right.action.enabled) - Number(left.action.enabled) ||
        left.action.label.localeCompare(right.action.label)
    )
}

function normalizeText(value: string) {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\p{Diacritic}/gu, '')
}

function modifierOrder(part: string) {
  return ['mod', 'ctrl', 'alt', 'shift'].indexOf(part) + 1 || 5
}
