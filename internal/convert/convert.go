// Package convert marks the plugin boundary for format conversion (Stage 4
// of the design spec). Loom's core data model never hardcodes a format:
// images.file_path/thumb_path are plain strings (internal/store/image.go),
// and internal/store's imageExtensions/videoExtensions already recognize
// video alongside stills — nothing structural assumes AVIF or "image only".
//
// Converter is where a pluggable conversion strategy slots in later (the
// ffmpeg + SVT-AV1 pipeline described in the spec's Stack section). It is
// intentionally not wired up to a service yet — thumbnail.Generate
// (internal/thumbnail) is the one concrete ffmpeg-shelling-out
// implementation that exists today, and it already follows this same
// shape (source path in, dest path out); a future AVIFConverter would
// extract that pattern behind this interface rather than being a second,
// unrelated code path.
package convert

// Converter converts a source file to Result.DestPath, in some
// implementation-specific target format (e.g. AVIF via ffmpeg+SVT-AV1).
// Implementations are expected to be destructive-but-recoverable at the
// call site (per spec: original moves to trash, DB row's file_path
// updates), not inside Converter itself — Converter only produces bytes.
type Converter interface {
	// TargetExt is the file extension (with leading dot, e.g. ".avif")
	// this converter produces.
	TargetExt() string

	// Convert reads srcPath and writes the converted file to destPath.
	// Implementations should copy over existing EXIF/XMP metadata from the
	// original where present, best-effort (see spec's "Metadata: DB only,
	// no file writes" section for why this one exception survives).
	Convert(srcPath, destPath string) error
}
