package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"

	"loom/internal/store"
)

// This registry is a process-owned foundation only. It is deliberately not
// wired to Wails or HTTP handlers until every mutating entry point carries an
// admission token. A missing drain contract fails closed.
var processAdmissionRegistry = &admissionRegistry{operationCoordinator: processRenditionGate.operationCoordinator}

var (
	errAdmissionDrainUnavailable = errors.New("operation admission drain is unavailable")
	errAdmissionBusy             = errors.New("repository already has an admitted operation or fence")
	errAdmissionDuplicate        = errors.New("operation ID is already reserved or tombstoned")
	errAdmissionInvalid          = errors.New("operation admission binding is invalid")
	errAdmissionMismatch         = errors.New("operation admission binding does not match reservation")
	errAdmissionNotReady         = errors.New("operation admission is not ready to dispatch")
	errAdmissionSealed           = errors.New("operation admission is sealed")
	errAdmissionStarted          = errors.New("operation has already started")
	errAdmissionNotTerminal      = errors.New("operation is not terminal")
	errAdmissionRecovery         = errors.New("operation requires recovery and remains fenced")
	errAdmissionOtherFence       = errors.New("repository has another active fence")
	errAdmissionNotFound         = errors.New("operation admission was not found")
	errAdmissionEpochExhausted   = errors.New("repository admission epoch is exhausted")
)

type admissionState string

const (
	admissionDraining admissionState = "draining"
	admissionReserved admissionState = "reserved"
	admissionRunning  admissionState = "running"
	admissionTerminal admissionState = "terminal"
	admissionSealed   admissionState = "sealed"
)

// admissionToken binds the backend dispatch claim to the reservation that
// completed its drain. The root is already canonicalized.
type admissionToken struct {
	root   string
	id     string
	epoch  uint64
	kind   string
	digest [sha256.Size]byte
}

// admissionOutcome retains partial and recovery diagnostics even when a
// method returns an error. Terminal means the owned work function returned;
// it does not mean the operation succeeded or was reconciled.
type admissionOutcome struct {
	result           []byte
	errorMessage     string
	partialResults   []string
	recoveryRequired bool
}

type admissionDrain func(canonicalRoot string) error

type admissionRegistry struct {
	*operationCoordinator
	drain          admissionDrain
	drainAvailable bool
}

type admissionRoot struct {
	epoch           uint64
	activeID        string
	gateClosed      bool
	fences          map[string]closureOwnerToken
	owners          map[string]struct{}
	ownerTombstones map[string]struct{}
	records         map[string]*admissionRecord // Tombstones are retained for process lifetime.
	leases          map[*renditionGateLease]struct{}
	activeLeases    int
	drainEpoch      uint64
	drain           *coordinatorDrain
	drainHold       bool
	recoveryHold    bool
	recoveryErr     error
}

type admissionRecord struct {
	token            admissionToken
	state            admissionState
	drainDone        chan struct{}
	drained          bool
	drainErr         error
	closing          bool
	outcome          admissionOutcome
	reconciled       bool
	drainEpoch       uint64
	ownerID          string
	ownedRefs        int
	dispatchReturned bool
	ownedDone        chan struct{}
}

type admissionStatus struct {
	state            admissionState
	epoch            uint64
	kind             string
	digest           [sha256.Size]byte
	outcome          admissionOutcome
	recoveryRequired bool
	drained          bool
	drainError       string
}

func newAdmissionRegistry(drain admissionDrain) *admissionRegistry {
	return &admissionRegistry{operationCoordinator: newOperationCoordinator(), drain: drain, drainAvailable: drain != nil}
}

func newAdmissionRegistryWithRenditionGate(gate *renditionGate) *admissionRegistry {
	return &admissionRegistry{operationCoordinator: gate.operationCoordinator, drainAvailable: true}
}

