package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ReleaseImportIdentityAnchors removes hidden hard links only after their
// identity is no longer referenced by a live image or discovery tombstone.
func (r *Repo) ReleaseImportIdentityAnchors(identity string) error {
	if identity == "" {
		return nil
	}
	var references int
	if err := r.DB.QueryRow(`SELECT
		(SELECT COUNT(*) FROM images WHERE import_file_identity = ?) +
		(SELECT COUNT(*) FROM discarded_import_files WHERE file_identity = ?)`, identity, identity).Scan(&references); err != nil {
		return err
	}
	if references != 0 {
		return nil
	}
	loomDir := filepath.Join(r.Path, loomDirName)
	entries, err := os.ReadDir(loomDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), ".loom-import-stage-") {
			continue
		}
		if err := removeIdentityAnchor(filepath.Join(loomDir, entry.Name()), identity); err != nil {
			return err
		}
	}
	return nil
}

func removeIdentityAnchor(path, identity string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || FileIdentityAt(path, info) != identity {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".loom-import-anchor-release-*")
	if err != nil {
		return err
	}
	quarantine := file.Name()
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Remove(quarantine); err != nil {
		return err
	}
	if err := os.Rename(path, quarantine); err != nil {
		return err
	}
	movedInfo, err := os.Lstat(quarantine)
	if err == nil && movedInfo.Mode().IsRegular() && FileIdentityAt(quarantine, movedInfo) == identity {
		return os.Remove(quarantine)
	}
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Link(quarantine, path); err != nil {
		return fmt.Errorf("preserve replaced import anchor at %q: %w", quarantine, err)
	}
	return os.Remove(quarantine)
}
