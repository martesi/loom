# T3 Code Teardown & Canvas Chrome Architecture

**Author:** UI Analyst  
**Target File:** `docs/t3-teardown-and-chrome-story.md`  
**Reference Examined:** `/tmp/opencode/loom-refs/t3code` (`pingdotgg/t3code` @ MIT License)  
**Workspace:** `/home/bryan/.paseo/worktrees/35mr33ar/loom-ui-experiment`  
**Base Commit:** `2eb4555`  
**Implementer / Collaborator:** Luna  
**Status:** Architecture Specification & Implementation Blueprint (NO code changes made in this turn)

---

## 1. Executive Summary & Reference Context

### 1.1 License & Reference Bounds
- **Reference:** T3 Code repository cloned at `/tmp/opencode/loom-refs/t3code`.
- **License Check:** The repository is governed by the standard **MIT License** (Copyright 2026 T3 Tools Inc.).
- **Usage Boundary:** Architectural patterns, component decomposition, styling tokens, and interaction models are analyzed for reference and structural design. No proprietary assets or incompatible code are copied. Loom adapts the discovered patterns into its existing `@base-ui-components/react`, `@xyflow/react`, and Tailwind CSS tech stack.

### 1.2 Loom Canvas Experiment Problem Statement
The Loom Canvas experiment (`docs/ui-experiment-plan.md`) established an infinite full-bleed React Flow canvas overlaid with floating drawers (Assets and Inspector), a `Mod+K` command palette, and contextual floating controls. Early trial feedback identified seven critical friction points:
1. **Drawer control duplication:** Two sets of controls exist for sidebars (top island buttons vs. edge slide tabs).
2. **Command palette input styling disparity:** The palette input styling deviates from Loom's compact desktop UI framework.
3. **Icon-only floating controls lacking structured tooltips:** Controls lack framework tooltips and use unstructured strings rather than distinct per-key keyboard chips.
4. **Microscopic image hover badges:** Resolution and filename badges render too small on standard and zoomed viewports.
5. **Lagging, detached hover controls causing frame drops:** Floating controls lag behind moving nodes due to CSS transitions and cause re-render cascades.
6. **Inspector empty state confusion:** The Inspector appears empty when opened without an explicit selection, leading users to mistake drawers for independent state containers.
7. **Over-image gesture conflicts:** Overlay controls over canvas thumbnails compete with drag, resize, and relationship creation gestures, requiring a robust ergonomic alternative.

This document breaks down the structural design of T3 Code, defines a single coherent chrome architecture for Loom, and provides an actionable specification for items (1)–(7) that Luna can implement directly.

---

## 2. T3 Code Teardown: Why It Feels Clean and Logical

T3 Code (`pingdotgg/t3code`) exhibits a refined, high-density desktop aesthetic reminiscent of modern desktop developer tools (such as Raycast, Linear, and VS Code). Deconstructing its implementation reveals five foundational principles:

### 2.1 Command Palette (`apps/web/src/components/ui/command.tsx`, `CommandPalette.tsx`)
1. **Viewport & Elevation Shell:**
   - Instead of centering vertically with arbitrary offsets, T3 anchors the palette dialog in the top third of the viewport (`sm:pt-[max(10vh,calc(var(--command-titlebar-height)+--spacing(2)))]`), with `max-w-xl` and `max-h-105` (420px max height).
   - Dialog backdrop uses subtle dimming (`bg-black/25`) with a mild blur (`backdrop-blur-[2px]`).
   - The popup container has a crisp 1px border (`border-border`), high blur (`backdrop-blur-xl`), and tight corner radius (`rounded-xl`).
2. **Input Anatomy & Framing:**
   - The input is not a recycled generic form text box; it is an integrated `AutocompleteInput` / `CommandInput`.
   - It features an explicit search icon prefix (`SearchIcon`, `text-icon-muted` / `text-ink-subtle`), inset `px-[var(--command-shell-inset)] py-1.5`.
   - It strips borders and rings entirely (`border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0`). Focus is communicated by the dialog popup boundary, not an ugly internal input outline.
   - Text size is balanced: `text-sm` (13px/14px), not an oversized mobile `text-base` (16px).
