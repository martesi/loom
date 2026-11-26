package service

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"loom/internal/store"
)

type replacementRowSnapshot struct {
	path, fingerprint, contentHash string
	revision, fileSize             int64
}

func replacementImageSnapshot(tx *sql.Tx, imageID int64) (replacementRowSnapshot, error) {
	var row replacementRowSnapshot
	err := tx.QueryRow(`SELECT file_path,COALESCE(source_fingerprint,''),COALESCE(source_revision,0),
		COALESCE(file_size,0),COALESCE(content_hash,'') FROM images WHERE id=?`, imageID).
		Scan(&row.path, &row.fingerprint, &row.revision, &row.fileSize, &row.contentHash)
	return row, err
}

func chooseReplacementPathTx(tx *sql.Tx, repoPath string, image store.Image, name string) (string, error) {
	base := filepath.Join(filepath.Dir(image.FilePath), name)
	for suffix := 0; ; suffix++ {
		candidate := suffixedPath(base, suffix)
		var reserved bool
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE file_path=? AND id!=?)
			OR EXISTS(SELECT 1 FROM import_intents WHERE file_path=?)
			OR EXISTS(SELECT 1 FROM replacement_path_reservations WHERE path=?)`, candidate, image.ID, candidate, candidate).Scan(&reserved); err != nil {
			return "", err
		}
		if reserved {
			continue
		}
		if candidate != image.FilePath {
			state, err := replacementPathState(repoPath, candidate)
			if err != nil {
				return "", err
			}
			if state.exists {
				continue
			}
		}
		return candidate, nil
	}
}

func validateReplacementPathSet(root string, current, outgoing, incoming, active string) error {
	for _, path := range []string{current, outgoing, incoming, active} {
		if _, err := replacementPathState(root, path); err != nil {
			return err
		}
	}
	if current == outgoing || current == incoming || outgoing == incoming || outgoing == active || incoming == active {
		return fmt.Errorf("replacement journal contains aliased source or stash paths")
	}
	if current != active && outgoing == active {
		return fmt.Errorf("replacement destination aliases outgoing stash")
	}
	return nil
}

func requireMissingRegularTarget(root, path string) error {
	state, err := replacementPathState(root, path)
	if err != nil {
		return err
	}
	if state.exists {
		return fmt.Errorf("replacement path already exists: %s", path)
	}
	return nil
}

type replacementPath struct {
	exists      bool
	fingerprint string
	info        os.FileInfo
}

func replacementPathState(root, path string) (replacementPath, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return replacementPath{}, err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return replacementPath{}, err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return replacementPath{}, fmt.Errorf("replacement path is outside repository: %s", path)
	}
	current := root
	parts := strings.Split(rel, string(filepath.Separator))
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return replacementPath{}, nil
		}
		if err != nil {
			return replacementPath{}, fmt.Errorf("inspect replacement path %s: %w", current, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return replacementPath{}, fmt.Errorf("replacement path contains a symbolic link: %s", current)
		}
		if index < len(parts)-1 && !info.IsDir() {
			return replacementPath{}, fmt.Errorf("replacement parent is not a directory: %s", current)
		}
		if index == len(parts)-1 {
			if !info.Mode().IsRegular() {
				return replacementPath{}, fmt.Errorf("replacement path is not a regular file: %s", current)
			}
			fingerprint, stable, err := store.FingerprintFile(context.Background(), path)
			if err != nil {
				return replacementPath{}, fmt.Errorf("fingerprint replacement path %s: %w", path, err)
			}
			return replacementPath{exists: true, fingerprint: fingerprint, info: stable}, nil
		}
	}
	return replacementPath{}, nil
}

func requireExistingFingerprint(root, path, expected string) error {
	state, err := replacementPathState(root, path)
	if err != nil {
		return err
	}
	if !state.exists || state.fingerprint != expected {
		return fmt.Errorf("replacement source is missing or changed: %s", path)
	}
	return nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
