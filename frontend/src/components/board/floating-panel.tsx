import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type {
  BoardSummary,
  ImageInfo,
  RepoInfo,
} from '../../../bindings/loom/internal/service'
import { SettingsService } from '../../../bindings/loom/internal/service'
import { cn } from '../../lib/utils'
import { BoardSwitcher } from './board-switcher'
import { DetailPanel } from './detail-panel'
import { ExplorerPanel } from './explorer-panel'
import { LibraryPanel, type LibraryRevealRequest } from './library-panel'
import { RepoSelect } from './repo-select'
import { SettingsModal } from './settings-modal'

export type PanelTab = 'library' | 'explorer' | 'detail'

// Settings keys backing panel visibility/dock side (Stage 4's
// SettingsService). Hardcoded defaults for now (visible=true, left) — no
// settings UI to change these yet, that lands with the Settings modal in
// Stage 11.
const PANEL_VISIBLE_KEY = 'panel_visible'
const PANEL_DOCK_SIDE_KEY = 'panel_dock_side'

interface FloatingPanelProps {
  repo: RepoInfo
  boards: BoardSummary[]
  currentBoardId: number
  currentBoardName: string
  onBoardsChanged: () => void
  onRevealOnCanvas: (imageId: number) => void
  activeTab: PanelTab
  onActiveTabChange: (tab: PanelTab) => void
  libraryRevealRequest: LibraryRevealRequest | null
  libraryRefreshToken: number
  // Detail tab (Stage 9): which image to show, the loaded board's images
  // (so Detail can resolve a board member without a redundant fetch — see
  // detail-panel.tsx), and the mutation handlers it needs. A row context
  // menu's "Show details" routes here via onDetailRequest, which board.tsx
  // wires to both setting detailImageId and switching activeTab to 'detail'.
  // onPreviewRequest is the passive counterpart Library/Explorer use when
  // their own selection narrows to one row — sets detailImageId without
  // switching tabs, same as canvas's plain-click selection sync.
  detailImageId: number | null
  // 2+ canvas-selected image ids, in selection order — when non-empty,
  // Detail shows a multi-select list instead of detailImageId's single
  // image (see board.tsx's selectionOrder/orderedSelectedImageIds).
  multiSelectedImageIds: number[]
  boardImages: ImageInfo[]
  onDetailRequest: (imageId: number) => void
  onPreviewRequest: (imageId: number) => void
  // Stage 11's Settings modal, opened from the gear icon below — needs the
  // current board's layout mode and a way to trigger a reload after
  // changing it (BoardService.SetLayoutMode isn't undo-logged, see
  // settings-modal.tsx, so a plain reload callback is enough) — plus a way
  // to trigger a folder rescan, relocated here from CanvasToolbar.
  layoutMode: string
  onLayoutModeChange: () => void
  onRescan: () => void
  // Library's checkbox multi-selection, reported up for Stage 12's
  // lastSelectionSource unification.
  onPanelSelectionChange: (ids: number[]) => void
  // Hover-only filename overlay on image nodes (see image-node.tsx),
  // gated by this setting — surfaced in the Settings modal's Display
  // section.
  showFileName: boolean
  onShowFileNameChange: (value: boolean) => void
}