// Reserve installs its operation owner and closes admission atomically with
// starting or joining the root's drain epoch. Drain work runs without the
// coordinator mutex and the internal hold survives a caller timeout.
func (registry *admissionRegistry) Reserve(root, id, kind string, payload []byte) (admissionToken, error) {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return admissionToken{}, err
	}
	if !registry.drainAvailable {
		return admissionToken{}, errAdmissionDrainUnavailable
	}
	if id == "" || kind == "" {
		return admissionToken{}, errAdmissionInvalid
	}

	registry.mu.Lock()
	entry := registry.rootLocked(canonical)
	if _, exists := entry.records[id]; exists {
		registry.mu.Unlock()
		return admissionToken{}, errAdmissionDuplicate
	}
	if entry.gateClosed || entry.activeID != "" {
		registry.mu.Unlock()
		return admissionToken{}, errAdmissionBusy
	}
	if entry.epoch == ^uint64(0) {
		registry.mu.Unlock()
		return admissionToken{}, errAdmissionEpochExhausted
	}
	entry.epoch++
	ownerID := "operation:" + id
	token := admissionToken{
		root: canonical, id: id, epoch: entry.epoch, kind: kind,
		digest: sha256.Sum256(payload),
	}
	record := &admissionRecord{
		token: token, state: admissionDraining, ownerID: ownerID,
	}
	entry.records[id] = record
	entry.activeID = id
	drain, cancels, leader, err := registry.installOwnerLocked(canonical, entry, ownerID)
	if err != nil {
		delete(entry.records, id)
		entry.activeID = ""
		registry.mu.Unlock()
		return admissionToken{}, err
	}
	record.drainEpoch = drain.epoch
	record.drainDone = drain.done
	registry.mu.Unlock()
	if leader {
		registry.launchDrain(canonical, entry, drain, cancels, registry.drain)
	}
	<-drain.done
	drainErr := drain.err
	registry.mu.Lock()
	entry = registry.roots[canonical]
	record.drained = drainErr == nil
	record.drainErr = drainErr
	if drainErr != nil {
		record.state = admissionSealed
		registry.mu.Unlock()
		return admissionToken{}, fmt.Errorf("drain rendition work: %w", drainErr)
	}
	if record.state == admissionSealed {
		registry.removeOwnerLocked(entry, ownerID)
		if entry.activeID == id {
			entry.activeID = ""
		}
		registry.mu.Unlock()
		return admissionToken{}, errAdmissionSealed
	}
	record.state = admissionReserved
	registry.mu.Unlock()
	return token, nil
}

// Dispatch atomically claims a matching ready reservation before it calls
// work. The work callback owns and must join every mutating task it starts.
// The registry records terminal outcome only after that callback returns.
func (registry *admissionRegistry) Dispatch(
	token admissionToken,
	payload []byte,
	work func() admissionOutcome,
) (admissionOutcome, error) {
	canonical, err := store.CanonicalRepoOperationRoot(token.root)
	if err != nil || canonical != token.root || token.id == "" || token.kind == "" || work == nil {
		return admissionOutcome{}, errAdmissionInvalid
	}
	if sha256.Sum256(payload) != token.digest {
		return admissionOutcome{}, errAdmissionMismatch
	}
	registry.mu.Lock()
	entry := registry.roots[canonical]
	if entry == nil {
		registry.mu.Unlock()
		return admissionOutcome{}, errAdmissionNotFound
	}
	record := entry.records[token.id]
	if record == nil {
		registry.mu.Unlock()
		return admissionOutcome{}, errAdmissionNotFound
	}
	if token.epoch != entry.epoch {
		registry.mu.Unlock()
		return admissionOutcome{}, errAdmissionMismatch
	}
	if !sameAdmissionToken(record.token, token) {
		registry.mu.Unlock()
		return admissionOutcome{}, errAdmissionMismatch
	}
	if record.state == admissionSealed {
		registry.mu.Unlock()
		return admissionOutcome{}, errAdmissionSealed
	}
	if record.state != admissionReserved || entry.activeID != token.id || !entry.gateClosed {
		registry.mu.Unlock()
		return admissionOutcome{}, errAdmissionNotReady
	}
	record.state = admissionRunning
	registry.mu.Unlock()

	outcome := cloneAdmissionOutcome(work())
	registry.mu.Lock()
	entry = registry.roots[canonical]
	if entry == nil || entry.records[token.id] != record || record.state != admissionRunning {
		registry.mu.Unlock()
		return admissionOutcome{}, errAdmissionInvalid
	}
	if record.ownedRefs != 0 {
		record.dispatchReturned = true
		record.ownedDone = make(chan struct{})
		ownedDone := record.ownedDone
		registry.mu.Unlock()
		<-ownedDone
		registry.mu.Lock()
		entry = registry.roots[canonical]
		if entry == nil || entry.records[token.id] != record || record.state != admissionRunning {
			registry.mu.Unlock()
			return admissionOutcome{}, errAdmissionInvalid
		}
	}
	record.outcome = outcome
	record.state = admissionTerminal
	registry.mu.Unlock()
	return cloneAdmissionOutcome(outcome), nil
}

