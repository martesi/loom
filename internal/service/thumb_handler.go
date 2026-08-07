package service

import (
	"encoding/base64"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"loom/internal/store"
)

const (
	thumbURLPrefix = "/loom-asset/thumb/"
	fullURLPrefix  = "/loom-asset/full/"
)

func thumbURL(repoPath string, imageID int64) string {
	enc := base64.RawURLEncoding.EncodeToString([]byte(repoPath))
	return thumbURLPrefix + enc + "/" + strconv.FormatInt(imageID, 10)
}

func fullURL(repoPath string, imageID int64) string {
	enc := base64.RawURLEncoding.EncodeToString([]byte(repoPath))
	return fullURLPrefix + enc + "/" + strconv.FormatInt(imageID, 10)
}

// IsThumbRequest reports whether path should be routed to ServeThumb.
func IsThumbRequest(path string) bool {
	return strings.HasPrefix(path, thumbURLPrefix)
}

// IsFullRequest reports whether path should be routed to ServeFull.
func IsFullRequest(path string) bool {
	return strings.HasPrefix(path, fullURLPrefix)
}

// ServeThumb serves a previously generated thumbnail directly off disk,
// keyed by the (base64url-encoded) repo path and image ID baked into the
// URL by thumbURL — this keeps thumbnail bytes off the Wails IPC channel,
// letting the webview cache them like any other image request.
func ServeThumb(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, thumbURLPrefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	repoPathBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	imageID, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	thumbPath := filepath.Join(string(repoPathBytes), ".loom", "thumbs", strconv.FormatInt(imageID, 10)+".avif")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, thumbPath)
}

// ServeFull serves an image's actual full-resolution file off disk, keyed
// the same way as ServeThumb — used by the lightbox, which needs the real
// file rather than the small cached thumbnail. Looking up file_path (rather
// than assuming a naming convention, as thumbnails do) means this stays
// correct across renames/conversions that change where the file lives.
func ServeFull(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, fullURLPrefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	repoPathBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	imageID, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	repo, err := store.Bootstrap(string(repoPathBytes))
	if err != nil {
		http.Error(w, "repo unavailable", http.StatusInternalServerError)
		return
	}
	defer repo.Close()

	filePath, err := repo.GetFilePath(imageID)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, filePath)
}
