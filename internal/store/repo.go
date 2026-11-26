// Package store owns the on-disk shape of an opened Loom repo: the hidden
// .loom/ folder (SQLite DB, thumbnail cache, trash) and the DB handle
// wrapping it.
package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/db"
)

const loomDirName = ".loom"

type Repo struct {
	Path string
	DB   *sql.DB
}

type MigrationInspection = db.MigrationInspection

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

// OpenExistingReadOnly opens a repository that already has a migrated
// database. It never creates directories or initializes SQLite state.
func OpenExistingReadOnly(rootPath string) (*Repo, error) {
	rootPath = canonicalRepoPath(rootPath)
	dbPath := filepath.Join(rootPath, loomDirName, "db.sqlite")
	info, err := os.Stat(dbPath)
	if err != nil {
		return nil, fmt.Errorf("repository database is unavailable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("repository database is not a regular file")
	}
	_, walErr := os.Stat(dbPath + "-wal")
	_, shmErr := os.Stat(dbPath + "-shm")
	immutable := os.IsNotExist(walErr) && os.IsNotExist(shmErr)
	if !immutable && (walErr != nil || shmErr != nil) {
		return nil, fmt.Errorf("repository database has incomplete WAL state; read-only observation is unavailable")
	}
	conn, err := db.OpenExistingReadOnly(dbPath, immutable)
	if err != nil {
		return nil, err
	}
	return &Repo{Path: rootPath, DB: conn}, nil
}

// OpenExisting opens an already-migrated repository for writes without
// creating it or applying migrations. Mutation callers must hold admission.
func OpenExisting(rootPath string) (*Repo, error) {
	rootPath = canonicalRepoPath(rootPath)
	dbPath := filepath.Join(rootPath, loomDirName, "db.sqlite")
	info, err := os.Stat(dbPath)
	if err != nil {
		return nil, fmt.Errorf("repository database is unavailable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("repository database is not a regular file")
	}
	conn, err := db.OpenExisting(dbPath)
	if err != nil {
		return nil, err
	}
	return &Repo{Path: rootPath, DB: conn}, nil
}

func InspectRepositoryMigrations(rootPath string) (db.MigrationInspection, error) {
	rootPath = canonicalRepoPath(rootPath)
	return db.InspectMigrations(filepath.Join(rootPath, loomDirName, "db.sqlite"))
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
