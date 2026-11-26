package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"

	"loom/internal/store"
)

// This registry is a process-owned foundation only. It is deliberately not
// wired to Wails or HTTP handlers until every mutating entry point carries an
// admission token. A missing drain contract fails closed.
var processAdmissionRegistry = newAdmissionRegistry(nil)

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
	mu     sync.Mutex
	roots  map[string]*admissionRoot
	drain  admissionDrain
	reopen func(canonicalRoot string) error
}

type admissionRoot struct {
	epoch      uint64
	activeID   string
	gateClosed bool
	fences     map[string]struct{}
	records    map[string]*admissionRecord // Tombstones are retained for process lifetime.
}

type admissionRecord struct {
	token      admissionToken
	state      admissionState
	drainDone  chan struct{}
	drained    bool
	drainErr   error
	closing    bool
	outcome    admissionOutcome
	reconciled bool
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
	return &admissionRegistry{roots: make(map[string]*admissionRoot), drain: drain}
}

func newAdmissionRegistryWithRenditionGate(gate *renditionGate) *admissionRegistry {
	return &admissionRegistry{
		roots:  make(map[string]*admissionRoot),
		drain:  func(root string) error { return gate.CloseAndDrain(context.Background(), root) },
		reopen: gate.Reopen,
	}
}

// Reserve closes the configured rendition gate before draining prior work and
// returns a dispatch token only after the drain succeeds. Production handlers
// still use the compatibility path until Wails mutation conversion is complete.
// The drain runs without the registry mutex; a drain error leaves the gate shut.
func (registry *admissionRegistry) Reserve(root, id, kind string, payload []byte) (admissionToken, error) {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return admissionToken{}, err
	}
	if id == "" || kind == "" || registry.drain == nil {
		if registry.drain == nil {
			return admissionToken{}, errAdmissionDrainUnavailable
		}
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
	token := admissionToken{
		root: canonical, id: id, epoch: entry.epoch, kind: kind,
		digest: sha256.Sum256(payload),
	}
	record := &admissionRecord{
		token: token, state: admissionDraining, drainDone: make(chan struct{}),
	}
	entry.records[id] = record
	entry.activeID = id
	entry.gateClosed = true
	registry.mu.Unlock()

	drainErr := registry.drain(canonical)
	registry.mu.Lock()
	entry = registry.roots[canonical]
	if drainErr != nil {
		record.state = admissionSealed
		record.drainErr = drainErr
		record.drained = false
		close(record.drainDone)
		registry.mu.Unlock()
		return admissionToken{}, fmt.Errorf("drain rendition work: %w", drainErr)
	}
	record.drained = true
	if record.state == admissionSealed {
		if entry.activeID == id {
			if err := registry.reopenIfUnfencedLocked(canonical, entry); err != nil {
				registry.mu.Unlock()
				close(record.drainDone)
				return admissionToken{}, err
			}
			entry.activeID = ""
		}
		close(record.drainDone)
		registry.mu.Unlock()
		return admissionToken{}, errAdmissionSealed
	}
	record.state = admissionReserved
	close(record.drainDone)
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
	if registry.drain == nil {
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
		case admissionSealed:
			if record.drained {
				if entry.activeID == id {
					if err := registry.reopenIfUnfencedLocked(canonical, entry); err != nil {
						registry.mu.Unlock()
						return err
					}
					entry.activeID = ""
				}
				registry.mu.Unlock()
				return nil
			}
			if record.drainDone == nil {
				registry.mu.Unlock()
				return errAdmissionDrainUnavailable
			}
			done := record.drainDone
			registry.mu.Unlock()
			<-done
			return record.drainErr
		case admissionDraining:
			record.state = admissionSealed
			done := record.drainDone
			registry.mu.Unlock()
			<-done
			return record.drainErr
		case admissionReserved:
			record.state = admissionSealed
			record.drained = true
			if entry.activeID == id {
				if err := registry.reopenIfUnfencedLocked(canonical, entry); err != nil {
					registry.mu.Unlock()
					return err
				}
				entry.activeID = ""
			}
			registry.mu.Unlock()
			return nil
		}
	}

	// Tombstone before waiting. If another operation already owns the closed
	// root gate, its drain also protects this not-started ID from cache writers.
	record = &admissionRecord{
		token: admissionToken{root: canonical, id: id, epoch: entry.epoch},
		state: admissionSealed, drained: true, drainDone: closedAdmissionSignal(),
	}
	entry.records[id] = record
	if entry.activeID != "" || entry.gateClosed {
		registry.mu.Unlock()
		return nil
	}
	entry.activeID = id
	entry.gateClosed = true
	record.drained = false
	record.drainDone = make(chan struct{})
	registry.mu.Unlock()

	drainErr := registry.drain(canonical)
	registry.mu.Lock()
	entry = registry.roots[canonical]
	record.drainErr = drainErr
	record.drained = drainErr == nil
	close(record.drainDone)
	if drainErr == nil && entry.activeID == id {
		drainErr = registry.reopenIfUnfencedLocked(canonical, entry)
		record.drainErr = drainErr
		if drainErr == nil {
			entry.activeID = ""
		}
	}
	registry.mu.Unlock()
	if drainErr != nil {
		return fmt.Errorf("drain rendition work while sealing: %w", drainErr)
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
	if len(entry.fences) != 0 {
		registry.mu.Unlock()
		return errAdmissionOtherFence
	}
	if registry.reopen != nil {
		if err := registry.reopen(canonical); err != nil {
			registry.mu.Unlock()
			return err
		}
	}
	entry.activeID = ""
	entry.gateClosed = false
	record.reconciled = true
	registry.mu.Unlock()
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
	registry.mu.Lock()
	entry := registry.rootLocked(canonical)
	if closed {
		entry.fences[name] = struct{}{}
		entry.gateClosed = true
		if registry.reopen != nil {
			// Fence installation must be backed by the same real drain as an
			// admission reservation. Drop the registry lock before waiting.
			registry.mu.Unlock()
			return registry.drain(canonical)
		}
	} else {
		delete(entry.fences, name)
		if entry.activeID == "" {
			if err := registry.reopenIfUnfencedLocked(canonical, entry); err != nil {
				registry.mu.Unlock()
				return err
			}
		} else {
			registry.refreshGateLocked(entry)
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
