import { t } from '@lingui/core/macro'
import { canvasEffects } from '../components/canvas/canvas-operation-effects'
import type { CanvasAction } from '../lib/action-catalog'
import type { CanvasActionsContext } from './canvas-actions-context'

export function canvasWorkspaceActions(
  context: CanvasActionsContext
): CanvasAction[] {
  const {
    assetsOpen,
    assetsPinned,
    openAssets,
    toggleAssets,
    closeAssets,
    setAssetsPinned,
    inspectorOpen,
    inspectorPinned,
    openInspector,
    toggleInspector,
    closeInspector,
    setInspectorPinned,
    toggleFocusMode,
    openSettings,
    openPalette,
    setRepoOpenRequest,
    setNavigatorModeRequest,
    setSearchFocusRequest,
    importInput,
    repoPath,
  } = context
  return [
    {
      id: 'open-assets',
      label: t`Open Assets`,
      description: t`Show the repository asset navigator`,
      category: t`Workspace`,
      aliases: [t`library`, t`asset shelf`],
      context: t`Workspace`,
      enabled: true,
      execute: openAssets,
    },
    {
      id: 'toggle-assets',
      customizable: true,
      label: t`Toggle Assets`,
      description: t`Open or close the Assets navigator`,
      category: t`Workspace`,
      aliases: [t`assets drawer`],
      shortcut: 'Mod+B',
      context: t`Workspace`,
      enabled: true,
      execute: toggleAssets,
    },
    {
      id: 'close-assets',
      label: t`Close Assets`,
      description: t`Close the Assets navigator`,
      category: t`Workspace`,
      aliases: [t`hide assets`],
      context: t`Workspace`,
      enabled: assetsOpen,
      disabledReason: t`Assets is already closed`,
      execute: closeAssets,
    },
    {
      id: 'pin-assets',
      label: t`Pin Assets drawer`,
      description: t`Keep Assets open during Canvas interactions`,
      category: t`Workspace`,
      aliases: [t`keep assets open`],
      context: t`Assets`,
      enabled: assetsOpen && !assetsPinned,
      disabledReason: t`Open Assets before pinning`,
      execute: () => setAssetsPinned(true),
    },
    {
      id: 'unpin-assets',
      label: t`Unpin Assets drawer`,
      description: t`Allow Assets to close after an action`,
      category: t`Workspace`,
      aliases: [t`unpin assets`],
      context: t`Assets`,
      enabled: assetsOpen && assetsPinned,
      disabledReason: t`Assets is not pinned`,
      execute: () => setAssetsPinned(false),
    },
    {
      id: 'open-inspector',
      label: t`Open Inspector`,
      description: t`Show metadata for the active selection`,
      category: t`Workspace`,
      aliases: [t`details`, t`inspector shelf`],
      context: t`Workspace`,
      enabled: true,
      execute: openInspector,
    },
    {
      id: 'toggle-inspector',
      customizable: true,
      label: t`Toggle Inspector`,
      description: t`Open or close the Inspector`,
      category: t`Workspace`,
      aliases: [t`inspector drawer`],
      shortcut: 'Mod+I',
      context: t`Workspace`,
      enabled: true,
      execute: toggleInspector,
    },
    {
      id: 'close-inspector',
      label: t`Close Inspector`,
      description: t`Close the Inspector drawer`,
      category: t`Workspace`,
      aliases: [t`hide inspector`],
      context: t`Workspace`,
      enabled: inspectorOpen,
      disabledReason: t`Inspector is already closed`,
      execute: closeInspector,
    },
    {
      id: 'pin-inspector',
      label: t`Pin Inspector drawer`,
      description: t`Keep Inspector open during Canvas interactions`,
      category: t`Workspace`,
      aliases: [t`keep inspector open`],
      context: t`Inspector`,
      enabled: inspectorOpen && !inspectorPinned,
      disabledReason: t`Open Inspector before pinning`,
      execute: () => setInspectorPinned(true),
    },
    {
      id: 'unpin-inspector',
      label: t`Unpin Inspector drawer`,
      description: t`Allow Inspector to close after selection clears`,
      category: t`Workspace`,
      aliases: [t`unpin inspector`],
      context: t`Inspector`,
      enabled: inspectorOpen && inspectorPinned,
      disabledReason: t`Inspector is not pinned`,
      execute: () => setInspectorPinned(false),
    },
    {
      id: 'toggle-focus-canvas',
      customizable: true,
      label: t`Toggle Focus Canvas`,
      description: t`Hide or restore Canvas controls and drawers`,
      category: t`Workspace`,
      aliases: [t`zen`, t`focus mode`],
      shortcut: 'Mod+\\',
      context: t`Workspace`,
      enabled: true,
      execute: toggleFocusMode,
    },
    {
      id: 'show-shortcuts',
      customizable: true,
      label: t`Show keyboard shortcuts`,
      description: t`Browse available keyboard shortcuts`,
      category: t`Workspace`,
      aliases: [t`help`, t`shortcut reference`],
      shortcut: '?',
      context: t`Workspace`,
      enabled: true,
      execute: () => openSettings('keyboard'),
    },
    {
      id: 'open-settings',
      customizable: true,
      label: t`Open Settings`,
      description: t`Open device preferences`,
      category: t`Workspace`,
      aliases: [t`preferences`, t`settings`],
      shortcut: 'Mod+,',
      context: t`Workspace`,
      enabled: true,
      execute: () => openSettings(),
    },
    {
      id: 'open-appearance-settings',
      label: t`Appearance settings`,
      description: t`Open appearance preferences`,
      category: t`Workspace`,
      aliases: [t`theme`, t`density`],
      context: t`Workspace`,
      enabled: true,
      execute: () => openSettings('appearance'),
    },
    {
      id: 'show-commands',
      customizable: true,
      label: t`Show commands`,
      description: t`Search Canvas commands and repository assets`,
      category: t`Workspace`,
      aliases: [t`command palette`, t`search actions`],
      shortcut: 'Mod+K',
      context: t`Workspace`,
      enabled: true,
      execute: () => openPalette(false),
    },
    ...(repoPath
      ? [
          {
            id: 'rescan-repository',
            label: t`Rescan repository`,
            description: t`Refresh the repository asset catalog`,
            category: t`Workspace`,
            aliases: [t`reload`, t`refresh`],
            context: t`Workspace`,
            enabled: true,
            execute: () =>
              context.owner.submit(
                {
                  kind: 'mutation',
                  capability: 'lifecycle',
                  board: context.owner.getSnapshot(),
                },
                (operation) =>
                  canvasEffects.rescanRepository(operation, repoPath)
              ),
          },
        ]
      : []),
    {
      id: 'switch-repository',
      label: t`Switch repository`,
      description: t`Choose another repository window`,
      category: t`Workspace`,
      aliases: [t`open repository`, t`project picker`],
      context: t`Workspace`,
      enabled: true,
      execute: () => setRepoOpenRequest((request) => request + 1),
    },
    {
      id: 'import-media',
      label: t`Import media`,
      description: t`Choose images or videos to add to this repository`,
      category: t`Workspace`,
      aliases: [t`add files`, t`upload`],
      context: t`Workspace`,
      enabled: true,
      execute: () => importInput.current?.click(),
    },
    {
      id: 'show-all-assets',
      label: t`Show All Assets`,
      description: t`Open the semantic repository catalog`,
      category: t`Assets navigation`,
      aliases: [t`catalog`],
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'all',
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'show-folders',
      label: t`Show Folders`,
      description: t`Open the physical folder navigator`,
      category: t`Assets navigation`,
      aliases: [t`filesystem`, t`directories`],
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'folders',
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'assets-gallery-view',
      customizable: true,
      label: t`Show Assets gallery`,
      description: t`Switch Assets to a thumbnail gallery`,
      category: t`Assets navigation`,
      aliases: [t`gallery view`, t`asset grid`],
      shortcut: 'Mod+Shift+1',
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'all',
          layout: 'gallery',
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'assets-list-view',
      customizable: true,
      label: t`Show Assets list`,
      description: t`Switch Assets to the compact list`,
      category: t`Assets navigation`,
      aliases: [t`list view`, t`asset list`],
      shortcut: 'Mod+Shift+2',
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'all',
          layout: 'list',
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'assets-gallery-smaller',
      label: t`Smaller gallery cards`,
      description: t`Reduce the thumbnail gallery card size`,
      category: t`Assets navigation`,
      aliases: [t`decrease gallery density`, t`smaller thumbnails`],
      shortcut: 'Mod+Alt+ArrowDown',
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'all',
          densityDelta: -1,
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'assets-gallery-larger',
      label: t`Larger gallery cards`,
      description: t`Increase the thumbnail gallery card size`,
      category: t`Assets navigation`,
      aliases: [t`increase gallery density`, t`larger thumbnails`],
      shortcut: 'Mod+Alt+ArrowUp',
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setNavigatorModeRequest((current) => ({
          mode: 'all',
          densityDelta: 1,
          request: (current?.request ?? 0) + 1,
        }))
      },
    },
    {
      id: 'focus-asset-search',
      label: t`Focus asset search`,
      description: t`Open Assets and focus its search field`,
      category: t`Assets navigation`,
      aliases: [t`find asset`, t`search files`],
      context: t`Assets`,
      enabled: true,
      execute: () => {
        openAssets()
        setSearchFocusRequest((request) => request + 1)
      },
    },
    {
      id: 'search-assets',
      label: t`Search repository assets`,
      description: t`Search filenames, tags, and paths with @`,
      category: t`Assets navigation`,
      aliases: [t`@ search`, t`find media`],
      context: t`Repository`,
      enabled: true,
      execute: () => openPalette(false, '@'),
    },
  ]
}
