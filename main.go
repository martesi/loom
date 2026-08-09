//go:build !server

package main

import (
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func main() {
	app := application.New(appOptions(nil))

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

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
