//go:build !admissiontest

package service

import (
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/media"
)

func WailsServices() []application.Service {
	return []application.Service{
		application.NewService(&RepoService{}),
		application.NewService(&ImageService{}),
		application.NewService(&MediaService{}),
		application.NewService(&TagService{}),
		application.NewService(&PromptService{}),
		application.NewService(&LibraryService{}),
		application.NewService(&UndoService{}),
		application.NewService(&SystemService{}),
		application.NewService(&SettingsService{}),
	}
}

func ServePreviewBindingProfile(w http.ResponseWriter, r *http.Request) {
	servePreviewWithGate(w, r, media.FFmpegProcessor{}, processRenditionGate)
}

func ServeThumbBindingProfile(w http.ResponseWriter, r *http.Request) {
	serveThumbWithGate(w, r, media.FFmpegProcessor{}, processRenditionGate)
}
