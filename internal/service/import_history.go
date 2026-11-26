package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	"loom/internal/store"
)

type importHistoryEntry struct {
	ID          int64    `json:"id"`
	Path        string   `json:"path"`
	Fingerprint string   `json:"fingerprint"`
	X           *float64 `json:"x,omitempty"`
	Y           *float64 `json:"y,omitempty"`
}

type importHistoryPayload struct {
	Retained bool                 `json:"retained"`
	Entries  []importHistoryEntry `json:"entries"`
}

// applyImportHistoryTx changes visibility only. The media stays at its normal
// repository path so Undo never removes or relocates user files.
func applyImportHistoryTx(tx *sql.Tx, step OpStep) error {
	var p importHistoryPayload
	if err := json.Unmarshal(step.Payload, &p); err != nil {
		return err
	}
	if len(p.Entries) == 0 {
		return fmt.Errorf("empty import history")
	}
	seen := make(map[int64]bool, len(p.Entries))
	for _, entry := range p.Entries {
		if entry.ID <= 0 || seen[entry.ID] || entry.Path == "" || entry.Fingerprint == "" {
			return fmt.Errorf("invalid import history entry for image %d", entry.ID)
		}
		seen[entry.ID] = true
		var path, recordedFingerprint, sourceFingerprint string
		var retained, trusted bool
		var x, y sql.NullFloat64
		if err := tx.QueryRow(`SELECT images.file_path, images.source_fingerprint, images.canvas_x, images.canvas_y, import_recovery.fingerprint, import_recovery.retained, import_recovery.trusted FROM images JOIN import_recovery ON images.id = import_recovery.image_id WHERE images.id = ?`, entry.ID).Scan(&path, &sourceFingerprint, &x, &y, &recordedFingerprint, &retained, &trusted); err != nil {
			if err == sql.ErrNoRows {
				return purgedErr(entry.ID)
			}
			return err
		}
		if !trusted || path != entry.Path || sourceFingerprint != entry.Fingerprint || recordedFingerprint != entry.Fingerprint || retained == p.Retained {
			return fmt.Errorf("imported image %d changed since history was recorded", entry.ID)
		}
		if !sameImportCoordinate(x, entry.X) || !sameImportCoordinate(y, entry.Y) {
			return fmt.Errorf("imported image %d geometry changed since history was recorded", entry.ID)
		}
		if !p.Retained {
			info, err := os.Lstat(path)
			if err != nil {
				return fmt.Errorf("imported image %d is unavailable for redo: %w", entry.ID, err)
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("imported image %d is not a regular file", entry.ID)
			}
			fingerprint, _, err := store.FingerprintFile(context.Background(), path)
			if err != nil {
				return fmt.Errorf("verify imported image %d for redo: %w", entry.ID, err)
			}
			if fingerprint != entry.Fingerprint {
				return fmt.Errorf("imported image %d changed since import; redo was refused", entry.ID)
			}
		}
		if _, err := tx.Exec(`UPDATE import_recovery SET retained = ? WHERE image_id = ?`, p.Retained, entry.ID); err != nil {
			return err
		}
	}
	return nil
}

func sameImportCoordinate(actual sql.NullFloat64, expected *float64) bool {
	if expected == nil {
		return !actual.Valid
	}
	return actual.Valid && actual.Float64 == *expected
}

func requireNoRedoTail(tx *sql.Tx) error {
	var exists bool
	if err := tx.QueryRow(`SELECT EXISTS(
		SELECT 1 FROM operation_log
		WHERE seq > COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE scope='repo' AND key='undo_cursor'), 0)
	)`).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("cannot recover import while redo history exists; redo or replace that history first")
	}
	return nil
}

// RecoverableImport describes an undone import retained after its redo history
// was discarded. It is deliberately separate from the ordinary asset catalog.
type RecoverableImport struct {
	ImageID     int64  `json:"imageId"`
	FilePath    string `json:"filePath"`
	Fingerprint string `json:"fingerprint"`
	Trusted     bool   `json:"trusted"`
}

func (s *ImageService) ListRecoverableImports(repoPath string) ([]RecoverableImport, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()
	rows, err := repo.DB.Query(`SELECT r.image_id, r.file_path, r.fingerprint, r.trusted FROM import_recovery r WHERE r.retained = 1 ORDER BY r.image_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var imports []RecoverableImport
	for rows.Next() {
		var item RecoverableImport
		if err := rows.Scan(&item.ImageID, &item.FilePath, &item.Fingerprint, &item.Trusted); err != nil {
			return nil, err
		}
		imports = append(imports, item)
	}
	return imports, rows.Err()
}

// RecoverImport explicitly makes a retained import active after redo history
// was truncated. It never copies, moves, reimports, or deletes the source.
func (s *ImageService) RecoverImport(repoPath string, imageID int64) error {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
		return err
	}
	if err := requireNoRedoTail(tx); err != nil {
		return err
	}
	var path, expected, sourceFingerprint string
	var retained, trusted bool
	var x, y sql.NullFloat64
	if err := tx.QueryRow(`SELECT images.file_path, recovery.fingerprint, recovery.retained, recovery.trusted, images.source_fingerprint, images.canvas_x, images.canvas_y FROM import_recovery recovery JOIN images ON images.id = recovery.image_id WHERE recovery.image_id = ?`, imageID).Scan(&path, &expected, &retained, &trusted, &sourceFingerprint, &x, &y); err != nil {
		return fmt.Errorf("recoverable import %d not found: %w", imageID, err)
	}
	if !retained {
		return fmt.Errorf("import %d is already active", imageID)
	}
	if !trusted || expected == "" {
		return fmt.Errorf("legacy retained import %d has no verifiable recovery fingerprint; source was left hidden and unchanged", imageID)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("retained import %d is unavailable; file was left unchanged: %v", imageID, err)
	}
	fingerprint, _, err := store.FingerprintFile(context.Background(), path)
	if err != nil || fingerprint != expected || sourceFingerprint != expected {
		return fmt.Errorf("retained import %d cannot be verified; file was left unchanged", imageID)
	}
	if _, err := tx.Exec(`UPDATE import_recovery SET retained = 0 WHERE image_id = ?`, imageID); err != nil {
		return err
	}
	entry := importHistoryEntry{ID: imageID, Path: path, Fingerprint: expected}
	if x.Valid && y.Valid {
		entry.X, entry.Y = &x.Float64, &y.Float64
	}
	if err := recordImportHistory(repo, tx, []importHistoryEntry{entry}); err != nil {
		return err
	}
	return tx.Commit()
}

func recordImportHistory(repo *store.Repo, tx *sql.Tx, entries []importHistoryEntry) error {
	f, err := json.Marshal(step(stepImportMedia, importHistoryPayload{Entries: entries}))
	if err != nil {
		return err
	}
	i, err := json.Marshal(step(stepImportMedia, importHistoryPayload{Retained: true, Entries: entries}))
	if err != nil {
		return err
	}
	return repo.RecordOperationInTx(tx, stepImportMedia, string(f), string(i))
}
