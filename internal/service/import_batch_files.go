package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"loom/internal/store"
)

var errImportCleanupChanged = errors.New("retained import bytes changed; cleanup remains queued")

func sameOwnedImportFile(path, identity, wantHash string) bool {
	pathInfo, err := os.Lstat(path)
	if err != nil || identity == "" || store.FileIdentityAt(path, pathInfo) != identity {
		return false
	}
	matches, err := matchesImportEntryDigest(path, pathInfo, wantHash)
	return err == nil && matches
}

func linkImportAnchor(anchor, target, identity, hash string) error {
	if sameOwnedImportFile(target, identity, hash) {
		return nil
	}
	if !sameOwnedImportFile(anchor, identity, hash) {
		return fmt.Errorf("retained import bytes changed at %q", anchor)
	}
	if err := os.Link(anchor, target); err != nil {
		if os.IsExist(err) && sameOwnedImportFile(target, identity, hash) {
			return nil
		}
		return err
	}
	return nil
}

func drainImportCleanup(repo *store.Repo) error {
	rows, err := repo.DB.Query(`SELECT anchor_path, file_identity, sha256 FROM import_cleanup_queue ORDER BY created_at, anchor_path`)
	if err != nil {
		return err
	}
	type item struct{ path, identity, hash string }
	var queued []item
	for rows.Next() {
		var entry item
		if err := rows.Scan(&entry.path, &entry.identity, &entry.hash); err != nil {
			rows.Close()
			return err
		}
		queued = append(queued, entry)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	var unresolved error
	for _, entry := range queued {
		if !pathInside(filepath.Join(repo.Path, ".loom", "import-anchors"), entry.path) {
			return fmt.Errorf("invalid import cleanup path %q", entry.path)
		}
		if err := removePrivateImportFile(entry.path, entry.identity, entry.hash); err != nil {
			if errors.Is(err, errImportCleanupChanged) {
				unresolved = errors.Join(unresolved, fmt.Errorf("retry import cleanup %q: %w", entry.path, err))
				continue
			}
			return fmt.Errorf("retry import cleanup %q: %w", entry.path, err)
		}
		if _, err := repo.DB.Exec(`DELETE FROM import_cleanup_queue WHERE anchor_path = ?`, entry.path); err != nil {
			return err
		}
	}
	return unresolved
}

// finishImportCleanup treats ownership mismatches as durable deferrals. Other
// cleanup failures still reach the caller so database and I/O errors are not
// confused with an expected preservation decision.
func finishImportCleanup(repo *store.Repo) error {
	err := drainImportCleanup(repo)
	if errors.Is(err, errImportCleanupChanged) {
		return nil
	}
	return err
}

func enqueueImportCleanup(repo *store.Repo, path, identity, hash string) error {
	_, err := repo.DB.Exec(`INSERT OR IGNORE INTO import_cleanup_queue(anchor_path, file_identity, sha256) VALUES (?, ?, ?)`, path, identity, hash)
	return err
}

func discardPendingImportStage(repo *store.Repo, path, identity string, complete bool, hash string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if (!info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0) || (identity != "" && store.FileIdentityAt(path, info) != identity) {
		return enqueueImportCleanup(repo, path, identity, hash)
	}
	if complete {
		matches, err := matchesImportEntryDigest(path, info, hash)
		if err != nil {
			return err
		}
		if !matches {
			return enqueueImportCleanup(repo, path, identity, hash)
		}
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = os.Remove(filepath.Dir(path))
	return nil
}

func removeImportHardLink(anchor, path, identity, wantHash string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	anchorInfo, err := os.Lstat(anchor)
	if err != nil {
		return false, nil
	}
	if !info.Mode().IsRegular() || !anchorInfo.Mode().IsRegular() || !os.SameFile(info, anchorInfo) || (identity != "" && store.FileIdentityAt(path, info) != identity) {
		return false, nil
	}
	matches, err := matchesImportEntryDigest(path, info, wantHash)
	if err != nil {
		return false, err
	}
	if !matches {
		return false, nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return false, err
	}
	return true, nil
}

func removePrivateImportFile(path, identity, wantHash string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		_ = os.Remove(filepath.Dir(path))
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("%w at %q: unsupported file type", errImportCleanupChanged, path)
	}
	if identity != "" && store.FileIdentityAt(path, info) != identity {
		return fmt.Errorf("%w at %q: file identity differs", errImportCleanupChanged, path)
	}
	matches, err := matchesImportEntryDigest(path, info, wantHash)
	if err != nil {
		return err
	}
	if !matches {
		return fmt.Errorf("%w at %q: ownership proof no longer matches", errImportCleanupChanged, path)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = os.Remove(filepath.Dir(path))
	return nil
}

func pathInside(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func hashImportFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() {
		return "", errors.Join(err, fmt.Errorf("not a regular file"))
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	after, err := file.Stat()
	if err != nil {
		return "", err
	}
	pathInfo, err := os.Stat(path)
	if err != nil || !os.SameFile(before, after) || !os.SameFile(after, pathInfo) || before.Size() != after.Size() {
		return "", fmt.Errorf("file changed while hashing %q", path)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
