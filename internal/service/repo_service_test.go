package service

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/repoconfig"
)

type fakeFocusWindow struct{ calls int }

func (w *fakeFocusWindow) Focus() { w.calls++ }

func setRepoServiceAdapters(t *testing.T, find func(string) (focusableWindow, bool), register func(string), create func(application.WebviewWindowOptions)) {
	t.Helper()
	oldFind, oldRegister, oldCreate := focusedWindowForRepo, registerCurrentRepoWindow, newRepoWindow
	focusedWindowForRepo, registerCurrentRepoWindow, newRepoWindow = find, register, create
	t.Cleanup(func() {
		focusedWindowForRepo, registerCurrentRepoWindow, newRepoWindow = oldFind, oldRegister, oldCreate
	})
}

func isolateRepoConfig(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
}

func TestOpenRecentExistingWindowFocusesAndReturnsIDPathOnly(t *testing.T) {
	window := &fakeFocusWindow{}
	setRepoServiceAdapters(t, func(string) (focusableWindow, bool) { return window, true }, nil, nil)
	got, err := (&RepoService{}).OpenRecent("/repo")
	if err != nil {
		t.Fatal(err)
	}
	if window.calls != 1 {
		t.Fatalf("Focus calls = %d, want 1", window.calls)
	}
	if got == nil || !got.OpenedElsewhere || got.ID != "/repo" || got.Path != "/repo" || got.Name != "" {
		t.Fatalf("OpenRecent() = %#v; want ID/path only", got)
	}
}

func TestOpenRecentAbsentWindowBootstrapsTouchesAndRegisters(t *testing.T) {
	isolateRepoConfig(t)
	path := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	registered := ""
	setRepoServiceAdapters(t, func(string) (focusableWindow, bool) { return nil, false }, func(path string) { registered = path }, nil)
	got, err := (&RepoService{}).OpenRecent(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "repo" || got.OpenedElsewhere {
		t.Fatalf("OpenRecent() = %#v", got)
	}
	if registered != path {
		t.Fatalf("registered %q, want %q", registered, path)
	}
	cfg, err := repoconfig.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Recent) != 1 || cfg.Recent[0].Path != path {
		t.Fatalf("recent = %#v", cfg.Recent)
	}
}

func TestSwitchToExistingWindowFocuses(t *testing.T) {
	window := &fakeFocusWindow{}
	created := false
	setRepoServiceAdapters(t, func(string) (focusableWindow, bool) { return window, true }, nil, func(application.WebviewWindowOptions) { created = true })
	got, err := (&RepoService{}).SwitchTo("/repo")
	if err != nil {
		t.Fatal(err)
	}
	if window.calls != 1 || created {
		t.Fatalf("focus calls=%d, created=%v", window.calls, created)
	}
	if got == nil || !got.OpenedElsewhere || got.Name != "" {
		t.Fatalf("SwitchTo() = %#v", got)
	}
}

func TestSwitchToNewWindowRegistersOnlyWhenOpenRecentRuns(t *testing.T) {
	isolateRepoConfig(t)
	path := filepath.Join(t.TempDir(), "destination")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	registered := false
	window := &fakeFocusWindow{}
	findCalls := 0
	setRepoServiceAdapters(t, func(candidate string) (focusableWindow, bool) {
		findCalls++
		if candidate == path && registered {
			return window, true
		}
		return nil, false
	}, func(candidate string) {
		if candidate != path {
			t.Fatalf("registered %q, want %q", candidate, path)
		}
		registered = true
	}, func(application.WebviewWindowOptions) {
		if registered {
			t.Fatal("SwitchTo registered destination before new window OpenRecent")
		}
	})
	got, err := (&RepoService{}).SwitchTo(path)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || !got.OpenedElsewhere || registered || findCalls != 1 {
		t.Fatalf("SwitchTo=%#v registered=%v find calls=%d", got, registered, findCalls)
	}
	got, err = (&RepoService{}).OpenRecent(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "destination" || got.ImageCount != 0 || got.OpenedElsewhere || !registered || findCalls != 2 || window.calls != 0 {
		t.Fatalf("OpenRecent() = %#v registered=%v find calls=%d self-focus calls=%d", got, registered, findCalls, window.calls)
	}
}

func TestListRecentReposMapsOpenClosedAndMissingEntries(t *testing.T) {
	isolateRepoConfig(t)
	root := t.TempDir()
	openPath, closedPath, missingPath := filepath.Join(root, "open"), filepath.Join(root, "closed"), filepath.Join(root, "missing")
	setRepoServiceAdapters(t, func(string) (focusableWindow, bool) { return nil, false }, func(string) {}, nil)
	for _, path := range []string{openPath, closedPath} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := (&RepoService{}).OpenRecent(path); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := repoconfig.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Recent = []repoconfig.RecentRepo{{Path: openPath}, {Path: closedPath}, {Path: missingPath}}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	setRepoServiceAdapters(t, func(path string) (focusableWindow, bool) { return nil, path == openPath }, nil, nil)
	got, err := (&RepoService{}).ListRecentRepos()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Path != openPath || !got[0].IsOpen || got[1].Path != closedPath || got[1].IsOpen {
		t.Fatalf("ListRecentRepos() = %#v", got)
	}
}