// SealIfNotStarted tombstones an ID so a delayed reserve or dispatch cannot
// execute it. If reserve is draining, it seals first and waits outside the
// registry mutex for that drain to finish. A failed drain leaves the root
// closed. A running or terminal operation cannot be represented as unstarted.
func (registry *admissionRegistry) SealIfNotStarted(root, id string) error {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return err
	}
	if id == "" {
		return errAdmissionInvalid
	}
	if !registry.drainAvailable {
		return errAdmissionDrainUnavailable
	}

	registry.mu.Lock()
	entry := registry.rootLocked(canonical)
	record := entry.records[id]
	if record != nil {
		switch record.state {
		case admissionRunning, admissionTerminal:
			registry.mu.Unlock()
			return errAdmissionStarted
		case admissionDraining:
			record.state = admissionSealed
		case admissionReserved, admissionSealed:
			record.state = admissionSealed
			if record.drained {
				registry.removeOwnerLocked(entry, record.ownerID)
				if entry.activeID == id {
					entry.activeID = ""
				}
				registry.mu.Unlock()
				return record.drainErr
			}
		}
	}
	if record == nil {
		ownerID := "seal:" + id
		record = &admissionRecord{
			token: admissionToken{root: canonical, id: id, epoch: entry.epoch},
			state: admissionSealed, ownerID: ownerID,
		}
		entry.records[id] = record
		drain, cancels, leader, installErr := registry.installOwnerLocked(canonical, entry, ownerID)
		if installErr != nil {
			registry.mu.Unlock()
			return installErr
		}
		record.drainEpoch = drain.epoch
		record.drainDone = drain.done
		registry.mu.Unlock()
		if leader {
			registry.launchDrain(canonical, entry, drain, cancels, registry.drain)
		}
		<-drain.done
		registry.mu.Lock()
		record.drained = drain.err == nil
		record.drainErr = drain.err
		registry.removeOwnerLocked(entry, ownerID)
		registry.mu.Unlock()
		if drain.err != nil {
			return fmt.Errorf("drain rendition work while sealing: %w", drain.err)
		}
		return nil
	}

	drain := entry.drain
	if drain == nil || record.drainEpoch != drain.epoch {
		registry.mu.Unlock()
		return errAdmissionDrainUnavailable
	}
	done := drain.done
	registry.mu.Unlock()
	<-done
	registry.mu.Lock()
	record.drained = drain.err == nil
	record.drainErr = drain.err
	registry.removeOwnerLocked(entry, record.ownerID)
	if entry.activeID == id {
		entry.activeID = ""
	}
	registry.mu.Unlock()
	if drain.err != nil {
		return fmt.Errorf("drain rendition work while sealing: %w", drain.err)
	}
	return nil
}

// CloseAfterReconciliation clears the operation gate only for a terminal,
// non-recovery outcome after the supplied reconciliation succeeds. It keeps
// the terminal record as a process-lifetime tombstone for status and replay
// rejection. Reconciliation runs without the registry mutex.
func (registry *admissionRegistry) CloseAfterReconciliation(
	token admissionToken,
	reconcile func(admissionOutcome) error,
) error {
	canonical, err := store.CanonicalRepoOperationRoot(token.root)
	if err != nil || canonical != token.root || reconcile == nil {
		return errAdmissionInvalid
	}
	registry.mu.Lock()
	entry := registry.roots[canonical]
	if entry == nil || entry.records[token.id] == nil {
		registry.mu.Unlock()
		return errAdmissionNotFound
	}
	record := entry.records[token.id]
	if !sameAdmissionToken(record.token, token) {
		registry.mu.Unlock()
		return errAdmissionMismatch
	}
	if record.reconciled {
		registry.mu.Unlock()
		return nil
	}
	if record.state != admissionTerminal || entry.activeID != token.id {
		registry.mu.Unlock()
		return errAdmissionNotTerminal
	}
	if record.outcome.recoveryRequired {
		registry.mu.Unlock()
		return errAdmissionRecovery
	}
	if record.closing {
		registry.mu.Unlock()
		return errAdmissionBusy
	}
	record.closing = true
	outcome := cloneAdmissionOutcome(record.outcome)
	registry.mu.Unlock()

	reconcileErr := reconcile(outcome)
	registry.mu.Lock()
	entry = registry.roots[canonical]
	record.closing = false
	if reconcileErr != nil {
		registry.mu.Unlock()
		return reconcileErr
	}
	if entry.records[token.id] != record || record.state != admissionTerminal || entry.activeID != token.id {
		registry.mu.Unlock()
		return errAdmissionInvalid
	}
	registry.removeOwnerLocked(entry, record.ownerID)
	entry.activeID = ""
	record.reconciled = true
	otherOwners := len(entry.owners) != 0 || entry.drainHold || entry.recoveryHold
	registry.mu.Unlock()
	if otherOwners {
		return errAdmissionOtherFence
	}
	return nil
}

