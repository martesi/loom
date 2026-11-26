package service

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const stepImportBatch = "import_batch"

type importHistoryEntry struct {
	ImageID      int64  `json:"imageId"`
	RetainedPath string `json:"retainedPath"`
	SHA256       string `json:"sha256"`
}

type importBatchPayload struct {
	Entries []importHistoryEntry `json:"entries"`
	Active  bool                 `json:"active"`
}

func writeExclusive(path string, data []byte) (os.FileInfo, error) {
	return writeExclusiveMode(path, data, 0o600)
}

type exclusiveFile interface {
	Stat() (os.FileInfo, error)
	Write([]byte) (int, error)
	Close() error
}

type unverifiedExclusiveFileError struct {
	path  string
	cause error
}

func (e *unverifiedExclusiveFileError) Error() string { return e.cause.Error() }
func (e *unverifiedExclusiveFileError) Unwrap() error { return e.cause }

type exclusiveCleanupFailure struct {
	path  string
	info  os.FileInfo
	hash  string
	cause error
}

func (e *exclusiveCleanupFailure) Error() string { return e.cause.Error() }
func (e *exclusiveCleanupFailure) Unwrap() error { return e.cause }

func writeExclusiveMode(path string, data []byte, mode os.FileMode) (os.FileInfo, error) {
	return writeExclusiveModeUsing(path, data, mode, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
		return os.OpenFile(path, flags, mode)
	})
}

func writeExclusiveModeUsing(path string, data []byte, mode os.FileMode, open func(string, int, os.FileMode) (exclusiveFile, error), removeFiles ...func(string) error) (os.FileInfo, error) {
	remove := os.Remove
	if len(removeFiles) > 0 && removeFiles[0] != nil {
		remove = removeFiles[0]
	}
	stageDir := exclusiveStageDirectory(path)
	var stagePath string
	var file exclusiveFile
	for {
		seed, err := os.CreateTemp(stageDir, ".loom-import-stage-*")
		if err != nil {
			return nil, err
		}
		stagePath = seed.Name()
		if err := seed.Close(); err != nil {
			_ = os.Remove(stagePath)
			return nil, err
		}
		if err := os.Remove(stagePath); err != nil {
			return nil, err
		}
		file, err = open(stagePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		break
	}
	info, statErr := file.Stat()
	if statErr != nil {
		retryInfo, retryErr := file.Stat()
		_ = file.Close()
		if retryErr == nil {
			remainingHash, cleanupErr := removeOwnedFilePrefix(stagePath, retryInfo, data, remove)
			if cleanupErr != nil {
				return nil, &exclusiveCleanupFailure{path: stagePath, info: retryInfo, hash: remainingHash, cause: errors.Join(statErr, cleanupErr)}
			}
			return nil, statErr
		}
		return nil, &unverifiedExclusiveFileError{path: stagePath, cause: errors.Join(statErr, retryErr)}
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		remainingHash, cleanupErr := removeOwnedFilePrefix(stagePath, info, data, remove)
		if cleanupErr != nil {
			return nil, &exclusiveCleanupFailure{path: stagePath, info: info, hash: remainingHash, cause: errors.Join(writeErr, cleanupErr)}
		}
		return nil, writeErr
	}
	if closeErr != nil {
		remainingHash, cleanupErr := removeOwnedFilePrefix(stagePath, info, data, remove)
		if cleanupErr != nil {
			return nil, &exclusiveCleanupFailure{path: stagePath, info: info, hash: remainingHash, cause: errors.Join(closeErr, cleanupErr)}
		}
		return nil, closeErr
	}
	if err := os.Link(stagePath, path); err != nil {
		remainingHash, cleanupErr := removeOwnedFilePrefix(stagePath, info, data, remove)
		if cleanupErr != nil {
			return nil, &exclusiveCleanupFailure{path: stagePath, info: info, hash: remainingHash, cause: errors.Join(err, cleanupErr)}
		}
		return nil, err
	}
	_ = os.Remove(stagePath)
	return info, nil
}

func exclusiveStageDirectory(path string) string {
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if filepath.Base(dir) == ".loom" {
			return dir
		}
		loomDir := filepath.Join(dir, ".loom")
		if info, err := os.Stat(loomDir); err == nil && info.IsDir() {
			return loomDir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return filepath.Dir(path)
		}
	}
}

// applyImportBatchTx retains all active media and changes only the imported
// rows. A redo never replaces a file that changed outside Loom: it restores
// the captured bytes at a new, exclusive path instead.
type ownedImportFile struct {
	path string
	info os.FileInfo
	hash string
}

