//go:build admissiontest

package service

import (
	"reflect"
	"sort"
	"testing"
)

var legacyBindingReceivers = []string{
	"*service.RepoService",
	"*service.ImageService",
	"*service.MediaService",
	"*service.TagService",
	"*service.PromptService",
	"*service.LibraryService",
	"*service.UndoService",
	"*service.SystemService",
	"*service.SettingsService",
}

func TestAdmissionBindingProfileExposesOnlyTokenBearingFacadeMethods(t *testing.T) {
	services := WailsServices()
	if len(services) != 1 {
		t.Fatalf("admission-test profile exposes %d Wails services; want only the facade", len(services))
	}
	if _, ok := services[0].Instance().(*AdmissionFacade); !ok {
		t.Fatalf("admission-test service is %T, want *AdmissionFacade", services[0].Instance())
	}
	for _, bound := range services {
		for _, legacy := range legacyBindingReceivers {
			if reflect.TypeOf(bound.Instance()).String() == legacy {
				t.Fatalf("admission-test profile exposed unconverted mutation receiver %s", legacy)
			}
		}
	}

	typ := reflect.TypeOf((*AdmissionFacade)(nil))
	var methods []string
	for index := range typ.NumMethod() {
		methods = append(methods, typ.Method(index).Name)
	}
	sort.Strings(methods)
	want := []string{"Dispatch", "InspectRepository", "ObserveCanvas", "Reconcile", "Reserve", "Seal", "SealUnclaimed", "Status"}
	if !reflect.DeepEqual(methods, want) {
		t.Fatalf("facade Wails method set = %v, want %v; an untagged endpoint may have been exposed", methods, want)
	}
}
