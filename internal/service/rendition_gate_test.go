package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"loom/internal/media"
)

type ignoringCancelProcessor struct {
	started chan struct{}
	finish  chan struct{}
	calls   atomic.Int32
}

func (processor *ignoringCancelProcessor) Thumbnail(string, string, bool) (media.Dimensions, error) {
	return media.Dimensions{}, nil
}

func (processor *ignoringCancelProcessor) Transcode(string, string, media.TranscodeOptions) error {
	return nil
}

func (processor *ignoringCancelProcessor) Preview(_ context.Context, _, destination string, _ int, _ bool) error {
	if processor.calls.Add(1) == 1 {
		close(processor.started)
	}
	<-processor.finish // Intentionally ignores cancellation until the test releases it.
	return os.WriteFile(destination, []byte("late renderer output"), 0o600)
}

func TestAdmissionDrainGatesRealHandlerAndWaitsForIgnoringRenderer(t *testing.T) {
	root, id, _ := previewTestAsset(t)
	url := previewTestURL(t, root, id, 640)
	gate := newRenditionGate()
	registry := newAdmissionRegistryWithRenditionGate(gate)
	processor := &ignoringCancelProcessor{started: make(chan struct{}), finish: make(chan struct{})}
	firstDone := make(chan struct{})
	first := httptest.NewRecorder()
	go func() {
		serveRenditionWithGate(first, httptest.NewRequest(http.MethodGet, url, nil), processor, 0, "", 0, gate)
		close(firstDone)
	}()
	<-processor.started

	reserveDone := make(chan error, 1)
	var token admissionToken
	go func() {
		var err error
		token, err = registry.Reserve(root, "drain-real-renderer", "replace", []byte("image=1"))
		reserveDone <- err
	}()
	waitGateClosed(t, gate, root)
	if status, err := registry.Status(root, "drain-real-renderer"); err != nil || status.state != admissionDraining {
		t.Fatalf("registry inspection blocked or lost state during renderer drain: %+v, %v", status, err)
	}

	// Alias and original root share one gate. The incoming real handler is
	// rejected before it opens the repository or touches rendition cache files.
	alias := filepath.Join(t.TempDir(), "repo-alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	aliasURL := previewTestURL(t, alias, id, 640)
	blocked := httptest.NewRecorder()
	serveRenditionWithGate(blocked, httptest.NewRequest(http.MethodGet, aliasURL, nil), &previewTestProcessor{}, 0, "", 0, gate)
	if blocked.Code != http.StatusServiceUnavailable {
		t.Fatalf("request during drain status=%d body=%q", blocked.Code, blocked.Body.String())
	}
	select {
	case err := <-reserveDone:
		t.Fatalf("reservation returned while renderer ignored cancellation: %v", err)
	default:
	}

	close(processor.finish)
	if err := <-reserveDone; err != nil {
		t.Fatal(err)
	}
	<-firstDone
	if first.Code != http.StatusServiceUnavailable {
		t.Fatalf("cancelled renderer response status=%d body=%q", first.Code, first.Body.String())
	}
	cacheEntries, err := filepath.Glob(filepath.Join(root, ".loom", "thumbs", ".preview-*.webp"))
	if err != nil || len(cacheEntries) != 0 {
		t.Fatalf("temporary renderer files after drain = %v, err=%v", cacheEntries, err)
	}
	if status, err := registry.Status(root, token.id); err != nil || status.state != admissionReserved {
		t.Fatalf("reservation after real drain = %+v, %v", status, err)
	}
	if err := registry.SealIfNotStarted(root, token.id); err != nil {
		t.Fatal(err)
	}
	if admitted, err := gate.Admit(root); err != nil {
		t.Fatalf("sealed unstarted operation did not reopen the gate: %v", err)
	} else {
		admitted.Release()
	}
}

func TestAdmissionDrainWaitsThroughRealPublicationAndPruning(t *testing.T) {
	root, id, _ := previewTestAsset(t)
	url := previewTestURL(t, root, id, 640)
	gate := newRenditionGate()
	registry := newAdmissionRegistryWithRenditionGate(gate)
	maintenanceEntered := make(chan struct{})
	allowMaintenanceReturn := make(chan struct{})
	previousHook := afterRenditionCacheMaintenance
	afterRenditionCacheMaintenance = func() {
		close(maintenanceEntered)
		<-allowMaintenanceReturn
	}
	t.Cleanup(func() { afterRenditionCacheMaintenance = previousHook })

	response := httptest.NewRecorder()
	requestDone := make(chan struct{})
	go func() {
		serveRenditionWithGate(response, httptest.NewRequest(http.MethodGet, url, nil), &previewTestProcessor{}, 0, "", 0, gate)
		close(requestDone)
	}()
	<-maintenanceEntered

	reserveDone := make(chan error, 1)
	var token admissionToken
	go func() {
		var err error
		token, err = registry.Reserve(root, "publish-drain", "replace", []byte("image=9"))
		reserveDone <- err
	}()
	waitGateClosed(t, gate, root)
	select {
	case err := <-reserveDone:
		t.Fatalf("reservation returned before cache maintenance completed: %v", err)
	default:
	}
	close(allowMaintenanceReturn)
	if err := <-reserveDone; err != nil {
		t.Fatal(err)
	}
	<-requestDone
	if response.Code != http.StatusOK {
		t.Fatalf("real cache-maintenance response status=%d body=%q", response.Code, response.Body.String())
	}
	cacheFiles, err := filepath.Glob(filepath.Join(root, ".loom", "thumbs", "*-640-*.webp"))
	if err != nil || len(cacheFiles) != 1 {
		t.Fatalf("published cache files=%v err=%v, want one completed output", cacheFiles, err)
	}
	if err := registry.SealIfNotStarted(root, token.id); err != nil {
		t.Fatal(err)
	}
}

func TestRenditionGateNoWorkDrainOtherRootAndReadOnlyObservation(t *testing.T) {
	root, id, _ := previewTestAsset(t)
	otherRoot, otherID, _ := previewTestAsset(t)
	gate := newRenditionGate()
	registry := newAdmissionRegistryWithRenditionGate(gate)
	token, err := registry.Reserve(root, "empty-drain", "settings", []byte("setting=x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Reserve(root, "concurrent", "settings", nil); !errors.Is(err, errAdmissionBusy) {
		t.Fatalf("concurrent reservation error=%v", err)
	}
	if _, err := gate.Admit(root); !errors.Is(err, errRenditionGateClosed) {
		t.Fatalf("ordinary request during reserved operation: %v", err)
	}
	imagePath := filepath.Join(root, "asset.png")
	thumbnailURL := thumbURL(root, id, imagePath)
	thumbnail := httptest.NewRecorder()
	serveRenditionWithGate(thumbnail, httptest.NewRequest(http.MethodGet, thumbnailURL, nil), &previewTestProcessor{}, 320, root, id, gate)
	if thumbnail.Code != http.StatusServiceUnavailable {
		t.Fatalf("thumbnail mutation during reservation status=%d body=%q", thumbnail.Code, thumbnail.Body.String())
	}
	otherLease, err := gate.Admit(otherRoot)
	if err != nil {
		t.Fatalf("other root was blocked: %v", err)
	}
	otherLease.Release()

	// A cache-only observation stays available while ordinary cache mutations
	// are gated. It neither acquires a lease nor changes the reservation state.
	url := previewTestURL(t, root, id, 640) + "&cacheOnly=1"
	observed := httptest.NewRecorder()
	serveRenditionWithGate(observed, httptest.NewRequest(http.MethodGet, url, nil), &previewTestProcessor{}, 0, "", 0, gate)
	if observed.Code != http.StatusNoContent {
		t.Fatalf("cache-only observation status=%d body=%q", observed.Code, observed.Body.String())
	}
	if status, err := registry.Status(root, token.id); err != nil || status.state != admissionReserved {
		t.Fatalf("observation changed reservation state: %+v, %v", status, err)
	}
	otherURL := previewTestURL(t, otherRoot, otherID, 640)
	otherResponse := httptest.NewRecorder()
	serveRenditionWithGate(otherResponse, httptest.NewRequest(http.MethodGet, otherURL, nil), &previewTestProcessor{}, 0, "", 0, gate)
	if otherResponse.Code != http.StatusOK {
		t.Fatalf("other-root handler status=%d body=%q", otherResponse.Code, otherResponse.Body.String())
	}
	if err := registry.SealIfNotStarted(root, token.id); err != nil {
		t.Fatal(err)
	}
}

func TestRenditionGateTerminalReconcileFailureAndOtherFence(t *testing.T) {
	root, id, _ := previewTestAsset(t)
	gate := newRenditionGate()
	registry := newAdmissionRegistryWithRenditionGate(gate)
	payload := []byte("replace=7")
	token, err := registry.Reserve(root, "terminal-gate", "replace", payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Dispatch(token, payload, func() admissionOutcome {
		return admissionOutcome{errorMessage: "partial failure", partialResults: []string{"one committed"}}
	}); err != nil {
		t.Fatal(err)
	}
	if err := registry.CloseAfterReconciliation(token, func(admissionOutcome) error { return errors.New("reconcile unavailable") }); err == nil {
		t.Fatal("failed reconciliation reopened the gate")
	}
	if _, err := gate.Admit(root); !errors.Is(err, errRenditionGateClosed) {
		t.Fatalf("gate after failed reconciliation = %v", err)
	}
	if err := registry.SetIndependentFence(root, "recovery", true); err != nil {
		t.Fatal(err)
	}
	if err := registry.CloseAfterReconciliation(token, func(outcome admissionOutcome) error {
		if outcome.errorMessage != "partial failure" || len(outcome.partialResults) != 1 {
			return errors.New("partial result was not reconciled")
		}
		return nil
	}); !errors.Is(err, errAdmissionOtherFence) {
		t.Fatalf("close under independent fence = %v", err)
	}
	if err := registry.SetIndependentFence(root, "recovery", false); err != nil {
		t.Fatal(err)
	}
	if err := registry.CloseAfterReconciliation(token, func(admissionOutcome) error { return nil }); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	serveRenditionWithGate(response, httptest.NewRequest(http.MethodGet, previewTestURL(t, root, id, 640), nil), &previewTestProcessor{}, 0, "", 0, gate)
	if response.Code != http.StatusOK {
		t.Fatalf("handler after terminal reconcile status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestRenditionGateDrainTimeoutStaysClosed(t *testing.T) {
	root, _, _ := previewTestAsset(t)
	gate := newRenditionGate()
	lease, err := gate.Admit(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if err := gate.CloseAndDrain(ctx, root); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain timeout = %v", err)
	}
	if _, err := gate.Admit(root); !errors.Is(err, errRenditionGateClosed) {
		t.Fatalf("gate reopened after stalled drain: %v", err)
	}
	lease.Release()
	if err := gate.Reopen(root); err != nil {
		t.Fatal(err)
	}
}

func waitGateClosed(t *testing.T, gate *renditionGate, root string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		lease, err := gate.Admit(root)
		if errors.Is(err, errRenditionGateClosed) {
			return
		}
		if lease != nil {
			lease.Release()
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("rendition gate did not close")
}
