package service

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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
	return store.RenameNoReplace(source, target)
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

var errImportMoveRecoveryDeferred = errors.New("import Move recovery is deferred")

func recoverRenamedPublication(root, target, identity, digest string, transfer importTransfer) error {
	if transfer.Kind == transferRename {
		return removeOwnedImportEntry(target, identity, digest)
	}
	if transfer.Kind != transferMove {
		return fmt.Errorf("invalid transfer for pending import Move")
	}
	// If the proof was never recorded, publication could not have started.
	if identity == "" {
		return nil
	}
	original := transfer.Original
	if !validMoveOriginal(root, original) {
		return fmt.Errorf("%w: original path is not accessible; check the retained entry at %q", errImportMoveRecoveryDeferred, target)
	}
	if sameOwnedImportFile(original, identity, digest) {
		return nil // The original entry still occupies its source path.
	}
	if !sameOwnedImportFile(target, identity, digest) {
		return fmt.Errorf("%w: cannot prove the published entry at %q; both paths were left untouched", errImportMoveRecoveryDeferred, target)
	}
	if err := renameOwnedImportEntry(target, original, identity, digest); err != nil {
		return fmt.Errorf("%w: cannot restore without overwriting; bytes retained at %q: %w", errImportMoveRecoveryDeferred, target, err)
	}
	return nil
}

func deferredImportMoveTargets(repo *store.Repo) (map[string]struct{}, error) {
	rows, err := repo.DB.Query(`SELECT f.target_path FROM import_batch_intent_files f
		JOIN import_batch_intents i ON i.batch_id = f.batch_id
		WHERE i.action = 'publish' AND f.transfer_kind = ?`, transferMove)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := make(map[string]struct{})
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths[path] = struct{}{}
	}
	return paths, rows.Err()
}

func matchesImportEntryDigest(path string, info os.FileInfo, expected string) (bool, error) {
	if anchor, linked := strings.CutPrefix(expected, store.ImportHardlinkProofPrefix); linked {
		// The private anchor holds the original inode even if the user
		// removes their source name or rewrites the shared bytes.
		if !filepath.IsAbs(anchor) || !info.Mode().IsRegular() {
			return false, nil
		}
		anchorInfo, err := os.Lstat(anchor)
		if os.IsNotExist(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		return anchorInfo.Mode().IsRegular() && os.SameFile(info, anchorInfo), nil
	}
	got, err := importEntryDigest(path, info)
	return err == nil && got == expected, err
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
