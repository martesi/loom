package service

import (
	"database/sql"
	"encoding/json"
	"fmt"

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

const stepShowUnverifiedImport = "show_unverified_import"

type unverifiedImportHistoryEntry struct {
	ID                  int64                  `json:"id"`
	Path                string                 `json:"path"`
	RecordedFingerprint string                 `json:"recordedFingerprint"`
	Trusted             bool                   `json:"trusted"`
	CurrentStatus       ImportResolutionStatus `json:"currentStatus"`
	CurrentFingerprint  string                 `json:"currentFingerprint,omitempty"`
	X                   *float64               `json:"x,omitempty"`
	Y                   *float64               `json:"y,omitempty"`
}

type unverifiedImportHistoryPayload struct {
	Retained bool                           `json:"retained"`
	Entries  []unverifiedImportHistoryEntry `json:"entries"`
}

// applyImportHistoryTx changes visibility only. The media stays at its normal
// repository path so Undo never removes or relocates user files.
func applyImportHistoryTx(repoPath string, tx *sql.Tx, step OpStep) error {
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
			evidence, _ := inspectImportEvidence(repoPath, path, entry.Fingerprint, true)
			if evidence.Status != ImportStatusVerified {
				return fmt.Errorf("imported image %d is %s for redo: %s", entry.ID, evidence.Status, evidence.Error)
			}
		}
		if _, err := tx.Exec(`UPDATE import_recovery SET retained = ? WHERE image_id = ?`, p.Retained, entry.ID); err != nil {
			return err
		}
	}
	return nil
}

func applyUnverifiedImportHistoryTx(repoPath string, tx *sql.Tx, step OpStep) error {
	var payload unverifiedImportHistoryPayload
	if err := json.Unmarshal(step.Payload, &payload); err != nil {
		return err
	}
	if len(payload.Entries) == 0 {
		return fmt.Errorf("empty unverified import visibility history")
	}
	seen := make(map[int64]bool, len(payload.Entries))
	for _, entry := range payload.Entries {
		if entry.ID <= 0 || seen[entry.ID] || entry.Path == "" {
			return fmt.Errorf("invalid unverified import history entry for image %d", entry.ID)
		}
		seen[entry.ID] = true
		var imagePath, recoveryPath, recorded string
		var trusted, retained bool
		var x, y sql.NullFloat64
		if err := tx.QueryRow(`SELECT i.file_path,r.file_path,r.fingerprint,r.trusted,r.retained,i.canvas_x,i.canvas_y
			FROM images i JOIN import_recovery r ON r.image_id=i.id WHERE i.id=?`, entry.ID).
			Scan(&imagePath, &recoveryPath, &recorded, &trusted, &retained, &x, &y); err != nil {
			return fmt.Errorf("unverified import %d is unavailable: %w", entry.ID, err)
		}
		if imagePath != entry.Path || recoveryPath != entry.Path || recorded != entry.RecordedFingerprint || trusted != entry.Trusted || retained == payload.Retained {
			return fmt.Errorf("unverified import %d metadata or visibility changed", entry.ID)
		}
		if !sameImportCoordinate(x, entry.X) || !sameImportCoordinate(y, entry.Y) {
			return fmt.Errorf("unverified import %d geometry changed", entry.ID)
		}
		if !payload.Retained {
			evidence, _ := inspectImportEvidence(repoPath, entry.Path, entry.RecordedFingerprint, entry.Trusted)
			if evidence.Status != entry.CurrentStatus || evidence.CurrentFingerprint != entry.CurrentFingerprint {
				return fmt.Errorf("unverified import %d current file state changed; redo was refused", entry.ID)
			}
			if err := validateRetainedImportGraph(tx, entry.ID); err != nil {
				return fmt.Errorf("unverified import %d graph is incompatible with redo: %w", entry.ID, err)
			}
		}
		if _, err := tx.Exec(`UPDATE import_recovery SET retained=? WHERE image_id=? AND retained=?`, payload.Retained, entry.ID, !payload.Retained); err != nil {
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
	ImageID             int64                  `json:"imageId"`
	FilePath            string                 `json:"filePath"`
	Fingerprint         string                 `json:"fingerprint"`
	Trusted             bool                   `json:"trusted"`
	Status              ImportResolutionStatus `json:"status"`
	RecordedFingerprint string                 `json:"recordedFingerprint"`
	CurrentFingerprint  string                 `json:"currentFingerprint,omitempty"`
	ResolutionError     string                 `json:"resolutionError,omitempty"`
	FilePresent         bool                   `json:"filePresent"`
	Verified            bool                   `json:"verified"`
}

func (s *ImageService) ListRecoverableImports(repoPath string) ([]RecoverableImport, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	rows, err := repo.DB.Query(`SELECT r.image_id, r.file_path, r.fingerprint, r.trusted, i.file_path, i.source_fingerprint
		FROM import_recovery r JOIN images i ON i.id=r.image_id
		WHERE r.retained = 1 ORDER BY r.image_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var imports []RecoverableImport
	for rows.Next() {
		var item RecoverableImport
		var imagePath string
		var sourceFingerprint sql.NullString
		if err := rows.Scan(&item.ImageID, &item.FilePath, &item.Fingerprint, &item.Trusted, &imagePath, &sourceFingerprint); err != nil {
			return nil, err
		}
		evidence, _ := inspectImportEvidence(repo.Path, item.FilePath, item.Fingerprint, item.Trusted)
		if imagePath != item.FilePath || !retainedSourceEvidenceConsistent(item.Trusted, sourceFingerprint, evidence) {
			evidence.Status = ImportStatusAmbiguous
			evidence.Verified = false
			evidence.Error = "retained import metadata is inconsistent"
		}
		item.Status = evidence.Status
		item.RecordedFingerprint = evidence.RecordedFingerprint
		item.CurrentFingerprint = evidence.CurrentFingerprint
		item.ResolutionError = evidence.Error
		item.FilePresent = evidence.FilePresent
		item.Verified = evidence.Verified
		imports = append(imports, item)
	}
	return imports, rows.Err()
}

func retainedSourceEvidenceConsistent(trusted bool, sourceFingerprint sql.NullString, evidence ImportEvidence) bool {
	if !trusted {
		return true
	}
	if !sourceFingerprint.Valid {
		return false
	}
	switch evidence.Status {
	case ImportStatusVerified:
		return sourceFingerprint.String == evidence.RecordedFingerprint
	case ImportStatusChanged:
		return sourceFingerprint.String == evidence.RecordedFingerprint || sourceFingerprint.String == evidence.CurrentFingerprint
	case ImportStatusMissing:
		return true
	default:
		return false
	}
}

func recordImportHistory(repo *store.Repo, tx *sql.Tx, entries []importHistoryEntry) (int64, error) {
	f, err := json.Marshal(step(stepImportMedia, importHistoryPayload{Entries: entries}))
	if err != nil {
		return 0, err
	}
	i, err := json.Marshal(step(stepImportMedia, importHistoryPayload{Retained: true, Entries: entries}))
	if err != nil {
		return 0, err
	}
	return repo.RecordOperationInTx(tx, stepImportMedia, string(f), string(i))
}
