import { Context, Service } from '@cordisjs/core'
import type { MediaTransform } from '@loom/image-tools-core'
import type { ReactNode } from 'react'
import type {
  ImageInfo,
  LibraryRow,
} from '../../bindings/loom/internal/service'
import {
  ImageService,
  LibraryService,
  MediaService as WailsMediaService,
  SettingsService as WailsSettingsService,
} from '../../bindings/loom/internal/service'
import type { Selection } from './selection'

export interface AssetInfo {
  id: number
  fileName: string
  thumbnailUrl: string
  width?: number
  height?: number
  prompt: string
  placed: boolean
  archived: boolean
  trashed: boolean
  missing: boolean
  setId: number | null
  createdAt: string
}

export interface AssetListItem extends AssetInfo {
  tags: readonly string[]
}

export interface AssetQuery {
  search?: string
  placement?: 'any' | 'placed' | 'unplaced'
  status?: 'active' | 'archived' | 'trashed' | 'all'
  tagId?: number
}

export interface AssetsService {
  get(id: number): Promise<AssetInfo | null>
  list(query?: AssetQuery): Promise<readonly AssetListItem[]>
  create(media: ProcessedMedia): Promise<AssetInfo>
  replace(id: number, media: ProcessedMedia): Promise<AssetInfo>
  subscribe(listener: () => void): () => void
}

export interface SelectionSnapshot {
  surface: 'assets' | 'canvas'
  assetIds: readonly number[]
  relationshipIds: readonly number[]
  setId: number | null
}

export interface SelectionService {
  readonly current: SelectionSnapshot
  subscribe(listener: (selection: SelectionSnapshot) => void): () => void
}

export interface LoomOperation {
  id: string
  title: string
  run(input?: unknown): unknown | Promise<unknown>
}

export interface OperationsService {
  register(operation: LoomOperation): () => void
  list(): readonly LoomOperation[]
  get(id: string): LoomOperation | undefined
  run(id: string, input?: unknown): Promise<unknown>
  readonly activeId: string | null
  open(id: string): void
  close(): void
  subscribe(listener: (activeId: string | null) => void): () => void
}

export interface SettingsService {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<void>
}

export interface ProcessedMedia {
  name: string
  data: string
}

export interface MediaService {
  transcode(assetId: number, transform: MediaTransform): Promise<ProcessedMedia>
}

export interface UISlotProps {
  'assets.itemMenu': { assetId: number }
  'operation.workspace': { operationId: string }
}

export type UISlot = keyof UISlotProps

export interface UIContribution<K extends UISlot> {
  id: string
  render(props: UISlotProps[K]): ReactNode
}

export interface UIService {
  register<K extends UISlot>(
    slot: K,
    contribution: UIContribution<K>
  ): () => void
  list<K extends UISlot>(slot: K): readonly UIContribution<K>[]
}

declare module '@cordisjs/core' {
  interface Context {
    assets: AssetsService
    selection: SelectionService
    operations: OperationsService
    settings: SettingsService
    media: MediaService
    ui: UIService
  }
}

interface HostState {
  repoPath: string | null
  selection: SelectionSnapshot
  selectionListeners: Set<(selection: SelectionSnapshot) => void>
  assetListeners: Set<() => void>
}

class AssetsServiceImpl extends Service implements AssetsService {
  constructor(
    ctx: Context,
    private state: HostState
  ) {
    super(ctx, 'assets', true)
  }

  async get(id: number) {
    const image = await ImageService.GetImage(requireRepo(this.state), id)
    return image ? fromImageInfo(image) : null
  }

  async list(query: AssetQuery = {}) {
    const rows =
      (await LibraryService.ListImages(requireRepo(this.state), {
        search: query.search ?? '',
        placement: query.placement === 'any' ? '' : (query.placement ?? ''),
        status: query.status ?? '',
        tagId: query.tagId ?? 0,
      })) ?? []
    return rows.map(fromLibraryRow)
  }

  async create(media: ProcessedMedia) {
    const ids = await ImageService.ImportMedia(
      requireRepo(this.state),
      [media],
      false,
      0,
      0
    )
    const id = ids?.[0]
    if (!id) throw new Error('Media import returned no asset')
    const asset = await this.get(id)
    if (!asset) throw new Error(`Imported asset ${id} was not found`)
    notifyAssets(this.state)
    return asset
  }

  async replace(id: number, media: ProcessedMedia) {
    await ImageService.ReplaceMedia(requireRepo(this.state), id, media)
    const asset = await this.get(id)
    if (!asset) throw new Error(`Replaced asset ${id} was not found`)
    notifyAssets(this.state)
    return asset
  }

  subscribe(listener: () => void) {
    return this.ctx.effect(() => {
      this.state.assetListeners.add(listener)
      return () => this.state.assetListeners.delete(listener)
    })
  }
}

class SelectionServiceImpl extends Service implements SelectionService {
  constructor(
    ctx: Context,
    private state: HostState
  ) {
    super(ctx, 'selection', true)
  }

  get current() {
    return cloneSelection(this.state.selection)
  }

  subscribe(listener: (selection: SelectionSnapshot) => void) {
    return this.ctx.effect(() => {
      this.state.selectionListeners.add(listener)
      listener(this.current)
      return () => this.state.selectionListeners.delete(listener)
    })
  }
}

class OperationsServiceImpl extends Service implements OperationsService {
  private operations = new Map<string, LoomOperation>()
  private active: string | null = null
  private listeners = new Set<(activeId: string | null) => void>()

  constructor(ctx: Context) {
    super(ctx, 'operations', true)
  }

