// Package store owns the on-disk shape of an opened Loom repo: the hidden
// .loom/ folder (SQLite DB, thumbnail cache, trash) and the DB handle
// wrapping it.
package store

import (
	"database/sql"
	"os"
	"path/filepath"

	"loom/internal/db"
)

const loomDirName = ".loom"

type Repo struct {
	Path string
	DB   *sql.DB
}

// Bootstrap opens the repo rooted at rootPath, creating its .loom/ folder
// and running migrations if this is the first time this folder has been
// opened. Safe to call repeatedly on an already-bootstrapped repo.
func Bootstrap(rootPath string) (*Repo, error) {
	rootPath = canonicalRepoPath(rootPath)
	loomDir := filepath.Join(rootPath, loomDirName)
	for _, sub := range []string{"", "thumbs", "trash"} {
		if err := os.MkdirAll(filepath.Join(loomDir, sub), 0o755); err != nil {
			return nil, err
		}
	}

	conn, err := db.Open(filepath.Join(loomDir, "db.sqlite"))
	if err != nil {
		return nil, err
	}

	return &Repo{Path: rootPath, DB: conn}, nil
}

func (r *Repo) Close() error {
	return r.DB.Close()
}

func (r *Repo) Name() string {
	return filepath.Base(r.Path)
}

func (r *Repo) ImageCount() (int, error) {
	var count int
	err := r.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE trashed = 0`).Scan(&count)
	return count, err
}

// IsRepo reports whether rootPath already has a .loom/ folder, without
// creating one.
func IsRepo(rootPath string) bool {
	info, err := os.Stat(filepath.Join(rootPath, loomDirName))
	return err == nil && info.IsDir()
}