func applyImportBatchTx(tx *sql.Tx, payload importBatchPayload, created *[]ownedImportFile, afterWrite func(string), writeFile ...func(string, []byte) (os.FileInfo, error)) error {
	if len(payload.Entries) == 0 {
		return fmt.Errorf("import history batch is empty")
	}
	type validatedEntry struct {
		entry       importHistoryEntry
		currentPath string
		data        []byte
	}
	validated := make([]validatedEntry, 0, len(payload.Entries))
	for _, entry := range payload.Entries {
		var currentPath string
		if err := tx.QueryRow(`SELECT file_path FROM images WHERE id = ?`, entry.ImageID).Scan(&currentPath); err != nil {
			if err == sql.ErrNoRows {
				return purgedErr(entry.ImageID)
			}
			return err
		}
		item := validatedEntry{entry: entry, currentPath: currentPath}
		if payload.Active {
			data, err := os.ReadFile(entry.RetainedPath)
			if err != nil {
				return fmt.Errorf("read retained import bytes: %w", err)
			}
			if fmt.Sprintf("%x", sha256.Sum256(data)) != entry.SHA256 {
				return fmt.Errorf("retained import bytes changed for image %d", entry.ImageID)
			}
			item.data = data
		}
		validated = append(validated, item)
	}
	for _, item := range validated {
		entry, currentPath := item.entry, item.currentPath
		if !payload.Active {
			if _, err := tx.Exec(`UPDATE images SET trashed = 0, import_undone = 1 WHERE id = ?`, entry.ImageID); err != nil {
				return err
			}
			continue
		}
		activePath := currentPath
		current, readErr := os.ReadFile(currentPath)
		if readErr != nil || fmt.Sprintf("%x", sha256.Sum256(current)) != entry.SHA256 {
			var info os.FileInfo
			var err error
			activePath, info, err = writeRetainedImport(currentPath, item.data, writeFile...)
			if err != nil {
				var cleanupFailure *exclusiveCleanupFailure
				if errors.As(err, &cleanupFailure) {
					*created = append(*created, ownedImportFile{path: cleanupFailure.path, info: cleanupFailure.info, hash: cleanupFailure.hash})
				}
				var unverifiedFailure *unverifiedExclusiveFileError
				if errors.As(err, &unverifiedFailure) {
					*created = append(*created, ownedImportFile{path: unverifiedFailure.path, hash: fmt.Sprintf("%x", sha256.Sum256(nil))})
				}
				return err
			}
			*created = append(*created, ownedImportFile{path: activePath, info: info, hash: entry.SHA256})
			if afterWrite != nil {
				afterWrite(activePath)
			}
		}
		if activePath != currentPath {
			if _, err := tx.Exec(`UPDATE images SET file_path = ?, trashed = 0, import_undone = 0, thumb_path = NULL, width = NULL, height = NULL, file_size = ?, content_hash = NULL, source_fingerprint = NULL, source_revision = source_revision + 1 WHERE id = ?`, activePath, len(item.data), entry.ImageID); err != nil {
				return err
			}
		} else if _, err := tx.Exec(`UPDATE images SET trashed = 0, import_undone = 0 WHERE id = ?`, entry.ImageID); err != nil {
			return err
		}
	}
	return nil
}

func writeRetainedImport(currentPath string, data []byte, writeFile ...func(string, []byte) (os.FileInfo, error)) (string, os.FileInfo, error) {
	dir := filepath.Dir(currentPath)
	ext := filepath.Ext(currentPath)
	base := strings.TrimSuffix(filepath.Base(currentPath), ext)
	for index := 1; ; index++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s (redo %d)%s", base, index, ext))
		write := func(path string, bytes []byte) (os.FileInfo, error) { return writeExclusive(path, bytes) }
		if len(writeFile) > 0 && writeFile[0] != nil {
			write = writeFile[0]
		}
		if info, err := write(candidate, data); err == nil {
			return candidate, info, nil
		} else if !os.IsExist(err) {
			return "", nil, err
		}
	}
}

func removeOwnedFile(path string, owned os.FileInfo, expectedHash string, removeFiles ...func(string) error) bool {
	remove := os.Remove
	if len(removeFiles) > 0 && removeFiles[0] != nil {
		remove = removeFiles[0]
	}
	current, err := os.Stat(path)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil || owned == nil || !os.SameFile(current, owned) {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(data)) != expectedHash {
		return false
	}
	err = remove(path)
	return err == nil || os.IsNotExist(err)
}

func removeOwnedFilePrefix(path string, owned os.FileInfo, data []byte, remove func(string) error) (string, error) {
	current, err := os.Stat(path)
	if err != nil || owned == nil || !os.SameFile(current, owned) {
		return "", nil
	}
	onDisk, err := os.ReadFile(path)
	if err != nil || len(onDisk) > len(data) || !bytes.Equal(onDisk, data[:len(onDisk)]) {
		return "", nil
	}
	err = remove(path)
	if err == nil || os.IsNotExist(err) {
		return "", nil
	}
	return fmt.Sprintf("%x", sha256.Sum256(onDisk)), err
}
