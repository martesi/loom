package service

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"loom/internal/store"
	"os"
	"strconv"
)

type discardedImportFile struct {
	path     string
	hash     string
	identity string
}

type discardedImportRedo struct {
	active []discardedImportFile
}

func recordOperationInTx(repo *store.Repo, tx *sql.Tx, kind, forward, inverse string) (discardedImportRedo, error) {
	discarded, err := pruneUndoneImportRedoTx(tx)
	if err != nil {
		return discarded, err
	}
	if err := repo.RecordOperationInTx(tx, kind, forward, inverse); err != nil {
		return discarded, err
	}
	return discarded, nil
}

// pruneUndoneImportRedoTx removes hidden import rows whose redo operations are
// about to be discarded. Files stay on disk; stable identities get tombstones
// because portable path-based unlink cannot bind deletion to identity.
func pruneUndoneImportRedoTx(tx *sql.Tx) (discardedImportRedo, error) {
	result := discardedImportRedo{}
	var cursor int64
	var rawCursor string
	err := tx.QueryRow(`SELECT value FROM settings WHERE scope = 'repo' AND key = 'undo_cursor'`).Scan(&rawCursor)
	if err != nil && err != sql.ErrNoRows {
		return result, err
	}
	if err == nil {
		parsed, err := strconv.ParseInt(rawCursor, 10, 64)
		if err != nil {
			return result, err
		}
		cursor = parsed
	}
	rows, err := tx.Query(`SELECT forward, inverse FROM operation_log WHERE seq > ?`, cursor)
	if err != nil {
		return result, err
	}
	var entries []importHistoryEntry
	for rows.Next() {
		var forward, inverse string
		if err := rows.Scan(&forward, &inverse); err != nil {
			rows.Close()
			return result, err
		}
		for _, raw := range []string{forward, inverse} {
			var step OpStep
			if err := json.Unmarshal([]byte(raw), &step); err != nil || step.Kind != stepImportBatch {
				continue
			}
			var payload importBatchPayload
			if err := json.Unmarshal(step.Payload, &payload); err != nil {
				continue
			}
			entries = append(entries, payload.Entries...)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, err
	}
	if err := rows.Close(); err != nil {
		return result, err
	}
	seen := make(map[int64]bool)
	for _, entry := range entries {
		if seen[entry.ImageID] || entry.SHA256 == "" {
			continue
		}
		seen[entry.ImageID] = true
		var path string
		err := tx.QueryRow(`SELECT file_path FROM images WHERE id = ? AND import_undone = 1`, entry.ImageID).Scan(&path)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return result, err
		}
		if entry.FileIdentity == "" {
			// Without a stable ID, keep the bytes and let normal discovery
			// register the path after its hidden row is removed.
			if _, err := tx.Exec(`DELETE FROM images WHERE id = ? AND import_undone = 1`, entry.ImageID); err != nil {
				return result, err
			}
			continue
		}
		if _, err := tx.Exec(`INSERT INTO discarded_import_files (file_path, sha256, file_identity) VALUES (?, ?, ?)
			ON CONFLICT(file_path) DO UPDATE SET sha256 = excluded.sha256, file_identity = excluded.file_identity`, path, entry.SHA256, entry.FileIdentity); err != nil {
			return result, err
		}
		if _, err := tx.Exec(`DELETE FROM images WHERE id = ? AND import_undone = 1`, entry.ImageID); err != nil {
			return result, err
		}
		result.active = append(result.active, discardedImportFile{path: path, hash: entry.SHA256, identity: entry.FileIdentity})
	}
	return result, nil
}

func cleanupDiscardedImportRedoBestEffort(repo *store.Repo, discarded discardedImportRedo, operation string) {
	cleanupDiscardedImportRedoBestEffortAfterCheck(repo, discarded, operation, nil)
}

