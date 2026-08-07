package service

import (
	"encoding/base64"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

const thumbURLPrefix = "/loom-asset/thumb/"

func thumbURL(repoPath string, imageID int64) string {
	enc := base64.RawURLEncoding.EncodeToString([]byte(repoPath))
	return thumbURLPrefix + enc + "/" + strconv.FormatInt(imageID, 10)
}

// IsThumbRequest reports whether path should be routed to ServeThumb.
func IsThumbRequest(path string) bool {
	return strings.HasPrefix(path, thumbURLPrefix)
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
