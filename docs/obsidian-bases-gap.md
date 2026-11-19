# Loom and Obsidian Bases: feature gap analysis

**Scope:** read-only comparison of the current Loom tree with Obsidian's documented image, Properties, and Bases features. This is a product analysis; it does not prescribe a storage migration or claim that Loom should become a note-taking app.

## Summary

Loom already has strong image-workflow features that Bases does not aim to provide: a freeform image Canvas, resizable image nodes, explicit source-to-derived lineage, named sets with covers and comparison, a metadata Inspector, and a lightbox with image metadata and relationship navigation. Loom also supports multi-selection and several batch actions.

The clearest gap is the **repository-wide asset catalog**. Loom's Assets panel is a newest-first list with one search field, a few fixed filters, and folder navigation. It has no saved query views, general-purpose metadata columns, selectable catalog layouts, or configurable sorting/grouping. Bases turns file properties into reusable, editable views, including table and image-card layouts.

The best first investments are a thumbnail gallery with adjustable density and saved views over Loom's existing fields. Broader custom properties would unlock more of Bases' filtering, sorting, grouping, and table editing, but would require a meaningful data-model and Inspector expansion. Formula evaluation and rollups are later, high-cost work and need image-specific use cases before they are worth building.

## What Loom has today

The current implementation is media-first and repository-scoped:

- **Asset catalog:** Loom discovers image and video files in the repository and catalogs them in SQLite. Assets has **All Assets** and **Folders** modes. All Assets searches paths, filenames, prompt text, and tags; filters by active/all/archived/trashed/missing state, Canvas placement, and one tag; and defaults to newest first. Folders provides a physical directory browser with drag-and-drop moves. The catalog supports multi-selection.
- **Stored metadata:** the image row has file path, thumbnail, dimensions, file size/content hash, creation/update timestamps, archive/trash state, Canvas position and size, prompt reference, and set membership. Tags are many-to-many. Prompts have name, positive text, and negative text. Sets/groups have name, kind, cover, and member images. A generic property-definition/value system is absent.
- **Canvas and relationships:** the Canvas is a spatial composition surface with resizable image cards and persistent positions. Directed relationships record which specific image is a source and which is derived. Sets collect sibling images and support a cover and comparison. Canvas placement is independent of the asset catalog.
- **Inspector and preview:** the Inspector shows file and image details, edits a file path, adds tags, edits a prompt, changes archive state, and exposes set and relationship controls. It supports some multi-selection edits, including adding a tag, replacing a prompt, and archive/trash actions. The lightbox navigates through images and displays prompt, tags, source images, and placement alongside the image.
- **Commands:** the command palette covers repository and Assets navigation/search, import/rescan, Canvas navigation/layout/zoom, selection, preview, sets, lifecycle actions, compression, and relationship actions. It is an action catalog, not a saved-query or saved-view catalog.

Relevant implementation: `internal/db/migrations/0001_init.sql`, `internal/store/image.go`, `internal/store/library.go`, `internal/store/tag.go`, `internal/store/prompt.go`, `internal/store/group.go`, `internal/service/library_service.go`, `internal/service/image_service.go`, `frontend/src/components/canvas/library-panel.tsx`, `detail-panel.tsx`, `lightbox.tsx`, and `frontend/src/routes/canvas.tsx`.

## What Obsidian provides

Obsidian **Bases** builds database-like views over files and their Properties. A `.base` definition can contain multiple named views, each with its own layout, displayed properties, filters, and sorting. Bases supports table, cards/gallery, and list layouts; Kanban and map are also listed in current help, with map requiring the Maps plugin. Views can be filtered globally or per-view, use nested all/any/none logic, sort by multiple properties, group by a property, and export/copy results. The table can show built-in and custom summaries.

Obsidian Properties are typed structured fields stored in Markdown frontmatter. The documented types are text, list, number, checkbox, date, date/time, and tags. File properties such as name, size, and modification time can also be used in Bases. Formulas create calculated values that can be displayed, filtered, and sorted. Card views can use a property as a cover image and configure card size, image fit, and aspect ratio.

For image viewing, Obsidian embeds local or externally hosted images inline in notes and lets the author specify dimensions. Recent desktop release notes also describe drag resizing and a fullscreen lightbox with navigation through images embedded in the current file. Loom already covers fullscreen image preview and resizing on the Canvas; Obsidian's additional capability is embedding images into editable narrative notes and controlling their inline layout.

Official documentation:

