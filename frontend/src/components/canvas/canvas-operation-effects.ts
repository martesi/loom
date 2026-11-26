import {
  type GeometryUpdate,
  ImageService,
  MediaService,
  PromptService,
  SettingsService,
  TagService,
  type UndoResult,
  UndoService,
} from '../../../bindings/loom/internal/service'
import type { CanvasOperationContext } from './canvas-operation'

export const canvasEffects = {
  addTag: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    tag: string
  ) => context.effect(() => TagService.AddTag(path, id, tag)),
  attachPrompt: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    promptId: number
  ) => context.effect(() => PromptService.AttachPrompt(path, id, promptId)),
  createAndAttachPrompt: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    name: string,
    prompt: string,
    negative: string
  ) =>
    context.effect(() =>
      PromptService.CreateAndAttachPrompt(path, id, name, prompt, negative)
    ),
  detachPrompt: (context: CanvasOperationContext, path: string, id: number) =>
    context.effect(() => PromptService.DetachPrompt(path, id)),
  importMedia: (
    context: CanvasOperationContext,
    path: string,
    media: Parameters<typeof ImageService.ImportMedia>[1],
    placeOnCanvas: boolean,
    x: number,
    y: number
  ) =>
    context.effect(() =>
      ImageService.ImportMedia(path, media, placeOnCanvas, x, y)
    ),
  invalidateRenditions: (context: CanvasOperationContext, path: string) =>
    context.effect(() => ImageService.InvalidateRenditions(path)),
  linkSource: (
    context: CanvasOperationContext,
    path: string,
    source: number,
    derived: number
  ) => context.effect(() => ImageService.LinkSource(path, source, derived)),
  moveFile: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    target: string
  ) => context.effect(() => ImageService.MoveFile(path, id, target)),
  placeImages: (
    context: CanvasOperationContext,
    path: string,
    ids: number[],
    x: number,
    y: number
  ) => context.effect(() => ImageService.PlaceImages(path, ids, x, y, 0)),
  purgeImages: (context: CanvasOperationContext, path: string, ids: number[]) =>
    context.effect(() => ImageService.PurgeImages(path, ids)),
  removeTag: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    tagId: number
  ) => context.effect(() => TagService.RemoveTag(path, id, tagId)),
  replaceMedia: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    media: Parameters<typeof ImageService.ReplaceMedia>[2]
  ) => context.effect(() => ImageService.ReplaceMedia(path, id, media)),
  rescanRepository: (context: CanvasOperationContext, path: string) =>
    context.effect(() => ImageService.RescanRepository(path)),
  restoreImage: (context: CanvasOperationContext, path: string, id: number) =>
    context.effect(() => ImageService.RestoreImage(path, id)),
  reverseRelationship: (
    context: CanvasOperationContext,
    path: string,
    id: number
  ) => context.effect(() => ImageService.ReverseRelationship(path, id)),
  setArchived: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    archived: boolean
  ) => context.effect(() => ImageService.SetArchived(path, id, archived)),
  setDisplayGeometry: (
    context: CanvasOperationContext,
    path: string,
    revision: string,
    expected: GeometryUpdate[],
    before: GeometryUpdate[],
    after: GeometryUpdate[]
  ) =>
    context.effect(() =>
      ImageService.SetGeometryFromDisplayAtRevision(
        path,
        revision,
        expected,
        before,
        after
      )
    ),
  setGeometry: (
    context: CanvasOperationContext,
    path: string,
    geometry: GeometryUpdate[]
  ) => context.effect(() => ImageService.SetGeometry(path, geometry)),
  setPositions: (
    context: CanvasOperationContext,
    path: string,
    positions: { imageId: number; x: number; y: number }[]
  ) => context.effect(() => ImageService.SetPositions(path, positions)),
  setViewport: (
    context: CanvasOperationContext,
    path: string,
    viewport: { x: number; y: number; zoom: number }
  ) => context.effect(() => ImageService.SetViewport(path, viewport)),
  settingsSet: (
    context: CanvasOperationContext,
    path: string,
    key: string,
    value: string
  ) => context.effect(() => SettingsService.Set(path, key, value)),
  trashImage: (context: CanvasOperationContext, path: string, id: number) =>
    context.effect(() => ImageService.TrashImage(path, id)),
  transcode: (
    context: CanvasOperationContext,
    path: string,
    id: number,
    options: Parameters<typeof MediaService.Transcode>[2]
  ) => context.prepare(() => MediaService.Transcode(path, id, options)),
  undo: (context: CanvasOperationContext, path: string) =>
    context.effect(() => UndoService.Undo(path)) as Promise<UndoResult>,
  redo: (context: CanvasOperationContext, path: string) =>
    context.effect(() => UndoService.Redo(path)) as Promise<UndoResult>,
  unlinkSource: (context: CanvasOperationContext, path: string, id: number) =>
    context.effect(() => ImageService.UnlinkSource(path, id)),
  unlinkSources: (
    context: CanvasOperationContext,
    path: string,
    ids: number[]
  ) => context.effect(() => ImageService.UnlinkSources(path, ids)),
}
