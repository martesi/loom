package main

import (
	"embed"
	"log"
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/service"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := application.New(application.Options{
		Name:        "Loom",
		Description: "Local-first image derivation manager",
		Services: []application.Service{
			application.NewService(&service.RepoService{}),
			application.NewService(&service.ImageService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if service.IsThumbRequest(r.URL.Path) {
						service.ServeThumb(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Loom",
		Width:            1200,
		Height:           800,
		BackgroundColour: application.NewRGB(243, 242, 241),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
