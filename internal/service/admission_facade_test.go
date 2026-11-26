package service

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"loom/internal/store"
)

func TestAdmissionFacadeDiscoverCanvasVerticalSlice(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "asset.png"), []byte("fixture image bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Prepare the repository before admission so this test isolates the
	// DiscoverCanvas binding. Bootstrap/migration admission is a separate seam.
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	gate := newRenditionGate()
	registry := newAdmissionRegistryWithRenditionGate(gate)
	facade := newAdmissionFacade(registry)
	payload, _ := json.Marshal(discoverCanvasPayload{Action: admissionDiscoverCanvas})

	if _, err := facade.Reserve(root, "discover-1", "unknown", payload); !errors.Is(err, errAdmissionUnknownOperation) {
		t.Fatalf("unknown operation reserve = %v", err)
	}
	ticket, err := facade.Reserve(root, "discover-1", admissionDiscoverCanvas, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := facade.Reserve(root, "discover-1", admissionDiscoverCanvas, payload); !errors.Is(err, errAdmissionDuplicate) {
		t.Fatalf("duplicate reserve = %v", err)
	}
	if _, err := gate.Admit(root); !errors.Is(err, errRenditionGateClosed) {
		t.Fatalf("ordinary rendition gate after reserve = %v", err)
	}

	readOnly, err := facade.ObserveCanvas(root)
	if err != nil || readOnly == nil || len(readOnly.Canvas.Images) != 0 {
		t.Fatalf("read-only observation while reserved = %+v, %v", readOnly, err)
	}
	staleTicket := ticket
	staleTicket.Epoch++
	if _, err := facade.Dispatch(staleTicket, payload); !errors.Is(err, errAdmissionMismatch) {
		t.Fatalf("stale epoch dispatch = %v", err)
	}
	wrongDigest := ticket
	wrongDigest.PayloadDigest = "0000000000000000000000000000000000000000000000000000000000000000"
	if _, err := facade.Dispatch(wrongDigest, payload); !errors.Is(err, errAdmissionMismatch) {
		t.Fatalf("wrong digest dispatch = %v", err)
	}
	status, err := facade.Status(root, ticket.OperationID)
	if err != nil || status.State != string(admissionReserved) {
		t.Fatalf("reservation status after rejected calls = %+v, %v", status, err)
	}

	result, err := facade.Dispatch(ticket, payload)
	if err != nil || result.ErrorMessage != "" || result.Result != "discovered" {
		t.Fatalf("DiscoverCanvas dispatch = %+v, %v", result, err)
	}
	if _, err := facade.Dispatch(ticket, payload); !errors.Is(err, errAdmissionNotReady) {
		t.Fatalf("duplicate dispatch = %v", err)
	}
	status, err = facade.Status(root, ticket.OperationID)
	if err != nil || status.State != string(admissionTerminal) {
		t.Fatalf("terminal operation status = %+v, %v", status, err)
	}
	observed, err := facade.ObserveCanvas(root)
	if err != nil || observed == nil || len(observed.Canvas.Images) != 1 {
		t.Fatalf("post-discovery observation = %+v, %v", observed, err)
	}
	if err := facade.Reconcile(ticket); err != nil {
		t.Fatal(err)
	}
	if lease, err := gate.Admit(root); err != nil {
		t.Fatalf("gate after terminal reconciliation = %v", err)
	} else {
		lease.Release()
	}
}

func TestAdmissionFacadeSealedDelayedDispatchAndStaleTicket(t *testing.T) {
	root := t.TempDir()
	repo, err := store.Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	registry := newAdmissionRegistryWithRenditionGate(newRenditionGate())
	facade := newAdmissionFacade(registry)
	payload, _ := json.Marshal(discoverCanvasPayload{Action: admissionDiscoverCanvas})
	ticket, err := facade.Reserve(root, "lost-reserve-response", admissionDiscoverCanvas, payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := facade.SealUnclaimed(root, ticket.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := facade.Dispatch(ticket, payload); !errors.Is(err, errAdmissionSealed) {
		t.Fatalf("delayed dispatch after seal = %v", err)
	}
	if _, err := facade.Reserve(root, ticket.OperationID, admissionDiscoverCanvas, payload); !errors.Is(err, errAdmissionDuplicate) {
		t.Fatalf("late reserve after seal = %v", err)
	}

	second, err := facade.Reserve(root, "fresh-epoch", admissionDiscoverCanvas, payload)
	if err != nil {
		t.Fatal(err)
	}
	oldEpoch := second
	oldEpoch.Epoch--
	if _, err := facade.Dispatch(oldEpoch, payload); !errors.Is(err, errAdmissionMismatch) {
		t.Fatalf("old epoch before dispatch = %v", err)
	}
	if err := facade.Seal(second); err != nil {
		t.Fatal(err)
	}
}

func TestAdmissionFacadeReadOnlyInspectAndAdmittedMigration(t *testing.T) {
	root := t.TempDir()
	loomDir := filepath.Join(root, ".loom")
	if err := os.MkdirAll(loomDir, 0o700); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(loomDir, "db.sqlite")
	if err := os.WriteFile(dbPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	registry := newAdmissionRegistryWithRenditionGate(newRenditionGate())
	facade := newAdmissionFacade(registry)
	inspection, err := facade.InspectRepository(root)
	if err != nil || !inspection.DatabaseExists || len(inspection.Pending) == 0 {
		t.Fatalf("read-only old-schema inspection = %+v, %v", inspection, err)
	}
	if info, err := os.Stat(dbPath); err != nil || info.Size() != 0 {
		t.Fatalf("inspection changed legacy database bytes: info=%v err=%v", info, err)
	}
	if _, err := facade.Reserve(root, "premature-discover", admissionDiscoverCanvas, []byte(`{"action":"discover_canvas"}`)); !errors.Is(err, errAdmissionMigrationRequired) {
		t.Fatalf("discovery before migration reserve = %v", err)
	}

	payload := []byte(`{"action":"migrate_repository"}`)
	ticket, err := facade.Reserve(root, "migrate-legacy", admissionMigrateRepository, payload)
	if err != nil {
		t.Fatal(err)
	}
	result, err := facade.Dispatch(ticket, payload)
	if err != nil || result.Result != "migrated" {
		t.Fatalf("admitted migration = %+v, %v", result, err)
	}
	inspection, err = facade.InspectRepository(root)
	if err != nil || len(inspection.Pending) != 0 {
		t.Fatalf("schema after admitted migration = %+v, %v", inspection, err)
	}
	if err := facade.Reconcile(ticket); err != nil {
		t.Fatal(err)
	}
	if _, err := facade.Reserve(root, "discover-current", admissionDiscoverCanvas, []byte(`{"action":"discover_canvas"}`)); err != nil {
		t.Fatalf("discovery after explicit migration = %v", err)
	}
}
