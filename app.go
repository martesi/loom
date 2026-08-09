package main

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/service"
)

//go:embed all:frontend/dist
var assets embed.FS

// appOptions builds the application.Options shared by the native desktop
// entrypoint (main.go) and the headless server entrypoint (main_server.go),
// so the service list and asset wiring can't drift between the two. Callers
// pass the result to application.New, adding any mode-specific fields
// (e.g. main_server.go's Server options) first.
//
// wrap, if non-nil, is layered around the thumbnail/full-image middleware —
// the server entrypoint uses it to install the auth gate ahead of every
// request, including RPC calls, without desktop mode paying for it.
func appOptions(wrap func(http.Handler) http.Handler) application.Options {
	distFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		// Guaranteed present by the go:embed directive above; a build-time
		// invariant, not a runtime condition.
		panic(err)
	}

	assetMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case service.IsThumbRequest(r.URL.Path):
				service.ServeThumb(w, r)
			case service.IsFullRequest(r.URL.Path):
				service.ServeFull(w, r)
			default:
				next.ServeHTTP(w, spaFallback(r, distFS))
			}
		})
	}

	middleware := assetMiddleware
	if wrap != nil {
		middleware = func(next http.Handler) http.Handler {
			return wrap(assetMiddleware(next))
		}
	}

	return application.Options{
		Name:        "Loom",
		Description: "Local-first image derivation manager",
		Services: []application.Service{
			application.NewService(&service.RepoService{}),
			application.NewService(&service.ImageService{}),
			application.NewService(&service.BoardService{}),
			application.NewService(&service.GroupService{}),
			application.NewService(&service.TagService{}),
			application.NewService(&service.PromptService{}),
			application.NewService(&service.LibraryService{}),
			application.NewService(&service.UndoService{}),
			application.NewService(&service.SystemService{}),
			application.NewService(&service.SettingsService{}),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: middleware,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	}
}

// spaFallback rewrites requests for paths that don't correspond to a real
// embedded file to "/" instead, so a hard navigation to a client-side route
// (e.g. /board/42 — a browser reload, a bookmark, a link opened in a new
// tab) resolves to index.html the same way "/" itself does, letting the
// in-page router take over from there. Wails' asset server has no such
// fallback built in — an unmatched path is just a 404 — which is invisible
// for a native window (its URL is set once at creation and never manually
// re-navigated) but a hard blocker for browser tabs, which get reloaded
// routinely.
func spaFallback(r *http.Request, dist fs.FS) *http.Request {
	if r.Method != http.MethodGet || strings.HasPrefix(r.URL.Path, "/wails/") {
		return r
	}

	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "." {
		return r // already "/", which the asset server serves as index.html itself
	}
	if _, err := fs.Stat(dist, name); err == nil {
		return r // a real embedded file — let the asset server serve it as-is
	}

	rewritten := new(http.Request)
	*rewritten = *r
	rewrittenURL := *r.URL
	rewrittenURL.Path = "/"
	rewritten.URL = &rewrittenURL
	return rewritten
}
