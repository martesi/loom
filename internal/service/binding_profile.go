//go:build !admissiontest

package service

import (
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
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
	ServePreview(w, r)
}

func ServeThumbBindingProfile(w http.ResponseWriter, r *http.Request) {
	ServeThumb(w, r)
}
