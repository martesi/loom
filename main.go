package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/service"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	distFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		// Guaranteed present by the go:embed directive above; a build-time
		// invariant, not a runtime condition.
		panic(err)
	}

	assetMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case service.IsPreviewRequest(r.URL.Path):
				service.ServePreview(w, r)
			case service.IsThumbRequest(r.URL.Path):
				service.ServeThumb(w, r)
			case service.IsFullRequest(r.URL.Path):
				service.ServeFull(w, r)
			default:
				if os.Getenv("FRONTEND_DEVSERVER_URL") != "" {
					next.ServeHTTP(w, r)
				} else {
					next.ServeHTTP(w, spaFallback(r, distFS))
				}
			}
		})
	}

	app := application.New(application.Options{
		Name:        "Loom",
		Description: "Local-first image derivation manager",
		Services: []application.Service{
			application.NewService(&service.RepoService{}),
			application.NewService(&service.ImageService{}),
			application.NewService(&service.MediaService{}),
			application.NewService(&service.TagService{}),
			application.NewService(&service.PromptService{}),
			application.NewService(&service.LibraryService{}),
			application.NewService(&service.UndoService{}),
			application.NewService(&service.SystemService{}),
			application.NewService(&service.SettingsService{}),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: assetMiddleware,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	if app.Env.Info().PlatformInfo["mode"] != "server" {
		app.Window.NewWithOptions(application.WebviewWindowOptions{
			Title:            "Loom",
			Width:            1200,
			Height:           800,
			BackgroundColour: application.NewRGB(243, 242, 241),
			URL:              "/",
			// The app has its own right-click menus (canvas pane, canvas nodes,
			// list rows) — without this, the webview's native context menu
			// (Reload/Inspect Element/etc.) competes with or masks them.
			DefaultContextMenuDisabled: true,
		})
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// spaFallback rewrites requests for paths that don't correspond to a real
// embedded file to "/" instead, so a hard navigation to a client-side route
// (e.g. /canvas — a browser reload, a bookmark, a link opened in a new
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
