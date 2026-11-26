package service

import "loom/internal/store"

func (registry *admissionRegistry) rootLocked(canonical string) *admissionRoot {
	return registry.operationCoordinator.rootLocked(canonical)
}

func (registry *admissionRegistry) refreshGateLocked(entry *admissionRoot) {
	registry.operationCoordinator.updateClosedLocked(entry)
}

// The callback is a nonblocking gate state change. Drain and reconciliation
// waits always happen with the registry mutex released.
func (registry *admissionRegistry) reopenIfUnfencedLocked(root string, entry *admissionRoot) error {
	_ = root
	if len(entry.owners) != 0 || entry.recoveryHold || entry.activeLeases != 0 || entry.drain != nil && !entry.drain.complete {
		registry.operationCoordinator.updateClosedLocked(entry)
		return errAdmissionBusy
	}
	entry.drainHold = false
	registry.operationCoordinator.updateClosedLocked(entry)
	return nil
}

func (registry *admissionRegistry) ValidateToken(token admissionToken) error {
	canonical, err := store.CanonicalRepoOperationRoot(token.root)
	if err != nil || canonical != token.root {
		return errAdmissionInvalid
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	entry := registry.roots[canonical]
	if entry == nil {
		return errAdmissionNotFound
	}
	record := entry.records[token.id]
	if record == nil {
		return errAdmissionNotFound
	}
	if token.epoch != entry.epoch || !sameAdmissionToken(record.token, token) {
		return errAdmissionMismatch
	}
	return nil
}

// AdmitOperation grants a cache-writer reference to the currently claimed
// operation. It is the only path that may create derived writer refs while
// the root is closed. Dispatch waits for every such reference to finish.
func (registry *admissionRegistry) AdmitOperation(token admissionToken) (*renditionGateLease, error) {
	canonical, err := store.CanonicalRepoOperationRoot(token.root)
	if err != nil || canonical != token.root {
		return nil, errAdmissionInvalid
	}
	registry.mu.Lock()
	entry := registry.roots[canonical]
	record := (*admissionRecord)(nil)
	if entry != nil {
		record = entry.records[token.id]
	}
	if record == nil || !sameAdmissionToken(record.token, token) || record.state != admissionRunning || record.dispatchReturned || entry.activeID != token.id {
		registry.mu.Unlock()
		return nil, errAdmissionNotReady
	}
	if _, owns := entry.owners[record.ownerID]; !owns {
		registry.mu.Unlock()
		return nil, errAdmissionInvalid
	}
	lease := &renditionGateLease{
		gate: &renditionGate{operationCoordinator: registry.operationCoordinator},
		root: canonical, state: entry, epoch: entry.drainEpoch, operation: record,
	}
	entry.activeLeases++
	entry.leases[lease] = struct{}{}
	record.ownedRefs++
	registry.mu.Unlock()
	return lease, nil
}

func sameAdmissionToken(left, right admissionToken) bool {
	return left.root == right.root && left.id == right.id && left.epoch == right.epoch &&
		left.kind == right.kind && left.digest == right.digest
}

func cloneAdmissionOutcome(outcome admissionOutcome) admissionOutcome {
	outcome.result = append([]byte(nil), outcome.result...)
	outcome.partialResults = append([]string(nil), outcome.partialResults...)
	return outcome
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func closedAdmissionSignal() chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}
