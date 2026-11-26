package service

import (
	"context"
	"errors"
	"sync"

	"loom/internal/store"
)

var errRenditionGateClosed = errors.New("rendition cache mutations are fenced")

// renditionGate is a process-local, per-canonical-root admission barrier.
// Ordinary requests hold a lease through all cache mutation and detached
// renderer cleanup. Cache-only observation does not acquire a lease.
type renditionGate struct {
	mu    sync.Mutex
	roots map[string]*renditionGateRoot
}

type renditionGateRoot struct {
	closed  bool
	active  int
	changed chan struct{}
	leases  map[*renditionGateLease]struct{}
}

type renditionGateLease struct {
	gate     *renditionGate
	root     string
	state    *renditionGateRoot
	mu       sync.Mutex
	released bool
	cancel   context.CancelFunc
}

func newRenditionGate() *renditionGate {
	return &renditionGate{roots: make(map[string]*renditionGateRoot)}
}

func (gate *renditionGate) Admit(root string) (*renditionGateLease, error) {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return nil, err
	}
	gate.mu.Lock()
	state := gate.rootLocked(canonical)
	if state.closed {
		gate.mu.Unlock()
		return nil, errRenditionGateClosed
	}
	lease := &renditionGateLease{gate: gate, root: canonical, state: state}
	state.active++
	state.leases[lease] = struct{}{}
	gate.mu.Unlock()
	return lease, nil
}

// CloseAndDrain atomically rejects new leases, cancels cooperative renderers,
// then waits for every admitted handler/renderer to finish. A timeout leaves
// the root closed. No caller mutex is held while waiting.
func (gate *renditionGate) CloseAndDrain(ctx context.Context, root string) error {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return err
	}
	gate.mu.Lock()
	state := gate.rootLocked(canonical)
	if !state.closed {
		state.closed = true
		state.changed = make(chan struct{})
	}
	drained := state.changed
	cancels := make([]context.CancelFunc, 0, len(state.leases))
	for lease := range state.leases {
		if cancel := lease.cancelFunc(); cancel != nil {
			cancels = append(cancels, cancel)
		}
	}
	if state.active == 0 {
		closeSignal(state.changed)
	}
	gate.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Reopen is a nonblocking state transition. Its caller must first establish
// that the admission registry has no active operation or independent fence.
func (gate *renditionGate) Reopen(root string) error {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return err
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	state := gate.rootLocked(canonical)
	if !state.closed || state.active != 0 {
		return errAdmissionBusy
	}
	state.closed = false
	state.changed = nil
	return nil
}

func (gate *renditionGate) rootLocked(root string) *renditionGateRoot {
	state := gate.roots[root]
	if state == nil {
		state = &renditionGateRoot{leases: make(map[*renditionGateLease]struct{})}
		gate.roots[root] = state
	}
	return state
}

func (lease *renditionGateLease) SetCancel(cancel context.CancelFunc) {
	lease.gate.mu.Lock()
	if !lease.released {
		lease.cancel = cancel
	}
	lease.gate.mu.Unlock()
}

func (lease *renditionGateLease) cancelFunc() context.CancelFunc {
	return lease.cancel
}

func (lease *renditionGateLease) Release() {
	if lease == nil {
		return
	}
	lease.gate.mu.Lock()
	if lease.released {
		lease.gate.mu.Unlock()
		return
	}
	lease.released = true
	lease.cancel = nil
	delete(lease.state.leases, lease)
	lease.state.active--
	if lease.state.closed && lease.state.active == 0 {
		closeSignal(lease.state.changed)
	}
	lease.gate.mu.Unlock()
}

func (lease *renditionGateLease) Transfer() func() {
	return lease.Release
}

func closeSignal(signal chan struct{}) {
	if signal == nil {
		return
	}
	select {
	case <-signal:
	default:
		close(signal)
	}
}
