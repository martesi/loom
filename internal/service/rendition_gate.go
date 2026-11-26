package service

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"loom/internal/store"
)

var errRenditionGateClosed = errors.New("rendition cache mutations are fenced")
var errRenditionCleanup = errors.New("rendition cache cleanup failed")

var processRenditionGate = newRenditionGate()

// operationCoordinator is the single process-local authority for both
// admission records and rendition leases, keyed by canonical repository root.
type operationCoordinator struct {
	mu    sync.Mutex
	roots map[string]*admissionRoot
	seq   uint64
}

type coordinatorDrain struct {
	epoch       uint64
	writersDone chan struct{}
	done        chan struct{}
	complete    bool
	err         error
}

type renditionGate struct{ *operationCoordinator }

type closureOwnerToken struct {
	root string
	id   string
}

type renditionGateLease struct {
	gate      *renditionGate
	root      string
	state     *admissionRoot
	epoch     uint64
	released  bool
	cancel    context.CancelFunc
	operation *admissionRecord
}

func newOperationCoordinator() *operationCoordinator {
	return &operationCoordinator{roots: make(map[string]*admissionRoot)}
}

func newRenditionGate() *renditionGate {
	return &renditionGate{operationCoordinator: newOperationCoordinator()}
}

func (coordinator *operationCoordinator) rootLocked(root string) *admissionRoot {
	state := coordinator.roots[root]
	if state == nil {
		state = &admissionRoot{
			fences:          make(map[string]closureOwnerToken),
			owners:          make(map[string]struct{}),
			ownerTombstones: make(map[string]struct{}),
			records:         make(map[string]*admissionRecord),
			leases:          make(map[*renditionGateLease]struct{}),
		}
		coordinator.roots[root] = state
	}
	return state
}

func (coordinator *operationCoordinator) updateClosedLocked(state *admissionRoot) {
	state.gateClosed = len(state.owners) != 0 || state.drainHold || state.recoveryHold
}

func (coordinator *operationCoordinator) startDrainLocked(root string, state *admissionRoot) (*coordinatorDrain, []context.CancelFunc, bool, error) {
	if state.drain != nil && !state.drain.complete {
		return state.drain, nil, false, nil
	}
	if state.drain != nil && state.drain.complete && state.gateClosed {
		return state.drain, nil, false, nil
	}
	if state.drainEpoch == ^uint64(0) {
		return nil, nil, false, errAdmissionEpochExhausted
	}
	state.drainEpoch++
	drain := &coordinatorDrain{
		epoch: state.drainEpoch, writersDone: make(chan struct{}), done: make(chan struct{}), err: state.recoveryErr,
	}
	state.drain = drain
	state.drainHold = true
	coordinator.updateClosedLocked(state)
	cancels := make([]context.CancelFunc, 0, len(state.leases))
	for lease := range state.leases {
		if lease.cancel != nil {
			cancels = append(cancels, lease.cancel)
		}
	}
	if state.activeLeases == 0 {
		close(drain.writersDone)
	}
	return drain, cancels, true, nil
}

func (coordinator *operationCoordinator) launchDrain(root string, state *admissionRoot, drain *coordinatorDrain, cancels []context.CancelFunc, hook admissionDrain) {
	go func() {
		for _, cancel := range cancels {
			cancel()
		}
		<-drain.writersDone
		var drainErr error
		if hook != nil {
			drainErr = hook(root)
		}
		coordinator.mu.Lock()
		if coordinator.roots[root] == state && state.drain == drain && !drain.complete {
			if drainErr != nil && drain.err == nil {
				drain.err = drainErr
			}
			drain.complete = true
			if drain.err != nil {
				state.recoveryHold = true
			} else if len(state.owners) == 0 && !state.recoveryHold {
				state.drainHold = false
			}
			coordinator.updateClosedLocked(state)
			close(drain.done)
		}
		coordinator.mu.Unlock()
	}()
}

func (coordinator *operationCoordinator) installOwnerLocked(root string, state *admissionRoot, id string) (*coordinatorDrain, []context.CancelFunc, bool, error) {
	if id == "" {
		return nil, nil, false, errAdmissionInvalid
	}
	if _, used := state.ownerTombstones[id]; used {
		return nil, nil, false, errAdmissionDuplicate
	}
	state.ownerTombstones[id] = struct{}{}
	state.owners[id] = struct{}{}
	coordinator.updateClosedLocked(state)
	return coordinator.startDrainLocked(root, state)
}

func (coordinator *operationCoordinator) removeOwnerLocked(state *admissionRoot, id string) {
	delete(state.owners, id)
	if len(state.owners) == 0 {
		if state.drain != nil && !state.drain.complete {
			state.drainHold = true
		} else if state.drain != nil && state.drain.complete && state.drain.err == nil && !state.recoveryHold {
			state.drainHold = false
		}
	}
	coordinator.updateClosedLocked(state)
}

