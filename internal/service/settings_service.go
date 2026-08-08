package service

import "loom/internal/store"

// SettingsService is a thin key/value wrapper over the repo-scoped settings
// table, used by panel visibility/dock-side (Stage 7) and the Settings
// screen (Stage 11). Layout mode does NOT go through here — it keeps using
// boards.layout_mode via BoardService.SetLayoutMode.
type SettingsService struct{}

// Get returns the value stored under key, or "" if it has never been set
// (see store.GetSetting) — an unset setting is not an error, just an
// unconfigured default.
func (s *SettingsService) Get(repoPath, key string) (string, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return "", err
	}
	defer repo.Close()

	return repo.GetSetting(key)
}

// Set upserts key's value.
func (s *SettingsService) Set(repoPath, key, value string) error {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return err
	}
	defer repo.Close()

	return repo.SetSetting(key, value)
}
