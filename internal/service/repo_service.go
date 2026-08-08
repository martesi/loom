package service

import (
	"fmt"
	"net/url"

	"github.com/wailsapp/wails/v3/pkg/application"

	"loom/internal/repoconfig"
	"loom/internal/store"
)

type RepoService struct{}

type RepoInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	ImageCount int    `json:"imageCount"`
	OpenedAt   string `json:"openedAt"`

	// IsOpen reports whether this repo currently has a live window showing
	// it (used by ListRecentRepos so the recent-repos list can flag entries
	// that are already open elsewhere).
	IsOpen bool `json:"isOpen"`

	// OpenedElsewhere is set on the return value of open/SwitchTo when the
	// requested repo turned out to already be open in another window. That
	// window was focused instead of reusing/creating one for the caller, so
	// the calling window's frontend must NOT navigate itself into this
	// repo. Only ID/Path are populated alongside it — the calling window
	// isn't navigating, so there's no need to bootstrap the repo again just
	// to fill in Name/ImageCount/OpenedAt.
	OpenedElsewhere bool `json:"openedElsewhere"`
}

// ListRecentRepos returns the global recent-repos list, most recently
// opened first. Entries that no longer exist on disk are silently dropped.
func (s *RepoService) ListRecentRepos() ([]RepoInfo, error) {
	cfg, err := repoconfig.Load()
	if err != nil {
		return nil, err
	}

	infos := make([]RepoInfo, 0, len(cfg.Recent))
	for _, r := range cfg.Recent {
		if !store.IsRepo(r.Path) {
			continue
		}
		repo, err := store.Bootstrap(r.Path)
		if err != nil {
			continue
		}
		count, _ := repo.ImageCount()
		repo.Close()

		_, isOpen := focusedWindowForRepo(r.Path)

		infos = append(infos, RepoInfo{
			ID:         r.Path,
			Name:       repo.Name(),
			Path:       r.Path,
			ImageCount: count,
			OpenedAt:   relativeTime(r.OpenedAt),
			IsOpen:     isOpen,
		})
	}
	return infos, nil
}

// OpenFolder prompts the user to pick an existing folder and opens it as a
// repo (bootstrapping .loom/ if this is the first time).
func (s *RepoService) OpenFolder() (*RepoInfo, error) {
	return s.pickAndOpen("Open Folder")
}

// CreateRepo prompts the user to pick or create a folder and opens it as a
// repo. Functionally identical to OpenFolder — a repo is just a folder with
// a .loom/ — the separate entry point exists for the native dialog's
// wording and for the native "new folder" affordance most OS pickers offer.
func (s *RepoService) CreateRepo() (*RepoInfo, error) {
	return s.pickAndOpen("Create New Repo")
}

func (s *RepoService) pickAndOpen(title string) (*RepoInfo, error) {
	app := application.Get()

	dialog := app.Dialog.OpenFile().
		SetTitle(title).
		CanChooseFiles(false).
		CanChooseDirectories(true).
		CanCreateDirectories(true)

	// Parent the picker to the window it was triggered from, so it is modal to
	// that window rather than a stray top-level. Current() is nil-able.
	if window := app.Window.Current(); window != nil {
		dialog = dialog.AttachToWindow(window)
	}

	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, nil
	}
	return s.open(path)
}

// OpenRecent re-opens an already-known repo by path (e.g. clicking a row in
// the recent-repos list).
func (s *RepoService) OpenRecent(path string) (*RepoInfo, error) {
	return s.open(path)
}

func (s *RepoService) open(path string) (*RepoInfo, error) {
	if window, ok := focusedWindowForRepo(path); ok {
		window.Focus()
		return &RepoInfo{ID: path, Path: path, OpenedElsewhere: true}, nil
	}

	info, err := bootstrapAndTouch(path)
	if err != nil {
		return nil, err
	}

	registerRepoWindow(path, application.Get().Window.Current())
	return info, nil
}

// SwitchTo opens path in a brand-new top-level window rather than the
// calling window. It exists for the repo-switcher (Stage 10): when a
// window already showing repo A wants to switch to repo B, it must never
// navigate itself away from A, so — unlike open/OpenRecent — this method
// never reuses "the current window" as the destination.
//
// If path is already open somewhere, that window is focused instead of
// creating a duplicate.
func (s *RepoService) SwitchTo(path string) (*RepoInfo, error) {
	if window, ok := focusedWindowForRepo(path); ok {
		window.Focus()
		return &RepoInfo{ID: path, Path: path, OpenedElsewhere: true}, nil
	}

	if _, err := bootstrapAndTouch(path); err != nil {
		return nil, err
	}

	// Deliberately NOT calling registerRepoWindow here. WindowManager.NewWithOptions
	// inserts the new window into the app's window map synchronously — before its
	// webview has loaded or run any frontend code — so registering path against it
	// right away would make it briefly "already open" in the registry before its
	// own bootstrap even runs. That new window boots to "/?openRepo="+path, which
	// calls OpenRecent(path) -> open(path) as its very first move; open() would
	// then find this same window already registered via focusedWindowForRepo,
	// treat the repo as open "elsewhere" (i.e. in itself), focus itself as a
	// no-op, and return OpenedElsewhere without Name/ImageCount — so the frontend
	// would never navigate past a blank page. Leaving registration to that window's
	// own open() call (same as every other repo-opening entry point) avoids the
	// self-registration race entirely.
	application.Get().Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Loom",
		Width:            1200,
		Height:           800,
		BackgroundColour: application.NewRGB(243, 242, 241),
		URL:              "/?openRepo=" + url.QueryEscape(path),
	})

	return &RepoInfo{ID: path, Path: path, OpenedElsewhere: true}, nil
}

// bootstrapAndTouch bootstraps (or opens the existing) .loom/ at path,
// records it as the most-recently-opened repo, and builds the RepoInfo
// describing it. Shared by open and SwitchTo so the two entry points don't
// duplicate the bootstrap/touch-recent sequence.
func bootstrapAndTouch(path string) (*RepoInfo, error) {
	repo, err := store.Bootstrap(path)
	if err != nil {
		return nil, fmt.Errorf("open repo at %s: %w", path, err)
	}
	defer repo.Close()

	count, err := repo.ImageCount()
	if err != nil {
		return nil, err
	}

	cfg, err := repoconfig.Load()
	if err != nil {
		return nil, err
	}
	if err := cfg.TouchRecent(path); err != nil {
		return nil, err
	}

	return &RepoInfo{
		ID:         path,
		Name:       repo.Name(),
		Path:       path,
		ImageCount: count,
		OpenedAt:   "Opened just now",
	}, nil
}