3. **Structured Grouping & Results:**
   - Results are organized under crisp group headings (`CommandGroupLabel`: uppercase, `text-[10px]` or `text-xs`, tracked tracking-wider, muted foreground).
   - Interactive items (`CommandItem`) use subtle background highlights (`data-selected:bg-foreground/[0.06] data-highlighted:bg-foreground/[0.09]`), never high-contrast harsh fills.
   - Per-row shortcuts are right-aligned (`ms-auto`) using semantic `<Kbd>` components.
4. **Utility Footer:**
   - An integrated footer (`CommandFooter`) anchors the bottom with a subtle top border, displaying key navigation hints (`Enter` to run, `Esc` to close) and result counts.

### 2.2 Tooltip & Shortcut Anatomy (`apps/web/src/components/ui/tooltip.tsx`, `kbd.tsx`, Oxlint Rule)
1. **Zero Native `title` Tooltips:**
   - T3 Code maintains an oxlint rule (`oxlint-plugin-t3code/rules/no-native-title-tooltip.ts`) that strictly prohibits `title="..."` attributes on interactive HTML elements.
   - *Rationale:* Native browser tooltips have variable, unconfigurable 500–1000ms hover delays, cannot display styled shortcut chips, lack dark-mode awareness, render outside application styling, and fail accessibility standards for touch and screen magnifiers.
2. **Unified Tooltip Wrapper:**
   - Built on `@base-ui/react/tooltip` with a unified `Tooltip`, `TooltipTrigger`, and `TooltipPopup`.
   - Standard popup styling: `rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md`, positioned with `sideOffset={4}` or `6`.
3. **Per-Key `<Kbd>` Representation:**
   - Keys are never grouped as a single string (e.g., `"Ctrl+G"` or `"Mod+K"`).
   - Each individual key is rendered inside an isolated `<Kbd>` component within a `<KbdGroup>` container:
     ```tsx
     <KbdGroup>
       <Kbd>⌘</Kbd>
       <Kbd>K</Kbd>
     </KbdGroup>
     ```
   - Platform awareness: `Mod` resolves to `⌘` on macOS and `Ctrl` on Windows/Linux; `Shift` resolves to `⇧` / `Shift`; `Alt` resolves to `⌥` / `Alt`.
   - Each `<Kbd>` has consistent geometry: `h-5 min-w-5 rounded border border-black/12 bg-black/[0.035] px-1 font-mono text-[10px] font-medium`.

### 2.3 Sidebar & Drawer Handling (`apps/web/src/components/AppSidebarLayout.tsx`, `ui/sidebar.tsx`)
1. **Single Canonical Trigger:**
   - T3 Code provides **exactly one** primary sidebar trigger (`SidebarTrigger`) docked cleanly in the top chrome/titlebar.
   - When the sidebar is open, the trigger reflects active state (`aria-pressed={true}`, icon transitions to `PanelLeftClose`).
   - When closed, the trigger toggles it open (`aria-pressed={false}`, `PanelLeft`).
   - There are **zero** floating edge pull-tabs or secondary edge buttons invading the main workspace area.
2. **Off-Canvas Responsive Overlay:**
   - Collapsing moves the sidebar off-canvas smoothly using CSS transforms (`-translate-x-full` or absolute width collapse).
   - When closed, it is marked `inert` and `aria-hidden={true}`, completely removing it from the focus tab order.
3. **Drag-to-Resize with Discrete Snapping:**
   - Uses a slim resize handle rail (`SidebarRail`), with keyboard accessibility (arrow key adjustments in 8px increments) and width persistence in local storage.

### 2.4 Density and Type Scale
- **Spatial Grid:** Strict 4px base increment (8px, 12px, 16px, 24px).
- **Type Scale:**
  - `text-[10px]` / `text-[11px]`: Badges, shortcut chips, uppercase category headers.
  - `text-xs` (12px): Standard body text for panels, list item descriptions, tooltips, secondary buttons.
  - `text-sm` (13px/14px): Input fields, primary menu items, panel headers, dialog titles.
- **Icon Sizing:**
  - 14px (`h-3.5 w-3.5`): Badges, tooltips, nested action triggers.
  - 16px (`h-4 w-4`): Standard toolbar buttons, command palette icons, panel toggles.

### 2.5 Mapping T3 Patterns to Loom Fixes