// SetIndependentFence models an additional repository fence. Terminal close
// cannot reopen the gate while any such fence remains. It is private and is
// not connected to production services in this foundation stage.
func (registry *admissionRegistry) SetIndependentFence(root, name string, closed bool) error {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return err
	}
	if name == "" {
		return errAdmissionInvalid
	}
	if closed {
		token, err := registry.AcquireFence(canonical, name)
		if err != nil {
			return err
		}
		return registry.AwaitFence(context.Background(), token)
	}
	registry.mu.Lock()
	entry := registry.rootLocked(canonical)
	token, ok := entry.fences[name]
	registry.mu.Unlock()
	if !ok {
		return nil
	}
	return registry.ReleaseFence(token)
}

func (registry *admissionRegistry) AcquireFence(root, id string) (closureOwnerToken, error) {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return closureOwnerToken{}, err
	}
	if !registry.drainAvailable {
		return closureOwnerToken{}, errAdmissionDrainUnavailable
	}
	ownerID := "fence:" + id
	registry.mu.Lock()
	entry := registry.rootLocked(canonical)
	if _, exists := entry.owners[ownerID]; exists {
		registry.mu.Unlock()
		return closureOwnerToken{}, errAdmissionDuplicate
	}
	drain, cancels, leader, err := registry.installOwnerLocked(canonical, entry, ownerID)
	if err != nil {
		registry.mu.Unlock()
		return closureOwnerToken{}, err
	}
	token := closureOwnerToken{root: canonical, id: ownerID}
	entry.fences[id] = token
	registry.mu.Unlock()
	if leader {
		registry.launchDrain(canonical, entry, drain, cancels, registry.drain)
	}
	return token, nil
}

func (registry *admissionRegistry) AwaitFence(ctx context.Context, token closureOwnerToken) error {
	registry.mu.Lock()
	entry := registry.roots[token.root]
	if entry == nil || entry.drain == nil {
		registry.mu.Unlock()
		return errAdmissionNotFound
	}
	if _, owned := entry.owners[token.id]; !owned {
		registry.mu.Unlock()
		return errAdmissionNotFound
	}
	drain := entry.drain
	registry.mu.Unlock()
	select {
	case <-drain.done:
		return drain.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (registry *admissionRegistry) ReleaseFence(token closureOwnerToken) error {
	canonical, err := store.CanonicalRepoOperationRoot(token.root)
	if err != nil || canonical != token.root || token.id == "" {
		return errAdmissionInvalid
	}
	registry.mu.Lock()
	entry := registry.roots[canonical]
	if entry == nil {
		registry.mu.Unlock()
		return errAdmissionNotFound
	}
	if _, owned := entry.owners[token.id]; !owned {
		registry.mu.Unlock()
		return errAdmissionNotFound
	}
	registry.removeOwnerLocked(entry, token.id)
	for name, current := range entry.fences {
		if current == token {
			delete(entry.fences, name)
		}
	}
	registry.mu.Unlock()
	return nil
}

// Status is inspection only. It never opens a gate or changes a record.
func (registry *admissionRegistry) Status(root, id string) (admissionStatus, error) {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return admissionStatus{}, err
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	entry := registry.roots[canonical]
	if entry == nil || entry.records[id] == nil {
		return admissionStatus{}, errAdmissionNotFound
	}
	record := entry.records[id]
	return admissionStatus{
		state: record.state, epoch: record.token.epoch, kind: record.token.kind,
		digest: record.token.digest, outcome: cloneAdmissionOutcome(record.outcome),
		recoveryRequired: record.outcome.recoveryRequired, drained: record.drained,
		drainError: errorText(record.drainErr),
	}, nil
}

func (registry *admissionRegistry) GateClosed(root string) (bool, error) {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return false, err
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	entry := registry.roots[canonical]
	return entry != nil && entry.gateClosed, nil
}