  register(operation: LoomOperation) {
    if (!operation.id) throw new Error('Operation id is required')
    if (this.operations.has(operation.id))
      throw new Error(`Operation "${operation.id}" is already registered`)

    return this.ctx.effect(() => {
      this.operations.set(operation.id, operation)
      return () => {
        if (this.operations.get(operation.id) === operation) {
          this.operations.delete(operation.id)
          if (this.active === operation.id) this.close()
        }
      }
    })
  }

  list() {
    return [...this.operations.values()]
  }

  get(id: string) {
    return this.operations.get(id)
  }

  async run(id: string, input?: unknown) {
    const operation = this.operations.get(id)
    if (!operation) throw new Error(`Unknown operation "${id}"`)
    return await operation.run(input)
  }

  get activeId() {
    return this.active
  }

  open(id: string) {
    if (!this.operations.has(id)) throw new Error(`Unknown operation "${id}"`)
    if (this.active === id) return
    this.active = id
    this.notify()
  }

  close() {
    if (this.active === null) return
    this.active = null
    this.notify()
  }

  subscribe(listener: (activeId: string | null) => void) {
    return this.ctx.effect(() => {
      this.listeners.add(listener)
      listener(this.active)
      return () => this.listeners.delete(listener)
    })
  }

  private notify() {
    for (const listener of this.listeners) listener(this.active)
  }
}

class SettingsServiceImpl extends Service implements SettingsService {
  constructor(
    ctx: Context,
    private state: HostState
  ) {
    super(ctx, 'settings', true)
  }

  get(key: string) {
    return WailsSettingsService.Get(requireRepo(this.state), key)
  }

  set(key: string, value: string) {
    return WailsSettingsService.Set(requireRepo(this.state), key, value)
  }
}

class MediaServiceImpl extends Service implements MediaService {
  constructor(
    ctx: Context,
    private state: HostState
  ) {
    super(ctx, 'media', true)
  }

  async transcode(assetId: number, transform: MediaTransform) {
    const result = await WailsMediaService.Transcode(
      requireRepo(this.state),
      assetId,
      {
        targetExt:
          transform.format === 'jpeg' ? '.jpg' : `.${transform.format}`,
        quality: transform.quality ?? 0,
        maxWidth: transform.maxWidth ?? 0,
        maxHeight: transform.maxHeight ?? 0,
      }
    )
    if (!result) throw new Error('Media transcode returned no result')
    return result
  }
}

class UIServiceImpl extends Service implements UIService {
  private contributions = new Map<UISlot, Map<string, unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'ui', true)
  }

  register<K extends UISlot>(slot: K, contribution: UIContribution<K>) {
    const entries = this.contributions.get(slot) ?? new Map<string, unknown>()
    if (entries.has(contribution.id))
      throw new Error(
        `UI contribution "${contribution.id}" is already registered in "${slot}"`
      )

    return this.ctx.effect(() => {
      entries.set(contribution.id, contribution)
      this.contributions.set(slot, entries)
      return () => {
        if (entries.get(contribution.id) === contribution)
          entries.delete(contribution.id)
        if (!entries.size) this.contributions.delete(slot)
      }
    })
  }

  list<K extends UISlot>(slot: K) {
    const entries = this.contributions.get(slot)
    if (!entries) return []
    return [...entries.values()] as UIContribution<K>[]
  }
}

export function createPluginHost() {
  const context = new Context()
  const state: HostState = {
    repoPath: null,
    selection: {
      surface: 'canvas',
      assetIds: [],
      relationshipIds: [],
      setId: null,
    },
    selectionListeners: new Set(),
    assetListeners: new Set(),
  }

  context.plugin(AssetsServiceImpl, state)
  context.plugin(SelectionServiceImpl, state)
  context.plugin(OperationsServiceImpl)
  context.plugin(SettingsServiceImpl, state)
  context.plugin(MediaServiceImpl, state)
  context.plugin(UIServiceImpl)

  return {
    context,
    activateRepository(repoPath: string) {
      state.repoPath = repoPath
      return () => {
        if (state.repoPath !== repoPath) return
        state.repoPath = null
        syncSelection(state, {
          surface: 'canvas',
          ids: [],
          edges: [],
          group: null,
        })
      }
    },
    setSelection(selection: Selection) {
      syncSelection(state, selection)
    },
  }
}

export const pluginHost = createPluginHost()

function requireRepo(state: HostState) {
  if (!state.repoPath) throw new Error('No repository is active')
  return state.repoPath
}

function notifyAssets(state: HostState) {
  for (const listener of state.assetListeners) listener()
}

function syncSelection(state: HostState, selection: Selection) {
  state.selection = {
    surface: selection.surface,
    assetIds: [...selection.ids],
    relationshipIds: [...selection.edges],
    setId: selection.group,
  }
  for (const listener of state.selectionListeners)
    listener(cloneSelection(state.selection))
}

function cloneSelection(selection: SelectionSnapshot): SelectionSnapshot {
  return {
    ...selection,
    assetIds: [...selection.assetIds],
    relationshipIds: [...selection.relationshipIds],
  }
}

function fromImageInfo(image: ImageInfo): AssetInfo {
  return {
    id: image.id,
    fileName: image.fileName,
    thumbnailUrl: image.thumbUrl,
    width: image.width,
    height: image.height,
    prompt: image.promptText,
    placed: image.placed,
    archived: image.archived,
    trashed: image.trashed,
    missing: image.missing,
    setId: image.groupId || null,
    createdAt: image.createdAt,
  }
}

function fromLibraryRow(row: LibraryRow): AssetListItem {
  return {
    id: row.id,
    fileName: row.fileName,
    thumbnailUrl: row.thumbUrl,
    prompt: row.promptText,
    placed: row.placed,
    archived: row.archived,
    trashed: row.trashed,
    missing: row.missing,
    setId: row.groupId || null,
    createdAt: row.createdAt,
    tags: row.tags ?? [],
  }
}
