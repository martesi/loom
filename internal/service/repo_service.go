package service

import (
	"fmt"

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

		infos = append(infos, RepoInfo{
			ID:         r.Path,
			Name:       repo.Name(),
			Path:       r.Path,
			ImageCount: count,
			OpenedAt:   relativeTime(r.OpenedAt),
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