| T3 Code Architectural Pattern | Loom Feedback / Issue | Loom Target Solution |
| :--- | :--- | :--- |
| **Single Titlebar `SidebarTrigger`** | Issue (1): Two sets of sidebar controls (top island + edge tabs) | Remove edge pull-tabs (`shelf-edge-trigger-*`). Top island button is the single canonical trigger. |
| **`CommandInput` with Search Icon & No Focus Ring** | Issue (2): Palette input styling off vs framework | Dedicated `CommandInput` with `h-11`, `Search` icon, `text-sm`, transparent background, no inner ring. |
| **`no-native-title-tooltip` + `<Kbd>` per key** | Issue (3): Floating controls icon-only; native `title` | Ban native `title`; wrap all icon buttons in framework `Tooltip`; render each key in its own `<Kbd>` chip. |
| **Balanced Desktop Scale (`text-xs` / `text-sm`)** | Issue (4): Hover badges too small (`text-[10px]`) | Scale badges to `text-[11px]` / `text-xs`, increase padding, ensure minimum 32px hit targets. |
| **Hardware-Accelerated CSS Transforms** | Issue (5): Hover HUD detaches, lags, drops frames | Replace manual `left`/`top` CSS transitions with xyflow `NodeToolbar` or hardware-accelerated transforms. |
| **Views are Lenses, Not State Containers** | Issue (6): Inspector feels empty unless pinned | Restate `r/ui.md` model: Drawers view active selection. Add informative empty-state guidance when idle. |
| **Docked Bottom Action Bar / Titlebar Actions** | Issue (7): Over-image controls collide with gestures | Provide the Contextual Canvas Dock alternative: selection actions live in the dock, keeping art unoccluded. |

---

## 3. The Single Coherent Chrome Story: Where Controls Live and Why

To ensure an intuitive, quiet user experience, Loom must enforce a clear spatial hierarchy where each control surface has a distinct, non-overlapping responsibility.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                   CANVAS HOST                                    │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │                 TOP ISLAND (Global Navigation & Shelves)                 │   │
│   │  [ Repo Select v ]  [ Palette (⌘K) ]  [ Assets ]  [ Inspector ]  [ ... ] │   │
│   └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌──────────────────────┐                          ┌──────────────────────┐      │
│  │    ASSETS DRAWER     │                          │   INSPECTOR DRAWER   │      │
│  │   (Floating View)    │                          │   (Floating View)    │      │
│  │                      │     INFINITE CANVAS      │                      │      │
│  │  All Assets / Folders│      (Full Bleed)        │  Active Selection:   │      │
│  │  Catalog Search      │                          │  - Metadata          │      │
│  │  Drag to place       │    [ Image Node ]        │  - Sources / Derived │      │
│  │                      │                          │  - Tags & Prompts    │      │
│  │  [Pin]       [Close] │                          │  [Pin]       [Close] │      │
│  └──────────────────────┘                          └──────────────────────┘      │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │                   CANVAS DOCK (Viewport & Selection HUD)                 │   │
│   │  Idle:       [ Fit all (⇧1) ]  [ Fit sel (⇧2) ]  [ 100% (⌘0) ]  [ Arrange ]  │
│   │  Selection:  [ Preview (Space) ]  [ Set (⌘G) ]  [ Align ]  [ Unplace (Del) ] │
│   └──────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Spatial Responsibilities
1. **The Full-Bleed Canvas (The Workspace):**
   - The React Flow canvas occupies 100% of the viewport width and height.
   - It is dedicated to spatial exploration, node arrangement, and relationship linking.
   - Opening, closing, or resizing drawers never alters the canvas host dimensions or triggers graph reflow.
2. **The Top Island (Global Scope):**
   - Floating top-center pill.
   - Contains repository selection, command palette entry (`Mod+K`), drawer toggles (Assets and Inspector), and repository actions overflow (`Rescan`, `Import`).
   - This is the **sole global entry point** for toggling drawers.
3. **The Drawers (Contextual Overlays):**
   - Floating overlays anchored to the left (Assets) and right (Inspector) margins.
   - Default to closed for maximum canvas focus.
   - Each drawer header contains its title, shortcut hint badge, a Pin toggle (`Pin`), and a Close button (`X` or Chevron).
   - **Crucial rule:** Closing a drawer completely hides it. The canvas margin remains clean. No persistent edge "pull-tabs" are rendered on the canvas boundary.
4. **The Canvas Dock (Contextual Manipulation & Viewport):**
   - Floating bottom-center toolbar.
   - Dual-state ergonomic anchor:
     - **Idle state:** Viewport controls (`Fit all`, `Fit selection`, `Reset 100%`, `Auto-arrange`).
     - **Selection state:** Contextual operations (`Preview`, `Create Set`, `Align`, `Unplace`).
   - Replaces floaty, jittery node hover bars with a rock-solid, predictable motor target.

