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
		if _, err := RemoveFileByIdentity(filepath.Join(loomDir, entry.Name()), identity); err != nil {
			return err
		}
	}
	return nil
}

// RemoveFileByIdentity removes path only when it still names identity. It
// atomically moves the entry into a fresh, private quarantine directory before
// its final identity check. The no-replace rename prevents clobbering entries.
func RemoveFileByIdentity(path, identity string) (bool, error) {
	return removeFileByIdentity(path, identity, nil)
}

func removeFileByIdentity(path, identity string, beforeMove func(string)) (bool, error) {
	if identity == "" {
		return false, nil
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || FileIdentityAt(path, info) != identity {
		return false, nil
	}
	quarantineDir, err := os.MkdirTemp(filepath.Dir(path), ".loom-import-cleanup-")
	if err != nil {
		return false, err
	}
	quarantinePath := filepath.Join(quarantineDir, "owned")
	if beforeMove != nil {
		beforeMove(quarantinePath)
	}
	if err := renameImportNoReplace(path, quarantinePath); err != nil {
		_ = os.Remove(quarantineDir)
		return false, err
	}
	quarantinedInfo, err := os.Lstat(quarantinePath)
	if err != nil {
		return false, fmt.Errorf("inspect quarantined import file: %w", err)
	}
	if !quarantinedInfo.Mode().IsRegular() || FileIdentityAt(quarantinePath, quarantinedInfo) != identity {
		if err := renameImportNoReplace(quarantinePath, path); err != nil {
			return false, fmt.Errorf("preserve replaced import file at %q: %w", quarantinePath, err)
		}
		return false, os.Remove(quarantineDir)
	}
	if err := os.Remove(quarantinePath); err != nil {
		return false, err
	}
	return true, os.Remove(quarantineDir)
}
