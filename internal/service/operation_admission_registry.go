package service

func (registry *admissionRegistry) rootLocked(canonical string) *admissionRoot {
	entry := registry.roots[canonical]
	if entry == nil {
		entry = &admissionRoot{
			fences: make(map[string]struct{}), records: make(map[string]*admissionRecord),
		}
		registry.roots[canonical] = entry
	}
	return entry
}

func (registry *admissionRegistry) refreshGateLocked(entry *admissionRoot) {
	entry.gateClosed = entry.activeID != "" || len(entry.fences) != 0
}

// The callback is a nonblocking gate state change. Drain and reconciliation
// waits always happen with the registry mutex released.
func (registry *admissionRegistry) reopenIfUnfencedLocked(root string, entry *admissionRoot) error {
	if len(entry.fences) != 0 {
		entry.gateClosed = true
		return nil
	}
	if registry.reopen != nil {
		if err := registry.reopen(root); err != nil {
			entry.gateClosed = true
			return err
		}
	}
	entry.gateClosed = false
	return nil
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
