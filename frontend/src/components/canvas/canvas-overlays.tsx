import { Dialog } from '@base-ui-components/react/dialog'
import { plural } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  CanvasData,
  ImageInfo,
} from '../../../bindings/loom/internal/service'
import { ImageService } from '../../../bindings/loom/internal/service'
import type { CanvasAction } from '../../lib/action-catalog'
import { renditionGenerationUrl } from '../../lib/preview-tier'
import { CompressionDialog } from '../compression-dialog'
import { SettingsDialog } from '../settings-dialog'
import { Button } from '../ui/button'
import type { CanvasBoardOwner } from './canvas-board-owner'
import type { PaletteAsset } from './command-palette'
import { CommandPalette } from './command-palette'
import { LightboxViewer } from './lightbox'

interface Props {
  owner: CanvasBoardOwner
  repoPath: string
  actionCatalog: CanvasAction[]
  defaultShortcuts: Record<string, string>
  paletteOpen: boolean
  shortcutsOnly: boolean
  paletteInitialQuery: string
  recentActionIds: string[]
  paletteAssets: PaletteAsset[]
  paletteAssetsLoading: boolean
  paletteAssetsError: boolean
  retryPaletteAssets: () => void
  changePaletteOpen: (open: boolean) => void
  runPaletteAction: (action: CanvasAction) => void
  choosePaletteAsset: (asset: PaletteAsset) => void
  settingsSection: 'appearance' | 'keyboard' | null
  closeSettings: () => void
  previewImageId: number | null
  previewIndex: number
  previewImages: ImageInfo[]
  closePreview: () => void
  setPreviewImageId: Dispatch<SetStateAction<number | null>>
  relatedImages: (
    id: number,
    direction: 'sources' | 'children'
  ) => { id: number; fileName: string; thumbUrl: string }[]
  onPreviewJump: (id: number) => void
  previewInfoOpen: boolean
  setPreviewInfoOpen: Dispatch<SetStateAction<boolean>>
  data: CanvasData
  canvasImageIds?: number[]
  renditionGeneration: number
  onRenditionsInvalidated: () => void
  compressIds: number[] | null
  setCompressIds: Dispatch<SetStateAction<number[] | null>>
  reload: () => Promise<void>
  purgeIds: number[] | null
  trashIds: number[] | null
  lifecyclePending: boolean
  pendingRecentAction: MutableRefObject<string | null>
  lifecyclePendingRef: MutableRefObject<boolean>
  setPurgeIds: Dispatch<SetStateAction<number[] | null>>
  setTrashIds: Dispatch<SetStateAction<number[] | null>>
  setLifecyclePending: Dispatch<SetStateAction<boolean>>
  confirmPurge: () => Promise<void>
  finishTrash: () => Promise<void>
  report: (error: unknown) => void
}

