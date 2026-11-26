package service

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
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

func writeExclusiveMode(path string, data []byte, mode os.FileMode) (os.FileInfo, error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return nil, err
	}
	info, statErr := file.Stat()
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if statErr != nil {
		return nil, statErr
	}
	if writeErr != nil {
		removeOwnedFilePrefix(path, info, data)
		return nil, writeErr
	}
	if closeErr != nil {
		removeOwnedFilePrefix(path, info, data)
		return nil, closeErr
	}
	return info, nil
}

// applyImportBatchTx retains all active media and changes only the imported
// rows. A redo never replaces a file that changed outside Loom: it restores
// the captured bytes at a new, exclusive path instead.
type ownedImportFile struct {
	path string
	info os.FileInfo
	hash string
}

func applyImportBatchTx(tx *sql.Tx, payload importBatchPayload, created *[]ownedImportFile, afterWrite func(string)) error {
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
			activePath, info, err = writeRetainedImport(currentPath, item.data)
			if err != nil {
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

func writeRetainedImport(currentPath string, data []byte) (string, os.FileInfo, error) {
	dir := filepath.Dir(currentPath)
	ext := filepath.Ext(currentPath)
	base := strings.TrimSuffix(filepath.Base(currentPath), ext)
	for index := 1; ; index++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s (redo %d)%s", base, index, ext))
		if info, err := writeExclusive(candidate, data); err == nil {
			return candidate, info, nil
		} else if !os.IsExist(err) {
			return "", nil, err
		}
	}
}

func removeOwnedFile(path string, owned os.FileInfo, expectedHash string) {
	current, err := os.Stat(path)
	if err == nil && owned != nil && os.SameFile(current, owned) {
		data, readErr := os.ReadFile(path)
		if readErr == nil && fmt.Sprintf("%x", sha256.Sum256(data)) == expectedHash {
			_ = os.Remove(path)
		}
	}
}

func removeOwnedFilePrefix(path string, owned os.FileInfo, data []byte) {
	current, err := os.Stat(path)
	if err != nil || owned == nil || !os.SameFile(current, owned) {
		return
	}
	onDisk, err := os.ReadFile(path)
	if err == nil && len(onDisk) <= len(data) && bytes.Equal(onDisk, data[:len(onDisk)]) {
		_ = os.Remove(path)
	}
}
