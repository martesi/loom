package service

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestOverlappingFenceOwnersCannotReopenOrBeRemovedByStaleToken(t *testing.T) {
	root := t.TempDir()
	gate := newRenditionGate()
	registry := newAdmissionRegistryWithRenditionGate(gate)
	lease, err := gate.Admit(root)
	if err != nil {
		t.Fatal(err)
	}
	fenceA, err := registry.AcquireFence(root, "owner-A")
	if err != nil {
		t.Fatal(err)
	}
	fenceB, err := registry.AcquireFence(root, "owner-B")
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.ReleaseFence(fenceA); err != nil {
		t.Fatal(err)
	}
	if err := registry.ReleaseFence(fenceA); !errors.Is(err, errAdmissionNotFound) {
		t.Fatalf("delayed A removal = %v, want stale-owner rejection", err)
	}
	if _, err := gate.Admit(root); !errors.Is(err, errRenditionGateClosed) {
		t.Fatalf("A removal reopened while B and a writer remain: %v", err)
	}
	lease.Release()
	if err := registry.AwaitFence(context.Background(), fenceB); err != nil {
		t.Fatal(err)
	}
	if _, err := gate.Admit(root); !errors.Is(err, errRenditionGateClosed) {
		t.Fatalf("completed drain reopened while B still owns closure: %v", err)
	}
	if err := registry.ReleaseFence(fenceB); err != nil {
		t.Fatal(err)
	}
	finalLease, err := gate.Admit(root)
	if err != nil {
		t.Fatalf("last owner removal did not reopen completed epoch: %v", err)
	}
	finalLease.Release()
	if _, err := registry.AcquireFence(root, "owner-A"); !errors.Is(err, errAdmissionDuplicate) {
		t.Fatalf("reused owner ID = %v, want tombstone rejection", err)
	}
}

func TestUnknownSealJoinsExistingDrainAndReportsOnlyActualOutcome(t *testing.T) {
	root := t.TempDir()
	drainEntered := make(chan struct{})
	finishDrain := make(chan struct{})
	drainFailure := errors.New("renderer cleanup failed")
	registry := newAdmissionRegistry(func(string) error {
		close(drainEntered)
		<-finishDrain
		return drainFailure
	})
	reserveDone := make(chan error, 1)
	go func() {
		_, err := registry.Reserve(root, "active-A", "import", []byte("payload"))
		reserveDone <- err
	}()
	<-drainEntered

	sealDone := make(chan error, 1)
	go func() { sealDone <- registry.SealIfNotStarted(root, "unknown-B") }()
	waitForAdmissionRecord(t, registry, root, "unknown-B")
	status, err := registry.Status(root, "unknown-B")
	if err != nil || status.state != admissionSealed || status.drained {
		t.Fatalf("unknown seal while A drain is pending = %+v, %v", status, err)
	}
	select {
	case err := <-sealDone:
		t.Fatalf("unknown seal returned before actual A drain: %v", err)
	default:
	}

	close(finishDrain)
	if err := <-reserveDone; !errors.Is(err, drainFailure) {
		t.Fatalf("A reserve drain failure = %v", err)
	}
	if err := <-sealDone; !errors.Is(err, drainFailure) {
		t.Fatalf("B seal did not join A drain failure: %v", err)
	}
	status, err = registry.Status(root, "unknown-B")
	if err != nil || status.drained || status.drainError == "" {
		t.Fatalf("B status after failed shared drain = %+v, %v", status, err)
	}
	if closed, err := registry.GateClosed(filepath.Clean(root)); err != nil || !closed {
		t.Fatalf("failed shared drain did not retain recovery hold: %v, %v", closed, err)
	}
}

func TestDispatchWaitsForOperationOwnedChildWriterReferences(t *testing.T) {
	root := t.TempDir()
	gate := newRenditionGate()
	registry := newAdmissionRegistryWithRenditionGate(gate)
	payload := []byte("owned-cache-write")
	ticket, err := registry.Reserve(root, "owned-operation", "discover", payload)
	if err != nil {
		t.Fatal(err)
	}
	childStarted := make(chan struct{})
	finishChild := make(chan struct{})
	dispatchDone := make(chan error, 1)
	go func() {
		_, err := registry.Dispatch(ticket, payload, func() admissionOutcome {
			parent, err := registry.AdmitOperation(ticket)
			if err != nil {
				return admissionFailure(err)
			}
			child, err := parent.Fork(func() {})
			parent.Release()
			if err != nil {
				return admissionFailure(err)
			}
			go func() {
				close(childStarted)
				<-finishChild
				child.Release()
			}()
			return admissionOutcome{result: []byte("started")}
		})
		dispatchDone <- err
	}()
	<-childStarted
	select {
	case err := <-dispatchDone:
		t.Fatalf("dispatch terminalized before operation-owned child finished: %v", err)
	default:
	}
	status, err := registry.Status(root, ticket.id)
	if err != nil || status.state != admissionRunning {
		t.Fatalf("status while owned child is active = %+v, %v", status, err)
	}
	close(finishChild)
	if err := <-dispatchDone; err != nil {
		t.Fatal(err)
	}
	status, err = registry.Status(root, ticket.id)
	if err != nil || status.state != admissionTerminal {
		t.Fatalf("status after owned child completion = %+v, %v", status, err)
	}
	if err := registry.CloseAfterReconciliation(ticket, func(admissionOutcome) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func waitForAdmissionRecord(t *testing.T, registry *admissionRegistry, root, id string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := registry.Status(root, id); err == nil {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("admission record %q was not installed", id)
}