- [Bases introduction](https://obsidian.md/help/bases)
- [Bases views, filters, sorting, grouping, and export](https://obsidian.md/help/bases/views)
- [Cards view](https://obsidian.md/help/bases/views/cards)
- [Table view and summaries](https://obsidian.md/help/bases/views/table)
- [Properties and supported types](https://obsidian.md/help/properties)
- [Formulas](https://obsidian.md/help/formulas)
- [Image and file embeds](https://obsidian.md/help/embeds)
- [Obsidian 1.13.2 desktop release notes](https://obsidian.md/it/changelog/2026-07-14-desktop-v1.13.2/)

## Ranked opportunities for Loom

Cost is a rough relative estimate: **low** is mostly UI or a small persistence/API addition; **medium** spans service and UI work; **high** adds a foundational data or evaluation model.

| Rank | Opportunity | User value | Cost | Likely change surface | Why it matters |
|---:|---|:---:|:---:|---|---|
| 1 | **Asset gallery and density controls** | High | Low–medium | Assets UI; reuse thumbnail URLs and existing row metadata | Give image-heavy libraries a card/grid mode with adjustable size, image fit, and optional filename, dimensions, tags, or prompt overlays. The existing Canvas is spatial and includes only placed items, so it does not replace a dense repository-wide gallery. This needs no new metadata model. |
| 2 | **Saved asset views** | High | Low–medium | Persist named query/layout definitions through repository settings or a small table; add view controls to Assets | Save useful collections such as “unplaced,” “archived references,” or “tagged portraits,” including their filters and layout. Today the query state is transient, and each visit starts with fixed defaults. |
| 3 | **Richer built-in filtering, sorting, and grouping** | High | Medium | Extend `LibraryQuery`, SQL/service results, and Assets controls | Add operators and combinations over fields Loom already knows: file type, dimensions, aspect ratio, size, date, missing state, tags, prompt, archive state, and placement. Add multi-sort and grouping by tag, type, status, or set. Current filters are a small fixed set combined with AND, and the sort is fixed to newest first. |
| 4 | **Typed custom asset properties** | High | High | SQLite migrations, typed property definitions/values, service bindings, Inspector, catalog queries | Let users capture image-domain facts Loom cannot infer, such as subject, project, rating, license, camera, or review status. Typed values make those fields filterable, sortable, and groupable. This is the foundational change for a true property-driven catalog; it needs decisions about per-repository property definitions, validation, empty values, and migration/undo behavior. |
| 5 | **Property table and direct cell editing** | Medium–high | Medium–high | New Assets table UI; generic property read/write API; keyboard and selection behavior | A table makes metadata scanning and correction faster than opening an Inspector for each asset. Start with existing fields, then add custom properties. Obsidian's table supports cell selection, clipboard operations, and undo/redo for property edits. Its help explicitly says broad bulk property editing is not supported in the Properties view, so full bulk-edit parity should not be assumed. |
| 6 | **Generic multi-asset property assignment** | Medium | Medium | Inspector/table plus batch service operations and undo integration | Loom already batch-edits some fields and performs multi-asset lifecycle actions. Extend that pattern to typed properties, tag removal, prompt reuse, and clear/set operations with explicit handling for mixed values. This is a Loom opportunity, rather than a gap uniquely demonstrated by Obsidian. |
| 7 | **CSV export of the current result set** | Medium | Low–medium | Library service serialization plus UI action | Useful for handoff, reporting, and spreadsheet cleanup. Export should follow the active search, filters, sort, and displayed fields. Bases supports export of the current view. |
| 8 | **Calculated properties and summaries** | Medium | High | Expression language/evaluator, typed operations, query integration, UI | Useful examples could include aspect ratio, megapixels, age, or counts by category. Bases formulas support calculations, text/date/list operations, and linked-note rollups; table summaries aggregate visible values. Loom should build only the image-specific calculations users need. A general evaluator adds type, error, performance, and safety complexity. |
| 9 | **Inline narrative notes with embedded images** | Low for Loom's current workflow | High | New document/editor model and media embedding | Obsidian can mix text and image embeds in notes, set embedded image sizes, and preview images in that document context. Loom's current product centers on managing media and composing it visually. Add a document surface only if users need captions, notes, or editorial sequences that the Inspector and Canvas cannot represent. |

## What Loom should not copy

- **Obsidian's note/file identity model.** Bases rows are vault files whose metadata lives in Markdown. Loom's rows represent actual media files with stable database identity and operational state. Keep the media file as the asset and keep metadata repository-local.
- **A single generic graph for every association.** Loom's directed source-to-derived edges describe provenance between specific images. Sets describe sibling membership. Preserve these meanings; query grouping and tags should not silently become lineage edges or sets.
- **The assumption that a database view is the composition surface.** A Base organizes and edits catalog results. Loom's Canvas is a spatial workspace with saved placement, relationships, and set comparison. A gallery/table should complement the Canvas and the Assets catalog.
- **A full note editor by default.** Embedded images and narrative writing solve a different need. Prioritize image catalog, metadata, and review workflows unless Loom users identify editorial notes as a core job.

## Suggested first slice

Build an Assets gallery using the existing image thumbnails and metadata, then add named views that save filters and sort. This immediately improves visual browsing without changing asset identity or adding a generic property system. Use demand from those views to choose the first typed fields and grouping controls; defer formulas until concrete calculations emerge.
