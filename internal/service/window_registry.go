package service

import (
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// repoWindows tracks which window (by Wails window ID) currently has a
// given repo open, across every top-level window in the process. A window's
// Name is fixed at creation and can't be renamed later, so it can't be used
// to identify "the window currently showing repo X" — hence this explicit
// registry, keyed by repo path instead.
var (
	repoWindowsMu sync.Mutex
	repoWindows   = map[string]uint{}
)

// registerRepoWindow records that repoPath is now open in window, and
// arranges for the mapping to be removed automatically when that window
// closes.
func registerRepoWindow(repoPath string, window application.Window) {
	if window == nil {
		return
	}
	id := window.ID()

	repoWindowsMu.Lock()
	repoWindows[repoPath] = id
	repoWindowsMu.Unlock()

	window.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		unregisterRepoWindow(repoPath, id)
	})
}

// unregisterRepoWindow removes the repoPath -> id mapping, but only if it
// still points at id. This guards against a closing window clobbering a
// newer registration for the same path made by a different window (e.g. if
// repoPath was reopened elsewhere between this window's close being
// initiated and its WindowClosing callback firing).
func unregisterRepoWindow(repoPath string, id uint) {
	repoWindowsMu.Lock()
	defer repoWindowsMu.Unlock()
	if current, ok := repoWindows[repoPath]; ok && current == id {
		delete(repoWindows, repoPath)
	}
}

// focusedWindowForRepo returns the live window currently showing repoPath,
// if any. If the registry has a stale entry — the window closed without
// (or before) its WindowClosing callback clearing the map, which can happen
// during abrupt app teardown — the stale entry is cleaned up here too.
func focusedWindowForRepo(repoPath string) (application.Window, bool) {
	repoWindowsMu.Lock()
	id, ok := repoWindows[repoPath]
	repoWindowsMu.Unlock()
	if !ok {
		return nil, false
	}

	window, found := application.Get().Window.GetByID(id)
	if !found {
		unregisterRepoWindow(repoPath, id)
		return nil, false
	}
	return window, true
}
