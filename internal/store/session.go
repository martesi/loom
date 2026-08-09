package store

import "sync"

// undoSessionBoundaries maps a repo's root path to the operation_log seq
// that existed in that repo the first time this process touched it. Every
// service call opens a fresh *Repo via Bootstrap, so there is no long-lived
// per-process Repo to hang this on — the map keyed by repo path is the only
// place to remember "where this process's session started" across those
// short-lived Repo instances.
var (
	undoSessionBoundariesMu sync.Mutex
	undoSessionBoundaries   = map[string]int64{}
)

// undoSessionBoundary returns the operation_log seq beyond which this
// process is allowed to undo/redo. It is computed once per repo path per
// process (the MAX(seq) present in operation_log the first time the repo is
// seen this run) and cached thereafter, so operations recorded in earlier
// app runs can never be undone or redone by this one. Both PeekUndo/PeekRedo
// and RecordOperation call this, since either one might be the first thing
// this process does with a given repo path — whichever runs first primes
// the cache from the log as it stood before any of this session's own
// mutations landed.
func (r *Repo) undoSessionBoundary() (int64, error) {
	undoSessionBoundariesMu.Lock()
	if boundary, ok := undoSessionBoundaries[r.Path]; ok {
		undoSessionBoundariesMu.Unlock()
		return boundary, nil
	}
	undoSessionBoundariesMu.Unlock()

	var boundary int64
	err := r.DB.QueryRow(`SELECT COALESCE(MAX(seq), 0) FROM operation_log`).Scan(&boundary)
	if err != nil {
		return 0, err
	}

	undoSessionBoundariesMu.Lock()
	// Another call may have raced us and already cached a value (e.g. a
	// concurrent RecordOperation and PeekUndo both finding nothing cached);
	// keep whichever was written first so both observe the same boundary.
	if existing, ok := undoSessionBoundaries[r.Path]; ok {
		boundary = existing
	} else {
		undoSessionBoundaries[r.Path] = boundary
	}
	undoSessionBoundariesMu.Unlock()

	return boundary, nil
}

// capUndoSessionBoundary lowers the cached session boundary for this repo to
// at most cursor, priming it first via undoSessionBoundary if this is the
// first time the path has been touched this process.
//
// Why this is needed: undoSessionBoundary's MAX(seq) can capture rows that
// are actually a stale redo tail — operations from a *previous* run that
// were undone (cursor moved back) but never truncated, because truncation
// only happens on the next RecordOperation, not on undo itself. If that
// next RecordOperation happens in a new process, seq numbers above the
// persisted cursor are about to be deleted (`DELETE FROM operation_log
// WHERE seq > cursor`) and reused for a brand-new, definitely-current-
// session operation. A boundary based on the pre-truncation MAX(seq) would
// then wrongly treat that brand-new operation's reused seq as pre-session
// history and block it from ever being undone. Once a truncation to `cursor`
// is about to happen, nothing above `cursor` can legitimately count toward
// the boundary anymore, so the cached value must never exceed it.
func (r *Repo) capUndoSessionBoundary(cursor int64) error {
	if _, err := r.undoSessionBoundary(); err != nil {
		return err
	}
	capUndoSessionBoundaryValue(r.Path, cursor)
	return nil
}

func capUndoSessionBoundaryValue(path string, cursor int64) {
	undoSessionBoundariesMu.Lock()
	if boundary, ok := undoSessionBoundaries[path]; ok && boundary > cursor {
		undoSessionBoundaries[path] = cursor
	}
	undoSessionBoundariesMu.Unlock()
}
