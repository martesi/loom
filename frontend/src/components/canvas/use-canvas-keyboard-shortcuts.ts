import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { type CanvasAction, shortcutMatches } from '../../lib/action-catalog'
import { emptySelection, type Selection } from '../../lib/selection'
import type { CanvasMenuState } from './use-canvas-workspace-state'

interface KeyboardState {
  assetsOpen: boolean
  assetsPinned: boolean
  closeAssets: () => void
  closeInspector: () => void
  compressIds: number[] | null
  executeAction: (action: CanvasAction) => Promise<unknown>
  expanded: number | null
  inspectorOpen: boolean
  inspectorPinned: boolean
  isMac: boolean
  menu: CanvasMenuState | null
  remove: (purge: boolean) => Promise<void>
  openPalette: (shortcuts?: boolean, initialQuery?: string) => void
  paletteOpen: boolean
  previewImageId: number | null
  purgeIds: number[] | null
  repoMenuOpen: boolean
  selection: Selection
  selectedIds: () => number[]
  settingsSection: 'appearance' | 'keyboard' | null
  space: boolean
}

interface Props extends KeyboardState {
  actionRef: MutableRefObject<CanvasAction[]>
  setSpace: Dispatch<SetStateAction<boolean>>
  setMenu: Dispatch<SetStateAction<CanvasMenuState | null>>
  setRepoMenuOpen: Dispatch<SetStateAction<boolean>>
  setSelection: Dispatch<SetStateAction<Selection>>
  setExpanded: Dispatch<SetStateAction<number | null>>
  beginIntent: () => void
}

export function useCanvasKeyboardShortcuts(props: Props) {
  const state = useRef(props)
  state.current = props

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const current = state.current
      const target = event.target
      const targetElement = target instanceof Element ? target : null
      const inEditable = !!targetElement?.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=dialog]'
      )
      const isInteractiveTarget = !!targetElement?.closest(
        'button,a[href],input,textarea,select,summary,[contenteditable=true],[role=button],[role^=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=combobox],[role=listbox],[role=slider],[role=spinbutton]'
      )
      const isCanvasSurface =
        target === document.body ||
        target === document.documentElement ||
        !!targetElement?.closest('main,.react-flow')
      if (
        event.code === 'Space' &&
        !inEditable &&
        !isInteractiveTarget &&
        isCanvasSurface &&
        !current.paletteOpen
      ) {
        event.preventDefault()
        current.beginIntent()
        current.setSpace(true)
        return
      }
      if (
        current.paletteOpen ||
        current.purgeIds ||
        current.compressIds ||
        current.previewImageId !== null
      )
        return
      if (event.key === 'Escape') {
        // Settings owns the first Escape during the popup exit transition.
        if (current.settingsSection) return
        if (document.querySelector('[role="dialog"]')) return
        if (current.menu) {
          current.setMenu(null)
          event.preventDefault()
          return
        }
        if (current.repoMenuOpen) {
          current.setRepoMenuOpen(false)
          event.preventDefault()
          return
        }
        if (document.querySelector('[role="menu"]')) return
        if (current.inspectorOpen && !current.inspectorPinned)
          current.closeInspector()
        else if (current.assetsOpen && !current.assetsPinned)
          current.closeAssets()
        else if (inEditable) return
        else if (
          current.selection.ids.length ||
          current.selection.edges.length ||
          current.selection.group
        )
          current.setSelection(emptySelection)
        else if (current.expanded !== null) current.setExpanded(null)
        else return
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (inEditable || current.menu) return
      const action = current.actionRef.current.find(
        (candidate) =>
          candidate.enabled &&
          (
            candidate.shortcuts ??
            (candidate.shortcut ? [candidate.shortcut] : [])
          ).some(
            (shortcut) =>
              (shortcut !== 'Ctrl+Y' || !current.isMac) &&
              shortcutMatches(event, shortcut)
          )
      )
      const purgeShortcut =
        event.shiftKey &&
        (event.key === 'Delete' || event.key === 'Backspace') &&
        current.selectedIds().length > 0
      if (purgeShortcut) {
        event.preventDefault()
        void current.remove(true)
        return
      }
      if (!action) return
      if (
        action.id === 'remove-selected-relationships' &&
        (!targetElement?.closest(
          '[data-canvas-surface] .react-flow, [data-canvas-surface]:focus'
        ) ||
          isInteractiveTarget)
      )
        return
      event.preventDefault()
      if (action.id === 'show-commands') current.openPalette(false)
      else void current.executeAction(action)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        if (state.current.space) state.current.beginIntent()
        state.current.setSpace(false)
      }
    }
    const blur = () => {
      if (state.current.space) state.current.beginIntent()
      state.current.setSpace(false)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
}