// Dockable/hideable `absolute`-positioned overlay (same treatment as
// CanvasToolbar/ZoomControls/the old SidePanel) that hosts the
// Library/Explorer/Detail tabs. It renders as a sibling of the canvas, not
// a flex sibling, so the canvas stays full-width and fully interactive
// underneath — see board.tsx and Stage 12's drag-and-drop.
//
// All three tabs are mounted simultaneously; only the active one is shown
// (via CSS `hidden`, not conditional mounting) so each tab's state (e.g.
// the library's filters/scroll position) survives switching away and back.
export function FloatingPanel({
  repo,
  boards,
  currentBoardId,
  currentBoardName,
  onBoardsChanged,
  onRevealOnCanvas,
  activeTab,
  onActiveTabChange,
  libraryRevealRequest,
  libraryRefreshToken,
  detailImageId,
  multiSelectedImageIds,
  boardImages,
  onDetailRequest,
  onPreviewRequest,
  layoutMode,
  onLayoutModeChange,
  onRescan,
  onPanelSelectionChange,
  showFileName,
  onShowFileNameChange,
}: FloatingPanelProps) {
  const [visible, setVisible] = useState(true)
  const [dockSide, setDockSide] = useState<'left' | 'right'>('left')
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    SettingsService.Get(repo.path, PANEL_VISIBLE_KEY).then((v) => {
      if (v === 'false') setVisible(false)
    })
    SettingsService.Get(repo.path, PANEL_DOCK_SIDE_KEY).then((v) => {
      if (v === 'right') setDockSide('right')
    })
  }, [repo.path])

  // onDragOver/onDrop below are purely a drag-event propagation firewall
  // (see their own comment), not a user interaction target.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: see comment above.
    <div
      className={cn(
        // bg-card/96 is effectively opaque (white at 96%), so backdrop-blur
        // had no visible effect — but per CSS a backdrop-filter on this
        // element makes it the containing block for the panel's position:fixed
        // descendants, clipping FloatingPanel's PositionedMenu to the panel
        // (which is also overflow-hidden). Dropping the blur keeps the menu
        // viewport-anchored, which fixes the clipping.
        'absolute top-4 bottom-4 z-10 flex w-[320px] flex-col overflow-hidden rounded-lg border border-black/8 bg-card/96 shadow-lg',
        dockSide === 'left' ? 'left-4' : 'right-4',
        !visible && 'hidden'
      )}
      // The panel sits as an absolute-positioned sibling directly above the
      // canvas (see board.tsx), so a drag that's released anywhere over it —
      // including its own drop targets like Explorer's folder rows — would
      // otherwise bubble up to the canvas wrapper's onDrop and also add the
      // image to the board underneath. Stopping propagation here means a
      // drop only reaches board.tsx's handler when it lands on the canvas
      // itself, not merely within the same overlay stack.
      onDragOver={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <div className="flex-none border-b border-black/6 p-2">
        <BoardSwitcher
          repoPath={repo.path}
          boards={boards}
          currentBoardId={currentBoardId}
          currentBoardName={currentBoardName}
          onBoardsChanged={onBoardsChanged}
        />
      </div>

      <div className="flex-none border-b border-black/6 p-2">
        <div className="flex gap-0.5 rounded-sm bg-surface p-0.5">
          <PanelTabButton
            active={activeTab === 'library'}
            onClick={() => onActiveTabChange('library')}
          >
            <Trans>Library</Trans>
          </PanelTabButton>
          <PanelTabButton
            active={activeTab === 'explorer'}
            onClick={() => onActiveTabChange('explorer')}
          >
            <Trans>Explorer</Trans>
          </PanelTabButton>
          <PanelTabButton
            active={activeTab === 'detail'}
            onClick={() => onActiveTabChange('detail')}
          >
            <Trans>Detail</Trans>
          </PanelTabButton>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div
          className={cn(
            'absolute inset-0 overflow-hidden',
            activeTab !== 'library' && 'hidden'
          )}
        >
          <LibraryPanel
            repo={repo}
            currentBoardId={currentBoardId}
            onRevealOnCanvas={onRevealOnCanvas}
            revealRequest={libraryRevealRequest}
            refreshToken={libraryRefreshToken}
            onDetailRequest={onDetailRequest}
            onPreviewRequest={onPreviewRequest}
            onSelectionChange={onPanelSelectionChange}
            onChange={onBoardsChanged}
          />
        </div>
        <div
          className={cn(
            'absolute inset-0 overflow-hidden',
            activeTab !== 'explorer' && 'hidden'
          )}
        >
          <ExplorerPanel
            repo={repo}
            onDetailRequest={onDetailRequest}
            onPreviewRequest={onPreviewRequest}
            refreshToken={libraryRefreshToken}
          />
        </div>
        <div
          className={cn(
            'absolute inset-0 overflow-hidden',
            activeTab !== 'detail' && 'hidden'
          )}
        >
          <DetailPanel
            repo={repo}
            detailImageId={detailImageId}
            multiSelectedImageIds={multiSelectedImageIds}
            boardImages={boardImages}
            boards={boards}
            onChange={onBoardsChanged}
          />
        </div>
      </div>

      {/* Repo select (Stage 10) + Stage 11's settings gear, side by side
          (Obsidian-style vault switcher + gear icon). The select is capped
          to ~70% width so the gear has room without a layout change. */}
      <div className="flex flex-none items-center justify-between gap-2 border-t border-black/6 p-2">
        <RepoSelect repo={repo} />
        <button
          type="button"
          title={t`Settings`}
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-black/[0.04] hover:text-ink"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        repoPath={repo.path}
        boardId={currentBoardId}
        layoutMode={layoutMode}
        onLayoutModeChange={onLayoutModeChange}
        onRescan={onRescan}
        showFileName={showFileName}
        onShowFileNameChange={onShowFileNameChange}
      />
    </div>
  )
}

interface PanelTabButtonProps {
  active: boolean
  onClick: () => void
  children: ReactNode
}

function PanelTabButton({ active, onClick, children }: PanelTabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-[3px] px-2.5 py-1 text-[11.5px] font-semibold',
        active
          ? 'bg-white text-ink shadow-sm'
          : 'text-ink-subtle hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}
