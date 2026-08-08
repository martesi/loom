package service

import "testing"

// The application.Window interface (from the Wails v3 SDK) declares several
// unexported methods (shouldUnconditionallyClose, cut, copy, paste, ...),
// so it can only be implemented by types defined inside the wails/v3
// application package itself — there is no way to construct a fake/mock
// Window from this package, and no way to call application.Get().Window
// without a running application (app.Window.GetByID etc all dereference the
// live App). That rules out testing registerRepoWindow's OnWindowEvent
// wiring and focusedWindowForRepo's GetByID resolution here: both need a
// real Wails runtime, which is exercised manually / in the built app
// instead. What IS pure Go logic — the map's add/lookup/delete semantics,
// including the "don't clobber a newer registration" guard — is covered
// below by driving the package-level map and unregisterRepoWindow directly.

func resetRepoWindows(t *testing.T) {
	t.Helper()
	repoWindowsMu.Lock()
	saved := repoWindows
	repoWindows = map[string]uint{}
	repoWindowsMu.Unlock()

	t.Cleanup(func() {
		repoWindowsMu.Lock()
		repoWindows = saved
		repoWindowsMu.Unlock()
	})
}

func TestUnregisterRepoWindowRemovesMatchingEntry(t *testing.T) {
	resetRepoWindows(t)

	repoWindowsMu.Lock()
	repoWindows["/repo/a"] = 7
	repoWindowsMu.Unlock()

	unregisterRepoWindow("/repo/a", 7)

	repoWindowsMu.Lock()
	_, ok := repoWindows["/repo/a"]
	repoWindowsMu.Unlock()
	if ok {
		t.Fatal("expected entry to be removed")
	}
}

func TestUnregisterRepoWindowIgnoresMismatchedID(t *testing.T) {
	resetRepoWindows(t)

	// Simulate: window 7 had repo A open, closed (unregister queued with
	// id=7), but before that callback ran, a new window 9 opened the same
	// repo A and registered itself. The stale unregister(id=7) must not
	// clobber window 9's entry.
	repoWindowsMu.Lock()
	repoWindows["/repo/a"] = 9
	repoWindowsMu.Unlock()

	unregisterRepoWindow("/repo/a", 7)

	repoWindowsMu.Lock()
	got, ok := repoWindows["/repo/a"]
	repoWindowsMu.Unlock()
	if !ok || got != 9 {
		t.Fatalf("expected entry for window 9 to survive, got id=%d ok=%v", got, ok)
	}
}

func TestUnregisterRepoWindowMissingEntryIsNoop(t *testing.T) {
	resetRepoWindows(t)

	// No entry for this path at all — must not panic or create one.
	unregisterRepoWindow("/repo/nonexistent", 1)

	repoWindowsMu.Lock()
	_, ok := repoWindows["/repo/nonexistent"]
	repoWindowsMu.Unlock()
	if ok {
		t.Fatal("expected no entry to exist")
	}
}

func TestRegisterRepoWindowNilWindowIsNoop(t *testing.T) {
	resetRepoWindows(t)

	// registerRepoWindow must guard against a nil Window (e.g. Current()
	// returning nil when called outside of a window context) rather than
	// panicking on window.ID().
	registerRepoWindow("/repo/a", nil)

	repoWindowsMu.Lock()
	_, ok := repoWindows["/repo/a"]
	repoWindowsMu.Unlock()
	if ok {
		t.Fatal("expected no entry to be recorded for a nil window")
	}
}
