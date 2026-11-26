package service

import (
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
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
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
		removeOwnedFile(path, info)
		return nil, writeErr
	}
	if closeErr != nil {
		removeOwnedFile(path, info)
		return nil, closeErr
	}
	return info, nil
}

// applyImportBatchTx retains all active media and changes only the imported
// rows. A redo never replaces a file that changed outside Loom: it restores
// the captured bytes at a new, exclusive path instead.
func applyImportBatchTx(tx *sql.Tx, payload importBatchPayload) error {
	if len(payload.Entries) == 0 {
		return fmt.Errorf("import history batch is empty")
	}
	for _, entry := range payload.Entries {
		var currentPath string
		if err := tx.QueryRow(`SELECT file_path FROM images WHERE id = ?`, entry.ImageID).Scan(&currentPath); err != nil {
			if err == sql.ErrNoRows {
				return purgedErr(entry.ImageID)
			}
			return err
		}
		if !payload.Active {
			if _, err := tx.Exec(`UPDATE images SET trashed = 1 WHERE id = ?`, entry.ImageID); err != nil {
				return err
			}
			continue
		}

		data, err := os.ReadFile(entry.RetainedPath)
		if err != nil {
			return fmt.Errorf("read retained import bytes: %w", err)
		}
		if fmt.Sprintf("%x", sha256.Sum256(data)) != entry.SHA256 {
			return fmt.Errorf("retained import bytes changed for image %d", entry.ImageID)
		}
		activePath := currentPath
		current, readErr := os.ReadFile(currentPath)
		if readErr != nil || fmt.Sprintf("%x", sha256.Sum256(current)) != entry.SHA256 {
			activePath, err = writeRetainedImport(currentPath, data)
			if err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`UPDATE images SET file_path = ?, trashed = 0 WHERE id = ?`, activePath, entry.ImageID); err != nil {
			return err
		}
	}
	return nil
}

func writeRetainedImport(currentPath string, data []byte) (string, error) {
	dir := filepath.Dir(currentPath)
	ext := filepath.Ext(currentPath)
	base := strings.TrimSuffix(filepath.Base(currentPath), ext)
	for index := 1; ; index++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s (redo %d)%s", base, index, ext))
		if _, err := writeExclusive(candidate, data); err == nil {
			return candidate, nil
		} else if !os.IsExist(err) {
			return "", err
		}
	}
}

func removeOwnedFile(path string, owned os.FileInfo) {
	current, err := os.Stat(path)
	if err == nil && owned != nil && os.SameFile(current, owned) {
		_ = os.Remove(path)
	}
}