export function CanvasOverlays({
  owner,
  repoPath,
  actionCatalog,
  defaultShortcuts,
  paletteOpen,
  shortcutsOnly,
  paletteInitialQuery,
  recentActionIds,
  paletteAssets,
  paletteAssetsLoading,
  paletteAssetsError,
  retryPaletteAssets,
  changePaletteOpen,
  runPaletteAction,
  choosePaletteAsset,
  settingsSection,
  closeSettings,
  previewImageId,
  previewIndex,
  previewImages,
  closePreview,
  setPreviewImageId,
  relatedImages,
  onPreviewJump,
  previewInfoOpen,
  setPreviewInfoOpen,
  data,
  canvasImageIds,
  renditionGeneration,
  onRenditionsInvalidated,
  compressIds,
  setCompressIds,
  reload,
  purgeIds,
  trashIds,
  lifecyclePending,
  pendingRecentAction,
  lifecyclePendingRef,
  setPurgeIds,
  setTrashIds,
  setLifecyclePending,
  confirmPurge,
  finishTrash,
  report,
}: Props) {
  return (
    <>
      <CommandPalette
        open={paletteOpen}
        shortcutsOnly={shortcutsOnly}
        initialQuery={paletteInitialQuery}
        actions={actionCatalog}
        recentActionIds={recentActionIds}
        assets={paletteAssets}
        assetsLoading={paletteAssetsLoading}
        assetsError={paletteAssetsError}
        onRetryAssets={retryPaletteAssets}
        onOpenChange={changePaletteOpen}
        onRunAction={runPaletteAction}
        onChooseAsset={choosePaletteAsset}
      />
      {settingsSection && (
        <SettingsDialog
          initialSection={settingsSection}
          actions={actionCatalog}
          defaultShortcuts={defaultShortcuts}
          repoPath={repoPath || null}
          rescanRepository={(path) =>
            owner.admit(async () => {
              const result = await ImageService.RescanRepository(path)
              await owner.reconcile()
              return result
            })
          }
          invalidateRenditions={(path) =>
            ImageService.InvalidateRenditions(path)
          }
          refreshRepository={reload}
          onRenditionsInvalidated={onRenditionsInvalidated}
          onClose={closeSettings}
        />
      )}
      {previewImageId !== null && previewIndex >= 0 && (
        <LightboxViewer
          images={previewImages.map((image) => ({
            ...image,
            thumbUrl: renditionGenerationUrl(
              image.thumbUrl,
              renditionGeneration
            ),
          }))}
          index={previewIndex}
          onClose={closePreview}
          onIndexChange={(idx) => {
            if (previewImages[idx]) setPreviewImageId(previewImages[idx].id)
          }}
          tagsForImage={() => []}
          placementLabel={
            (
              canvasImageIds
                ? canvasImageIds.includes(previewImageId)
                : (data.images ?? []).find((i) => i.id === previewImageId)
                    ?.placed
            )
              ? 'Canvas'
              : 'Library'
          }
          sourcesFor={(id) =>
            relatedImages(id, 'sources').map((image) => ({
              ...image,
              thumbUrl: renditionGenerationUrl(
                image.thumbUrl,
                renditionGeneration
              ),
            }))
          }
          childrenFor={(id) =>
            relatedImages(id, 'children').map((image) => ({
              ...image,
              thumbUrl: renditionGenerationUrl(
                image.thumbUrl,
                renditionGeneration
              ),
            }))
          }
          onJumpTo={onPreviewJump}
          infoOpen={previewInfoOpen}
          onInfoOpenChange={setPreviewInfoOpen}
        />
      )}
      {compressIds && (
        <CompressionDialog
          owner={owner}
          path={repoPath}
          assetIds={compressIds}
          onClose={() => setCompressIds(null)}
          onChange={async () => {
            await owner.reconcile()
          }}
        />
      )}
      <Dialog.Root
        open={purgeIds !== null || trashIds !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPurgeIds(null)
            setTrashIds(null)
            if (!lifecyclePending) pendingRecentAction.current = null
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/8 bg-card p-5 shadow-lg outline-none">
            <Dialog.Title className="text-sm font-semibold text-ink">
              {purgeIds
                ? plural(purgeIds.length, {
                    one: 'Permanently delete # asset?',
                    other: 'Permanently delete # assets?',
                  })
                : plural(trashIds?.length ?? 0, {
                    one: 'Move # asset to trash?',
                    other: 'Move # assets to trash?',
                  })}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs leading-relaxed text-ink-muted">
              <Trans>
                {purgeIds ? (
                  <Trans>
                    This removes the files and Loom metadata immediately. Trash
                    retention does not apply, and this action cannot be undone.
                  </Trans>
                ) : (
                  <Trans>
                    The selected assets will move to repository trash. They are
                    retained for 30 days, then permanently purged automatically.
                  </Trans>
                )}
              </Trans>
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>
                <Trans>Cancel</Trans>
              </Dialog.Close>
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  void (purgeIds ? confirmPurge() : finishTrash())
                    .catch((error) => {
                      pendingRecentAction.current = null
                      report(error)
                    })
                    .finally(() => {
                      lifecyclePendingRef.current = false
                      setLifecyclePending(false)
                    })
                }
                disabled={lifecyclePending}
              >
                {purgeIds ? (
                  <Trans>Permanently delete</Trans>
                ) : (
                  <Trans>Move to trash</Trans>
                )}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
