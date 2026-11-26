//go:build admissiontest

package service

import (
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/media"
)

var admissionTestGate = newRenditionGate()
var admissionTestRegistry = newAdmissionRegistryWithRenditionGate(admissionTestGate)

func WailsServices() []application.Service {
	return []application.Service{application.NewService(newAdmissionFacade(admissionTestRegistry))}
}

func ServePreviewBindingProfile(w http.ResponseWriter, r *http.Request) {
	servePreviewWithGate(w, r, media.FFmpegProcessor{}, admissionTestGate)
}

func ServeThumbBindingProfile(w http.ResponseWriter, r *http.Request) {
	serveThumbWithGate(w, r, media.FFmpegProcessor{}, admissionTestGate)
}