// The test hook replaces a path after its ownership check. Production does not
// unlink it, because no portable path removal can close the check/remove race.
func cleanupDiscardedImportRedoBestEffortAfterCheck(repo *store.Repo, discarded discardedImportRedo, operation string, afterCheck func(string)) {
	for _, file := range discarded.active {
		info, err := os.Stat(file.path)
		if os.IsNotExist(err) {
			clearDiscardedImportSuppression(repo, file.path, operation)
			continue
		}
		if err != nil {
			continue
		}
		data, err := os.ReadFile(file.path)
		if err != nil {
			continue
		}
		if store.FileIdentityAt(file.path, info) != file.identity || fmt.Sprintf("%x", sha256.Sum256(data)) != file.hash {
			clearDiscardedImportSuppression(repo, file.path, operation)
			continue
		}
		if afterCheck != nil {
			afterCheck(file.path)
		}
	}
}

func (s *ImageService) cleanupDiscardedImportRedo(repo *store.Repo, discarded discardedImportRedo, operation string) {
	cleanupDiscardedImportRedoBestEffort(repo, discarded, operation)
}

func clearDiscardedImportSuppression(repo *store.Repo, path, operation string) {
	if _, err := repo.DB.Exec(`DELETE FROM discarded_import_files WHERE file_path = ?`, path); err != nil {
		log.Printf("%s: unable to clear discarded-import suppression for %q: %v", operation, path, err)
	}
}

func recordImportFileSuppression(repo *store.Repo, path, expectedHash string, owned os.FileInfo, operation string) {
	if owned == nil || store.FileIdentityAt(path, owned) == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, owned) {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(data)) != expectedHash {
		return
	}
	identity := store.FileIdentityAt(path, info)
	if identity == "" || store.FileIdentityAt(path, owned) != identity {
		return
	}
	if _, err := repo.DB.Exec(`INSERT INTO discarded_import_files (file_path, sha256, file_identity) VALUES (?, ?, ?)
		ON CONFLICT(file_path) DO UPDATE SET sha256 = excluded.sha256, file_identity = excluded.file_identity`, path, expectedHash, identity); err != nil {
		log.Printf("%s: unable to suppress failed import file %q: %v", operation, path, err)
	}
}

// Once an image is purged, its import-history payload can no longer be replayed.
// Clear only that image's retained path. The captured bytes remain under .loom
// because deleting by path cannot be made identity-atomic on supported OSes.
func forgetPurgedImportHistory(repo *store.Repo, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := repo.DB.Query(`SELECT seq, forward, inverse FROM operation_log WHERE kind = 'import_batch'`)
	if err != nil {
		return err
	}
	type update struct {
		seq              int64
		forward, inverse string
	}
	var updates []update
	for rows.Next() {
		var item update
		if err := rows.Scan(&item.seq, &item.forward, &item.inverse); err != nil {
			rows.Close()
			return err
		}
		for _, raw := range []*string{&item.forward, &item.inverse} {
			var step OpStep
			if err := json.Unmarshal([]byte(*raw), &step); err != nil || step.Kind != stepImportBatch {
				continue
			}
			var payload importBatchPayload
			if err := json.Unmarshal(step.Payload, &payload); err != nil {
				continue
			}
			changed := false
			for index := range payload.Entries {
				for _, id := range ids {
					if payload.Entries[index].ImageID == id && payload.Entries[index].RetainedPath != "" {
						payload.Entries[index].RetainedPath = ""
						changed = true
					}
				}
			}
			if changed {
				step.Payload, err = json.Marshal(payload)
				if err != nil {
					rows.Close()
					return err
				}
				data, err := json.Marshal(step)
				if err != nil {
					rows.Close()
					return err
				}
				*raw = string(data)
			}
		}
		updates = append(updates, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range updates {
		if _, err := tx.Exec(`UPDATE operation_log SET forward = ?, inverse = ? WHERE seq = ?`, item.forward, item.inverse, item.seq); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}
