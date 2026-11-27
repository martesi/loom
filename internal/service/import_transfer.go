package service

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/store"
)

const (
	transferRename = "rename"
	transferMove   = "move"
)

type importTransfer struct {
	Kind     string `json:"transferKind,omitempty"`
	Original string `json:"originalPath,omitempty"`
}

func setImportTransfer(repo *store.Repo, batchID string, ordinal int, transfer importTransfer) error {
	_, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET transfer_kind = ?, original_path = ? WHERE batch_id = ? AND ordinal = ?`,
		transfer.Kind, transfer.Original, batchID, ordinal)
	return err
}

// renameOwnedImportEntry only relocates a verified directory entry. Unlike an
// ordinary rename, the native primitive fails if the target is occupied.
func renameOwnedImportEntry(source, target, identity, digest string) error {
	if !sameOwnedImportFile(source, identity, digest) {
		return fmt.Errorf("import entry %q changed; left untouched", filepath.Base(source))
	}
	return renameImportEntry(source, target)
}

func removeOwnedImportEntry(path, identity, digest string) error {
	if !sameOwnedImportFile(path, identity, digest) {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func importEntryDigest(path string, info os.FileInfo) (string, error) {
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(path)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("symlink:%x", sha256.Sum256([]byte(target))), nil
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular file or symbolic link")
	}
	return hashImportFile(path)
}

func markImportStageComplete(repo *store.Repo, batchID string, ordinal int, identity, digest string) error {
	_, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET file_identity = ?, sha256 = ?, stage_complete = 1 WHERE batch_id = ? AND ordinal = ?`,
		identity, digest, batchID, ordinal)
	return err
}

func validMoveOriginal(root, path string) bool {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || pathInside(root, path) || filepath.Clean(root) == path {
		return false
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	return err == nil && filepath.Clean(parent) == filepath.Dir(path)
}

func prepareNativeSource(root, source string, move bool) (string, error) {
	absolute, err := filepath.Abs(source)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	if move && !validMoveOriginal(root, resolved) {
		return "", fmt.Errorf("move requires a regular source file outside the repository")
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", err
	}
	if !move && info.Mode()&os.ModeSymlink != 0 {
		info, err = os.Stat(resolved)
		if err != nil {
			return "", err
		}
	}
	if !info.Mode().IsRegular() || !store.IsMediaFile(resolved) {
		return "", fmt.Errorf("source must be a regular media file")
	}
	return resolved, nil
}

func recoverRenamedPublication(root, target, identity, digest string, transfer importTransfer) error {
	if transfer.Kind == transferRename {
		return removeOwnedImportEntry(target, identity, digest)
	}
	if transfer.Kind != transferMove || !validMoveOriginal(root, transfer.Original) {
		return fmt.Errorf("invalid original path for pending import move")
	}
	if !sameOwnedImportFile(target, identity, digest) {
		return nil
	}
	if err := renameOwnedImportEntry(target, transfer.Original, identity, digest); err != nil {
		return fmt.Errorf("restore original import path without overwriting; bytes retained at %q: %w", target, err)
	}
	return nil
}

func recoverRenamedReplay(root, source, target, anchor, identity, digest, action string, transfer importTransfer) error {
	park := anchor
	if transfer.Kind == transferMove {
		park = transfer.Original
		if !validMoveOriginal(root, park) {
			return fmt.Errorf("invalid original path for import replay")
		}
	} else if transfer.Kind != transferRename {
		return fmt.Errorf("invalid import replay transfer")
	}
	if (action == "undo" && (!pathInside(root, source) || target != park)) ||
		(action == "redo" && (source != park || !pathInside(root, target))) {
		return fmt.Errorf("invalid import replay paths")
	}
	if _, err := os.Lstat(source); os.IsNotExist(err) && sameOwnedImportFile(target, identity, digest) {
		return nil
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if action == "undo" && transfer.Kind == transferRename {
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
	}
	if err := renameOwnedImportEntry(source, target, identity, digest); err != nil {
		return fmt.Errorf("replay import without overwriting: %w", err)
	}
	return nil
}

func checkTransferTarget(path string) error {
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("import destination %q is already occupied: %w", filepath.Base(path), os.ErrExist)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
