package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"loom/internal/store"
)

func TestAdmissionDrainAndSealLinearizeAgainstDelayedDispatch(t *testing.T) {
	root := t.TempDir()
	enteredDrain := make(chan struct{})
	finishDrain := make(chan struct{})
	registry := newAdmissionRegistry(func(string) error {
		close(enteredDrain)
		<-finishDrain
		return nil
	})
	reserveDone := make(chan error, 1)
	go func() {
		_, err := registry.Reserve(root, "lost-ack", "import", []byte("payload"))
		reserveDone <- err
	}()
	<-enteredDrain
	status, err := registry.Status(root, "lost-ack")
	if err != nil || status.state != admissionDraining {
		t.Fatalf("draining status = %+v, %v", status, err)
	}
	if closed, err := registry.GateClosed(root); err != nil || !closed {
		t.Fatalf("gate during drain = %v, %v", closed, err)
	}

	sealDone := make(chan error, 1)
	go func() { sealDone <- registry.SealIfNotStarted(root, "lost-ack") }()
	waitAdmissionState(t, registry, root, "lost-ack", admissionSealed)
	close(finishDrain)
	if err := <-reserveDone; !errors.Is(err, errAdmissionSealed) {
		t.Fatalf("reserve after concurrent seal = %v, want sealed", err)
	}
	if err := <-sealDone; err != nil {
		t.Fatalf("seal after drain = %v", err)
	}
	status, err = registry.Status(root, "lost-ack")
	if err != nil || status.state != admissionSealed || !status.drained {
		t.Fatalf("sealed status = %+v, %v", status, err)
	}
	if _, err := registry.Reserve(root, "lost-ack", "import", []byte("payload")); !errors.Is(err, errAdmissionDuplicate) {
		t.Fatalf("late reserve error = %v, want duplicate tombstone", err)
	}
	token := admissionToken{root: statusRoot(t, root), id: "lost-ack", epoch: status.epoch, kind: status.kind, digest: status.digest}
	var executions atomic.Int32
	if _, err := registry.Dispatch(token, []byte("payload"), func() admissionOutcome {
		executions.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionSealed) {
		t.Fatalf("late dispatch error = %v, want sealed", err)
	}
	if executions.Load() != 0 {
		t.Fatalf("late dispatch executed work %d times", executions.Load())
	}
	if closed, err := registry.GateClosed(root); err != nil || closed {
		t.Fatalf("successfully sealed unstarted gate = %v, %v", closed, err)
	}
}

func TestAdmissionRejectsDuplicateAndMismatchedBindings(t *testing.T) {
	root := t.TempDir()
	registry := newAdmissionRegistry(func(string) error { return nil })
	token, err := registry.Reserve(root, "operation-1", "trash", []byte("ids:1,2"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Reserve(root, "operation-1", "trash", []byte("ids:1,2")); !errors.Is(err, errAdmissionDuplicate) {
		t.Fatalf("duplicate reserve error = %v", err)
	}
	var executed atomic.Int32
	if _, err := registry.Dispatch(token, []byte("ids:2,1"), func() admissionOutcome {
		executed.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionMismatch) {
		t.Fatalf("payload mismatch error = %v", err)
	}
	wrongKind := token
	wrongKind.kind = "purge"
	if _, err := registry.Dispatch(wrongKind, []byte("ids:1,2"), func() admissionOutcome {
		executed.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionMismatch) {
		t.Fatalf("kind mismatch error = %v", err)
	}
	wrongEpoch := token
	wrongEpoch.epoch++
	if _, err := registry.Dispatch(wrongEpoch, []byte("ids:1,2"), func() admissionOutcome {
		executed.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionMismatch) {
		t.Fatalf("epoch mismatch error = %v", err)
	}
	if executed.Load() != 0 {
		t.Fatalf("mismatched dispatch executed work %d times", executed.Load())
	}
	if err := registry.SealIfNotStarted(root, token.id); err != nil {
		t.Fatal(err)
	}
}

func TestAdmissionLostReadyResponseCanBeSealedBeforeLateDispatch(t *testing.T) {
	root := t.TempDir()
	registry := newAdmissionRegistry(func(string) error { return nil })
	// Model a successful reservation whose response did not reach its caller.
	token, err := registry.Reserve(root, "lost-ready-response", "import", []byte("batch"))
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.SealIfNotStarted(root, token.id); err != nil {
		t.Fatal(err)
	}
	var executions atomic.Int32
	if _, err := registry.Dispatch(token, []byte("batch"), func() admissionOutcome {
		executions.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionSealed) {
		t.Fatalf("late dispatch error = %v", err)
	}
	if executions.Load() != 0 {
		t.Fatalf("late dispatch executed work %d times", executions.Load())
	}
	if _, err := registry.Reserve(root, token.id, token.kind, []byte("batch")); !errors.Is(err, errAdmissionDuplicate) {
		t.Fatalf("late reserve error = %v", err)
	}
}

func TestAdmissionSealAndDispatchRaceHasOneLinearizedWinner(t *testing.T) {
	for attempt := range 24 {
		root := filepath.Join(t.TempDir(), "repo")
		if err := os.Mkdir(root, 0o700); err != nil {
			t.Fatal(err)
		}
		registry := newAdmissionRegistry(func(string) error { return nil })
		payload := []byte("replace image 7")
		token, err := registry.Reserve(root, fmt.Sprintf("race-%d", attempt), "replace", payload)
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		dispatchDone := make(chan error, 1)
		sealDone := make(chan error, 1)
		var executions atomic.Int32
		go func() {
			<-start
			_, err := registry.Dispatch(token, payload, func() admissionOutcome {
				executions.Add(1)
				return admissionOutcome{result: []byte("replaced")}
			})
			dispatchDone <- err
		}()
		go func() {
			<-start
			sealDone <- registry.SealIfNotStarted(root, token.id)
		}()
		close(start)
		dispatchErr := <-dispatchDone
		sealErr := <-sealDone
		status, err := registry.Status(root, token.id)
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case dispatchErr == nil:
			if !errors.Is(sealErr, errAdmissionStarted) || executions.Load() != 1 || status.state != admissionTerminal {
				t.Fatalf("dispatch won inconsistently: dispatch=%v seal=%v runs=%d state=%s", dispatchErr, sealErr, executions.Load(), status.state)
			}
			if err := registry.CloseAfterReconciliation(token, func(admissionOutcome) error { return nil }); err != nil {
				t.Fatal(err)
			}
		case errors.Is(dispatchErr, errAdmissionSealed):
			if sealErr != nil || executions.Load() != 0 || status.state != admissionSealed {
				t.Fatalf("seal won inconsistently: dispatch=%v seal=%v runs=%d state=%s", dispatchErr, sealErr, executions.Load(), status.state)
			}
		default:
			t.Fatalf("race had no valid winner: dispatch=%v seal=%v", dispatchErr, sealErr)
		}
	}
}

func TestAdmissionDrainFailureLeavesRootFenced(t *testing.T) {
	root := t.TempDir()
	drainErr := errors.New("rendition worker did not drain")
	registry := newAdmissionRegistry(func(string) error { return drainErr })
	if _, err := registry.Reserve(root, "failed-drain", "settings", []byte("key=value")); !errors.Is(err, drainErr) {
		t.Fatalf("reserve drain error = %v", err)
	}
	status, err := registry.Status(root, "failed-drain")
	if err != nil || status.state != admissionSealed || status.drained || status.drainError != drainErr.Error() {
		t.Fatalf("failed drain status = %+v, %v", status, err)
	}
	if closed, err := registry.GateClosed(root); err != nil || !closed {
		t.Fatalf("failed drain opened gate: closed=%v err=%v", closed, err)
	}
	if err := registry.SealIfNotStarted(root, "failed-drain"); !errors.Is(err, drainErr) {
		t.Fatalf("failed drain seal result = %v", err)
	}
	if _, err := registry.Reserve(root, "next", "settings", nil); !errors.Is(err, errAdmissionBusy) {
		t.Fatalf("reserve after failed drain = %v", err)
	}
}

func TestAdmissionRetainsTerminalOutcomeUntilJoinedWorkAndReconciliation(t *testing.T) {
	root := t.TempDir()
	registry := newAdmissionRegistry(func(string) error { return nil })
	payload := []byte("batch with two files")
	token, err := registry.Reserve(root, "partial-import", "import", payload)
	if err != nil {
		t.Fatal(err)
	}
	childStarted := make(chan struct{})
	allowChildFinish := make(chan struct{})
	workDone := make(chan error, 1)
	var executions atomic.Int32
	go func() {
		_, err := registry.Dispatch(token, payload, func() admissionOutcome {
			executions.Add(1)
			childDone := make(chan struct{})
			go func() {
				close(childStarted)
				<-allowChildFinish
				close(childDone)
			}()
			<-childDone // The owner joins its mutating child before returning.
			return admissionOutcome{
				result: []byte("item-1"), errorMessage: "item 2 failed",
				partialResults: []string{"item-1 committed"},
			}
		})
		workDone <- err
	}()
	<-childStarted
	waitAdmissionState(t, registry, root, token.id, admissionRunning)
	if err := registry.SealIfNotStarted(root, token.id); !errors.Is(err, errAdmissionStarted) {
		t.Fatalf("seal after dispatch claim = %v", err)
	}
	if _, err := registry.Dispatch(token, payload, func() admissionOutcome {
		executions.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionNotReady) {
		t.Fatalf("duplicate running dispatch = %v", err)
	}
	status, err := registry.Status(root, token.id)
	if err != nil || status.state != admissionRunning {
		t.Fatalf("work terminalized before child join: %+v, %v", status, err)
	}
	close(allowChildFinish)
	if err := <-workDone; err != nil {
		t.Fatal(err)
	}
	if executions.Load() != 1 {
		t.Fatalf("claimed work executed %d times", executions.Load())
	}
	status, err = registry.Status(root, token.id)
	if err != nil || status.state != admissionTerminal || status.outcome.errorMessage != "item 2 failed" || len(status.outcome.partialResults) != 1 {
		t.Fatalf("terminal partial outcome = %+v, %v", status, err)
	}
	if _, err := registry.Dispatch(token, payload, func() admissionOutcome {
		executions.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionNotReady) {
		t.Fatalf("duplicate terminal dispatch = %v", err)
	}

	reconcileEntered := make(chan struct{})
	allowReconcile := make(chan struct{})
	closeDone := make(chan error, 1)
	go func() {
		closeDone <- registry.CloseAfterReconciliation(token, func(outcome admissionOutcome) error {
			if outcome.errorMessage != "item 2 failed" || len(outcome.partialResults) != 1 {
				return errors.New("terminal diagnostics were not passed to reconciliation")
			}
			close(reconcileEntered)
			<-allowReconcile
			return nil
		})
	}()
	<-reconcileEntered
	// Inspection remains available while reconciliation blocks, proving that
	// CloseAfterReconciliation does not hold the registry mutex while waiting.
	if _, err := registry.Status(root, token.id); err != nil {
		t.Fatalf("status blocked during reconciliation: %v", err)
	}
	if err := registry.SetIndependentFence(root, "recovery", true); err != nil {
		t.Fatal(err)
	}
	close(allowReconcile)
	if err := <-closeDone; !errors.Is(err, errAdmissionOtherFence) {
		t.Fatalf("close with an independent fence = %v", err)
	}
	if closed, err := registry.GateClosed(root); err != nil || !closed {
		t.Fatalf("gate opened with recovery fence: closed=%v err=%v", closed, err)
	}
	if err := registry.SetIndependentFence(root, "recovery", false); err != nil {
		t.Fatal(err)
	}
	if err := registry.CloseAfterReconciliation(token, func(admissionOutcome) error { return nil }); err != nil {
		t.Fatalf("close after reconciliation and fence removal: %v", err)
	}
	status, err = registry.Status(root, token.id) // Same backend registry, new frontend owner.
	if err != nil || status.state != admissionTerminal {
		t.Fatalf("terminal tombstone did not survive owner replacement: %+v, %v", status, err)
	}
	if closed, err := registry.GateClosed(root); err != nil || closed {
		t.Fatalf("gate after reconciled close: closed=%v err=%v", closed, err)
	}

	next, err := registry.Reserve(root, "next-epoch", "settings", []byte("theme=dark"))
	if err != nil {
		t.Fatal(err)
	}
	if next.epoch <= token.epoch {
		t.Fatalf("epoch did not advance: first=%d next=%d", token.epoch, next.epoch)
	}
	if _, err := registry.Dispatch(token, payload, func() admissionOutcome {
		executions.Add(1)
		return admissionOutcome{}
	}); !errors.Is(err, errAdmissionMismatch) {
		t.Fatalf("old-epoch dispatch error = %v", err)
	}
	if err := registry.SealIfNotStarted(root, next.id); err != nil {
		t.Fatal(err)
	}
}

func TestAdmissionDoesNotCloseRecoveryRequiredOutcome(t *testing.T) {
	root := t.TempDir()
	registry := newAdmissionRegistry(func(string) error { return nil })
	token, err := registry.Reserve(root, "recovery", "replace", []byte("image=4"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Dispatch(token, []byte("image=4"), func() admissionOutcome {
		return admissionOutcome{recoveryRequired: true, errorMessage: "replacement journal pending"}
	}); err != nil {
		t.Fatal(err)
	}
	if err := registry.CloseAfterReconciliation(token, func(admissionOutcome) error { return nil }); !errors.Is(err, errAdmissionRecovery) {
		t.Fatalf("recovery-required close = %v", err)
	}
	if closed, err := registry.GateClosed(root); err != nil || !closed {
		t.Fatalf("recovery-required outcome opened gate: closed=%v err=%v", closed, err)
	}
}

func TestAdmissionUsesOperationLockRootIdentityAndRejectsUnresolvedAliases(t *testing.T) {
	root := t.TempDir()
	alias := filepath.Join(t.TempDir(), "repo-alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	registry := newAdmissionRegistry(func(string) error { return nil })
	token, err := registry.Reserve(root, "alias-op", "tag", []byte("asset=1"))
	if err != nil {
		t.Fatal(err)
	}
	status, err := registry.Status(alias, token.id)
	if err != nil || status.epoch != token.epoch {
		t.Fatalf("alias status = %+v, %v", status, err)
	}
	if _, err := registry.Reserve(alias, "other", "tag", nil); !errors.Is(err, errAdmissionBusy) {
		t.Fatalf("alias bypassed active root gate: %v", err)
	}
	if _, err := registry.Reserve(filepath.Join(root, "missing"), "unresolved", "tag", nil); err == nil {
		t.Fatal("admission accepted unresolved repository root")
	}
	if err := registry.SealIfNotStarted(alias, token.id); err != nil {
		t.Fatal(err)
	}
}

func TestProductionAdmissionFoundationIsDisabledWithoutDrainContract(t *testing.T) {
	if _, err := processAdmissionRegistry.Reserve(t.TempDir(), "disabled", "write", nil); !errors.Is(err, errAdmissionDrainUnavailable) {
		t.Fatalf("unconfigured process registry reserve = %v", err)
	}
}

func waitAdmissionState(t *testing.T, registry *admissionRegistry, root, id string, want admissionState) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, err := registry.Status(root, id)
		if err == nil && status.state == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	status, err := registry.Status(root, id)
	t.Fatalf("admission state = %+v, %v; want %q", status, err, want)
}

func statusRoot(t *testing.T, root string) string {
	t.Helper()
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}