---

## 4. Per-Item Implementation Specifications (1)–(7)

### Spec 1: Drawer Controls Consolidation (Consolidate to ONE Set)
- **Problem:** Currently, sidebars can be opened from both the top island buttons (`PanelLeft`, `PanelRight`) and edge pull-tabs (`shelf-edge-trigger-left`, `shelf-edge-trigger-right`). Edge tabs obstruct canvas edges, intercept drag gestures, and duplicate interface controls.
- **Specification:**
  1. **Remove Edge Triggers:** Delete the `{!visible && !focusHidden && <button data-testid="shelf-edge-trigger-*">...}` element from `frontend/src/components/canvas/shelf-panel.tsx`.
  2. **Canonical Trigger Set:**
     - The **Top Island** buttons (`toggle-assets-shelf` and `toggle-inspector-shelf`) are the **exclusive external triggers** to open and close drawers.
     - Each button must show active state via `aria-pressed={isOpen}` and dynamic styling (`bg-primary-soft text-ink` when open; `text-ink/75 hover:bg-black/[0.06]` when closed).
     - Each button must be wrapped in framework `Tooltip` with structured `<Kbd>` shortcut hints (`Mod+B` for Assets, `Mod+I` for Inspector).
  3. **In-Drawer Dismissal:**
     - Inside `ShelfPanel`'s header, keep the collapse button (`collapse-shelf-left`, `collapse-shelf-right`) and pin button (`pin-shelf-left`, `pin-shelf-right`).
     - Clicking collapse closes the drawer and restores focus to the invoking top-island trigger button.
  4. **Focus Canvas Mode (`Mod+\`):**
     - When Focus Canvas mode is active, the top island and dock fade out.
     - Provide a subtle, auto-hiding floating pill at the top or an edge indicator with an explicit `Exit Focus Canvas (Mod+\)` tooltip, or allow any standard shortcut (`Mod+\`, `Escape`) to restore chrome cleanly.

### Spec 2: Command Palette Input & Shell Styling
- **Problem:** `CommandPalette` uses `<Input className="h-14 ... text-base ... focus-visible:ring-2 focus-visible:ring-inset" />`, which conflicts with the compact `ui/input.tsx` base styles, introduces an oversized 16px mobile-style font, and renders an awkward inner focus ring.
- **Specification:**
  1. **Anatomy & Sizing:**
     - Height: `h-11` (44px) — standard desktop command palette proportion.
     - Typography: `text-sm` (13px/14px), font weight `font-normal`, color `text-ink`, placeholder color `placeholder:text-ink-subtle`.
     - Container: Flexbox row containing an inline search icon prefix, the raw text input, and an optional mode badge.
  2. **Search Icon Adornment:**
     - Prefix icon: `<Search className="h-4 w-4 text-ink-subtle shrink-0 ml-3.5 mr-2" />` (swapping to `@` or `Command` icon if query starts with `@` or `>`).
  3. **Zero Ring, Clean Border:**
     - Strip all focus rings: `focus:outline-none focus:ring-0 focus-visible:ring-0`. The active dialog popup itself communicates focus.
     - Bottom border: `border-b border-border` cleanly separates the input from the results list.
  4. **Mode Indicator & Status:**
     - When typing `@`, show a subtle inline pill `[Assets]` before the query, or style the sub-header row cleanly (`px-4 py-1.5 text-[11px] font-medium text-ink-muted bg-surface/50`).
  5. **Dialog Elevation:**
     - Retain `max-w-[min(600px,calc(100vw-24px))]` with `rounded-xl border border-border bg-card shadow-2xl`.

### Spec 3: Framework-Tooltip Usage with Text + Per-Key Kbd Chips
- **Problem:** Top island and dock buttons use native `title="..."` attributes or unstructured shortcut strings. Some controls are icon-only without accessible hover descriptions.
- **Specification:**
  1. **Enforce `Tooltip` Component:**
     - Wrap every icon-only or shortened button in `Tooltip` from `frontend/src/components/ui/tooltip.tsx`.
     - **Remove all native `title` attributes** on interactive elements (`button`, `a`, `input`).
  2. **`<KbdGroup>` and Per-Key `<Kbd>` Architecture:**
     - Create/refactor `ShortcutKeys` in `tooltip.tsx` to ensure **every single key token has its own `<Kbd>` element**.
     - Forbidden: `<kbd>Ctrl+G</kbd>` or `<kbd>Cmd+K</kbd>`.
     - Mandatory:
       ```tsx
       <KbdGroup>
         <Kbd>⌘</Kbd>
         <Kbd>K</Kbd>
       </KbdGroup>
       ```
     - For multi-key combinations:
       - macOS: `⌘` `⇧` `⌥` followed by uppercase character (e.g., `[⌘]` `[⇧]` `[Z]`).
       - Windows/Linux: `Ctrl`, `Shift`, `Alt` followed by uppercase character (e.g., `[Ctrl]` `[Shift]` `[Z]`).
  3. **Tooltip Layout Contract:**
     - Popup content:
       ```tsx
       <TooltipPopup side={side} sideOffset={6}>
         <div className="flex items-center gap-2">
           <span className="font-medium">{label}</span>
           {shortcut && <ShortcutKeys shortcut={shortcut} />}
         </div>
       </TooltipPopup>
       ```
     - Placements:
       - Top island controls: `side="bottom"`
       - CanvasDock controls: `side="top"`
       - Drawer header controls: `side="bottom"` or `side="left"`

### Spec 4: Image Hover Info Typography Scale
- **Problem:** Badges on image nodes (`image-node.tsx`) use `text-[10px]` with `px-1.5 py-0.5`. On standard displays and especially when zoomed out, text is unreadable (< 7px rendered).
- **Specification:**
  1. **Typography & Padding Boost:**
     - Resolution badge: Upgrade to `text-[11px] font-medium tracking-tight`, padding `px-2 py-0.5`. Use high-contrast background: `bg-black/80 backdrop-blur-md text-white/95 border border-white/10 shadow-sm`.
     - Filename badge: Upgrade to `text-xs font-medium`, padding `px-2 py-1`. Background `bg-black/80 backdrop-blur-md text-white/95`.
  2. **Action Hit Targets:**
     - Quick action buttons (`Preview`, `More`): Minimum hit height `h-8` (32px).
     - Preview button: `inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold bg-black/80 text-white backdrop-blur-md hover:bg-black`.
     - More button: `h-8 w-8` circular button, icon `h-4 w-4`.
  3. **Zoom Legibility Protection:**
     - Ensure badges and action buttons do not collapse below legible physical dimensions. If the canvas zoom drops below 50%, hover overlays should either scale compensationally or defer to selection HUD / dock actions.

### Spec 5: Hover Controls Performance Diagnosis & Smooth Transform Approach
- **Root Cause Diagnosis:**
  1. **CSS Transition on Layout Coordinates:** In `SelectionHud`, the container has:
     ```tsx
     className="... transition-[left,top] duration-75"
     ```
     During node drag or canvas pan, `left` and `top` inline styles update every frame. The `duration-75` transition continuously interpolates between stale coordinates and current coordinates. This produces an artificial 75ms lag where the HUD visually drifts behind the pointer/node.
  2. **Reflow & Layout Thrashing:** Animating `left` and `top` forces browser layout reflow on every frame. In contrast, `transform: translate3d()` runs entirely on the GPU compositor thread without triggering layout.
  3. **React State Cascade via `useViewport()`:** `SelectionHud` subscribes to `useViewport()`, causing synchronous React component re-renders at 60–120Hz whenever the user pans or zooms. In each re-render, `useLayoutEffect` measures DOM nodes with `getBoundingClientRect()`, triggering forced synchronous layouts.
- **Recommended Smooth Approach:**
  - **Approach A: Standard xyflow `NodeToolbar` (In-Graph Positioning):**
    - `@xyflow/react` exports a built-in `NodeToolbar` component designed specifically for this job.
    - Inside `ImageNode`, render:
      ```tsx
      <NodeToolbar
        isVisible={selected}
        position={Position.Top}
        offset={8}
        align="center"
      >
        <div className="flex items-center gap-1 rounded-full border border-border bg-card/95 p-1 shadow-xl backdrop-blur-md">
          {/* Actions */}
        </div>
      </NodeToolbar>
      ```
    - `NodeToolbar` uses `@xyflow/system`'s `getNodeToolbarTransform`, rendering into xyflow's portal via GPU-accelerated CSS `transform: translate3d(x, y, 0)`.
    - It tracks nodes with zero lag, zero CSS transition drift, and zero layout reflows.
  - **Approach B: Zero-Transition Viewport HUD (If Kept as Separate Component):**
    - If a multi-node bounding HUD is retained, **immediately remove `transition-[left,top]`**.
    - Position using CSS transform:
      ```tsx
      style={{
        transform: `translate3d(${clampedX}px, ${clampedY}px, 0) translate(-50%, -100%)`,
      }}
      ```
    - Throttle or decouple measurements so `useLayoutEffect` does not force layout recalculations on every frame.

### Spec 6: The Inspector Mental Model (`r/ui.md` Alignment)
- **Problem:** Users report that the Inspector feels "empty unless pinned/clicked", indicating confusion about whether the Inspector is a standalone workspace or a reactive view.
- **The Ground Truth per `r/ui.md`:**
  - *"Loom has one active selection context, owned by either Assets or Canvas."*
  - *"Inspector follows the active selection but never owns selection itself."*
  - *"Drawers are views, not state."*
- **Specification:**
  1. **Clear UX Mental Model:**
     - The Inspector is an active lens into the current selection. It does not possess its own independent cursor or state.
     - When selection changes on Canvas, Inspector updates immediately. When selection changes in Assets, Inspector updates immediately.
  2. **Designed Empty State:**
     - When the Inspector is open but **no item is selected** (`images.length === 0 && !group && selection.edges.length === 0`), replace the barren one-liner with a structured guidance view:
       ```tsx
       <div className="flex flex-col items-center justify-center p-6 text-center text-ink-muted">
         <Info className="h-8 w-8 text-ink-subtle/50 mb-2" />
         <h3 className="text-xs font-semibold text-ink mb-1">
           <Trans>No Selection</Trans>
         </h3>
         <p className="text-[11px] leading-relaxed text-ink-subtle max-w-[200px]">
           <Trans>
             Select an image, set, or relationship on the Canvas or in Assets to view metadata and links.
           </Trans>
         </p>
         <div className="mt-4 flex flex-col gap-1.5 text-[10px] text-ink-subtle">
           <span><kbd className="font-mono">⌘A</kbd> Select all on active surface</span>
           <span><kbd className="font-mono">@</kbd> Search assets in palette</span>
         </div>
       </div>
       ```
  3. **Interaction Contract for Pinning & Canvas Clicks:**
     - **Unpinned (Default):** Clicking empty canvas background clears selection and smoothly closes the unpinned Inspector drawer.
     - **Pinned:** Clicking empty canvas clears selection; the Inspector drawer remains docked open, transitioning smoothly to the friendly empty state.
     - Opening Inspector via `Mod+I` or the top island button reveals the metadata for whatever is currently selected without requiring a second click.

### Spec 7: Over-Image Controls Alternative: The Ergonomic Dock Story
- **Problem:** Placing interactive hover action strips directly over image thumbnails introduces severe gesture conflicts:
  1. *Relationship gesture collision:* `Mod`-dragging from an image creates a DAG relationship. Buttons over the image intercept pointer events unless bypassed, causing accidental action clicks or failed drag links.
  2. *Pan/move collision:* Dragging an image moves the node; buttons sitting on the node create dead zones.
  3. *Content obstruction:* Hover strips hide image composition, color details, and aspect ratios.
  4. *Scale distortion:* Canvas zoom levels warp thumbnail buttons into either huge or microscopic touch targets.
- **The Alternative: Contextual Canvas Dock (Unified Bottom Bar):**
  Instead of scattering floating action pills over every node, anchor all contextual operations into the **Canvas Dock** at the bottom of the viewport.
- **Dock State Transition Model:**
  1. **No Selection (Global Canvas Mode):**
     - Left: Viewport navigation (`Fit all [⇧1]`, `Reset 100% [⌘0]`).
     - Right: Canvas-wide actions (`Auto-arrange [⇧A]`, `More actions`).
  2. **Single Image Selected (Single Asset Mode):**
     - Morph the dock into contextual mode:
       - `[ Preview (Space) ]` — opens lightbox viewer.
       - `[ Locate in Assets ]` — reveals file in assets drawer.
       - `[ Inspect (Mod+I) ]` — opens Inspector with focus.
       - `[ Unplace (Delete) ]` — unplaces node from canvas (danger/muted styling).
     - Retain `[ Fit selection (⇧2) ]`.
  3. **Multi-Selection Active (Set & Batch Mode):**
     - `[ Create Set (Mod+G) ]` — groups selected images.
     - `[ Align Horizontally ]` / `[ Align Vertically ]` — aligns selected nodes.
     - `[ Arrange Subgraph ]` — runs dagre layout on selection.
     - `[ Unplace Selection (Delete) ]` — unplaces batch.
- **Ergonomic & Motor Rationale:**
  - **Fitts's Law Advantage:** The bottom dock is a fixed, predictable target with constant screen coordinates. Users do not have to hunt for small moving targets hovering over shifting canvas nodes.
  - **Pristine Artboard:** Images on the canvas remain 100% visible and unoccluded.
  - **Clean Gestures:** The entire image area remains an unimpeded drag surface for node translation and `Mod`-drag relationship creation.
  - **Consistent Keyboard Parity:** Every dock action directly pairs with its global keyboard shortcut (`Space`, `Mod+G`, `Delete`, `Mod+I`), displayed via clean `<Kbd>` tooltip chips.

---

## 5. Coordination & Implementation Checklist for Luna

This checklist breaks down the implementation into unambiguous steps for Luna.

### Phase 1: Chrome & Drawer Consolidation (Items 1 & 6)
- [ ] In `frontend/src/components/canvas/shelf-panel.tsx`:
  - [ ] Remove `shelf-edge-trigger-left` and `shelf-edge-trigger-right`.
  - [ ] Ensure `aside` properly animates off-screen and receives `inert={!visible}`.
- [ ] In `frontend/src/routes/canvas.tsx`:
  - [ ] Ensure Top Island `PanelLeft` and `PanelRight` buttons are the sole drawer toggles.
  - [ ] Update `aria-pressed`, `aria-expanded`, and active styling on the island buttons.
  - [ ] Wire focus restoration so closing a drawer returns focus to the island button.
- [ ] In `frontend/src/components/canvas/detail-panel.tsx`:
  - [ ] Add the structured "No Selection" empty state when no asset/group/edge is active.

### Phase 2: Palette & Tooltips (Items 2 & 3)
- [ ] In `frontend/src/components/canvas/command-palette.tsx`:
  - [ ] Replace `Input` with dedicated command palette input styling: `h-11`, `text-sm`, search icon prefix, transparent background, zero focus ring, clean bottom border.
  - [ ] Ensure fuzzy match highlights and category headings match desktop density (`text-[10px]` tracking-wider).
- [ ] In `frontend/src/components/ui/tooltip.tsx`:
  - [ ] Enhance `ShortcutKeys` to map all modifiers and characters into isolated `<Kbd>` chips. Never render `"Ctrl+G"` in a single chip.
  - [ ] Ensure proper Mac (`⌘`, `⇧`, `⌥`) vs Windows/Linux (`Ctrl`, `Shift`, `Alt`) key rendering.
- [ ] In `frontend/src/routes/canvas.tsx` & `canvas-dock.tsx`:
  - [ ] Remove all native `title="..."` attributes on buttons.
  - [ ] Wrap top island buttons and dock buttons in framework `Tooltip`.

### Phase 3: Canvas Nodes & Performance (Items 4, 5, 7)
- [ ] In `frontend/src/components/canvas/selection-hud.tsx`:
  - [ ] Remove `transition-[left,top] duration-75`.
  - [ ] Switch to `transform: translate3d(...)` or migrate to `@xyflow/react` `NodeToolbar`.
- [ ] In `frontend/src/components/canvas/image-node.tsx`:
  - [ ] Upgrade resolution badge to `text-[11px] px-2 py-0.5`.
  - [ ] Upgrade filename badge to `text-xs px-2 py-1`.
  - [ ] Upgrade action buttons to minimum `h-8` hit targets.
- [ ] In `frontend/src/components/canvas/canvas-dock.tsx`:
  - [ ] Implement single-selection and multi-selection contextual modes, ensuring full ergonomic coverage if over-image controls are bypassed.

### Phase 4: E2E Test Alignment
- [ ] In `frontend/e2e/shelves.spec.ts`:
  - [ ] Update tests that assert `shelf-edge-trigger-*` to instead assert top island toggle behavior.
- [ ] In `frontend/e2e/canvas-dock.spec.ts` & `command-palette.spec.ts`:
  - [ ] Update tests to verify framework tooltips and `<Kbd>` chips.
  - [ ] Verify command palette input height and search prefix assertions.
