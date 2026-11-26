//go:build !admissiontest

package service

import (
	"reflect"
	"testing"
)

func TestProductionWailsServiceMembershipIsUnchanged(t *testing.T) {
	services := WailsServices()
	want := []string{
		"*service.RepoService", "*service.ImageService", "*service.MediaService",
		"*service.TagService", "*service.PromptService", "*service.LibraryService",
		"*service.UndoService", "*service.SystemService", "*service.SettingsService",
	}
	got := make([]string, 0, len(services))
	for _, bound := range services {
		got = append(got, reflect.TypeOf(bound.Instance()).String())
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("production Wails services = %v, want unchanged membership %v", got, want)
	}
}