func (gate *renditionGate) Admit(root string) (*renditionGateLease, error) {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return nil, err
	}
	coordinator := gate.operationCoordinator
	coordinator.mu.Lock()
	state := coordinator.rootLocked(canonical)
	if state.gateClosed {
		coordinator.mu.Unlock()
		return nil, errRenditionGateClosed
	}
	lease := &renditionGateLease{gate: gate, root: canonical, state: state, epoch: state.drainEpoch}
	state.activeLeases++
	state.leases[lease] = struct{}{}
	coordinator.mu.Unlock()
	return lease, nil
}

// CloseAndDrain installs a unique temporary closure owner, then joins the
// actual writer drain. A caller timeout removes only its owner; the internal
// drain hold remains until the same epoch finishes.
func (gate *renditionGate) CloseAndDrain(ctx context.Context, root string) error {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return err
	}
	coordinator := gate.operationCoordinator
	coordinator.mu.Lock()
	state := coordinator.rootLocked(canonical)
	coordinator.seq++
	ownerID := fmt.Sprintf("drain:%d", coordinator.seq)
	drain, cancels, leader, err := coordinator.installOwnerLocked(canonical, state, ownerID)
	coordinator.mu.Unlock()
	if err != nil {
		return err
	}
	if leader {
		coordinator.launchDrain(canonical, state, drain, cancels, nil)
	}
	select {
	case <-drain.done:
		err = drain.err
	case <-ctx.Done():
		err = ctx.Err()
	}
	coordinator.mu.Lock()
	coordinator.removeOwnerLocked(state, ownerID)
	coordinator.mu.Unlock()
	return err
}

func (gate *renditionGate) Reopen(root string) error {
	canonical, err := store.CanonicalRepoOperationRoot(root)
	if err != nil {
		return err
	}
	coordinator := gate.operationCoordinator
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	state := coordinator.rootLocked(canonical)
	if state.activeLeases != 0 || len(state.owners) != 0 || state.recoveryHold || (state.drain != nil && !state.drain.complete) {
		return errAdmissionBusy
	}
	state.drainHold = false
	coordinator.updateClosedLocked(state)
	return nil
}

func (lease *renditionGateLease) SetCancel(cancel context.CancelFunc) {
	if lease == nil {
		return
	}
	coordinator := lease.gate.operationCoordinator
	coordinator.mu.Lock()
	cancelNow := false
	if !lease.released {
		lease.cancel = cancel
		cancelNow = lease.state.gateClosed && lease.operation == nil
	}
	coordinator.mu.Unlock()
	if cancelNow && cancel != nil {
		cancel()
	}
}

// Fork creates a separate worker reference before renderer work starts. If a
// closure won the race, the derived worker is still counted and cancelled.
func (lease *renditionGateLease) Fork(cancel context.CancelFunc) (*renditionGateLease, error) {
	if lease == nil || cancel == nil {
		return nil, errAdmissionInvalid
	}
	coordinator := lease.gate.operationCoordinator
	coordinator.mu.Lock()
	if lease.released {
		coordinator.mu.Unlock()
		return nil, errRenditionGateClosed
	}
	worker := &renditionGateLease{
		gate: lease.gate, root: lease.root, state: lease.state, epoch: lease.epoch,
		cancel: cancel, operation: lease.operation,
	}
	lease.state.activeLeases++
	lease.state.leases[worker] = struct{}{}
	if worker.operation != nil {
		worker.operation.ownedRefs++
	}
	closed := lease.state.gateClosed
	if worker.operation != nil {
		closed = false
	}
	coordinator.mu.Unlock()
	if closed {
		cancel()
	}
	return worker, nil
}

func (lease *renditionGateLease) Release() { lease.Finish(nil) }

func (lease *renditionGateLease) Finish(failure error) {
	if lease == nil {
		return
	}
	coordinator := lease.gate.operationCoordinator
	coordinator.mu.Lock()
	if lease.released {
		coordinator.mu.Unlock()
		return
	}
	lease.released = true
	lease.cancel = nil
	state := lease.state
	if failure != nil {
		state.recoveryHold = true
		if state.recoveryErr == nil {
			state.recoveryErr = fmt.Errorf("%w: %w", errRenditionCleanup, failure)
		}
		if state.drain != nil && state.drain.err == nil {
			state.drain.err = state.recoveryErr
		}
	}
	delete(state.leases, lease)
	state.activeLeases--
	if lease.operation != nil {
		lease.operation.ownedRefs--
		if lease.operation.dispatchReturned && lease.operation.ownedRefs == 0 {
			closeSignal(lease.operation.ownedDone)
		}
	}
	if state.activeLeases == 0 && state.drain != nil && !state.drain.complete {
		close(state.drain.writersDone)
	}
	if state.activeLeases == 0 && len(state.owners) == 0 && state.drain != nil && state.drain.complete && state.drain.err == nil && !state.recoveryHold {
		state.drainHold = false
	}
	coordinator.updateClosedLocked(state)
	coordinator.mu.Unlock()
}

func (lease *renditionGateLease) Transfer() func() { return lease.Release }

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
