// Package repoconfig manages Loom's global (not per-repo) configuration:
// the recent-repos list and app-wide settings such as language. It lives
// outside any repo, in the OS-standard app-config location.
package repoconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type RecentRepo struct {
	Path     string    `json:"path"`
	OpenedAt time.Time `json:"openedAt"`
}

type Config struct {
	Language string       `json:"language"`
	Recent   []RecentRepo `json:"recent"`
}

func dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "Loom"), nil
}

func path() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

func Load() (*Config, error) {
	p, err := path()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return &Config{Language: "en"}, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) Save() error {
	d, err := dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	p, err := path()
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

// TouchRecent moves repoPath to the front of the recent list (adding it if
// absent) and persists the config.
func (c *Config) TouchRecent(repoPath string) error {
	filtered := c.Recent[:0]
	for _, r := range c.Recent {
		if r.Path != repoPath {
			filtered = append(filtered, r)
		}
	}
	c.Recent = append([]RecentRepo{{Path: repoPath, OpenedAt: time.Now()}}, filtered...)
	return c.Save()
}
