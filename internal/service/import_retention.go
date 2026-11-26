package service

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"loom/internal/store"
	"os"
	"path/filepath"
	"strconv"
)

type discardedImportFile struct {
	path string
	hash string
}

type discardedImportRedo struct {
	snapshots map[string]string
	active    []discardedImportFile
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
// about to be discarded. File cleanup is deferred until the caller commits.
func pruneUndoneImportRedoTx(tx *sql.Tx) (discardedImportRedo, error) {
	result := discardedImportRedo{snapshots: make(map[string]string)}
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
			for _, entry := range payload.Entries {
				if entry.RetainedPath != "" && entry.SHA256 != "" {
					result.snapshots[filepath.Clean(entry.RetainedPath)] = entry.SHA256
				}
			}
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
		if _, err := tx.Exec(`INSERT INTO discarded_import_files (file_path, sha256) VALUES (?, ?)
			ON CONFLICT(file_path) DO UPDATE SET sha256 = excluded.sha256`, path, entry.SHA256); err != nil {
			return result, err
		}
		if _, err := tx.Exec(`DELETE FROM images WHERE id = ? AND import_undone = 1`, entry.ImageID); err != nil {
			return result, err
		}
		result.active = append(result.active, discardedImportFile{path: path, hash: entry.SHA256})
	}
	return result, nil
}

func cleanupDiscardedImportRedoBestEffort(repo *store.Repo, discarded discardedImportRedo, operation string) {
	cleanupDiscardedImportRedoBestEffortWith(repo, discarded, operation, os.Remove)
}

func (s *ImageService) cleanupDiscardedImportRedo(repo *store.Repo, discarded discardedImportRedo, operation string) {
	if s.removeDiscardedImportFile == nil {
		cleanupDiscardedImportRedoBestEffort(repo, discarded, operation)
		return
	}
	cleanupDiscardedImportRedoBestEffortWith(repo, discarded, operation, s.removeDiscardedImportFile)
}

func cleanupDiscardedImportRedoBestEffortWith(repo *store.Repo, discarded discardedImportRedo, operation string, remove func(string) error) {
	for _, file := range discarded.active {
		before, err := os.Stat(file.path)
		if err != nil {
			if os.IsNotExist(err) {
				clearDiscardedImportSuppression(repo, file.path, operation)
			}
			continue
		}
		data, err := os.ReadFile(file.path)
		if err != nil {
			continue
		}
		if fmt.Sprintf("%x", sha256.Sum256(data)) != file.hash {
			clearDiscardedImportSuppression(repo, file.path, operation)
			continue
		}
		after, err := os.Stat(file.path)
		if err != nil || !os.SameFile(before, after) {
			continue
		}
		if err := remove(file.path); err != nil && !os.IsNotExist(err) {
			log.Printf("%s: unable to clean up discarded import file %q: %v", operation, file.path, err)
			continue
		}
		clearDiscardedImportSuppression(repo, file.path, operation)
	}
	cleanupImportRedoBestEffort(repo, discarded.snapshots, operation)
}

func clearDiscardedImportSuppression(repo *store.Repo, path, operation string) {
	if _, err := repo.DB.Exec(`DELETE FROM discarded_import_files WHERE file_path = ?`, path); err != nil {
		log.Printf("%s: unable to clear discarded-import suppression for %q: %v", operation, path, err)
	}
}

func collectImportRedoTail(repo *store.Repo) (map[string]string, error) {
	cursor, err := repo.UndoCursor()
	if err != nil {
		return nil, err
	}
	rows, err := repo.DB.Query(`SELECT forward, inverse FROM operation_log WHERE seq > ?`, cursor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make(map[string]string)
	for rows.Next() {
		var forward, inverse string
		if err := rows.Scan(&forward, &inverse); err != nil {
			return nil, err
		}
		collectImportPayloadPaths(candidates, forward)
		collectImportPayloadPaths(candidates, inverse)
	}
	return candidates, rows.Err()
}

func collectImportRedoForImages(repo *store.Repo, ids []int64) (map[string]string, error) {
	if len(ids) == 0 {
		return map[string]string{}, nil
	}
	selected := make(map[int64]bool, len(ids))
	for _, id := range ids {
		selected[id] = true
	}
	rows, err := repo.DB.Query(`SELECT forward, inverse FROM operation_log WHERE kind = 'import_batch'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make(map[string]string)
	for rows.Next() {
		var forward, inverse string
		if err := rows.Scan(&forward, &inverse); err != nil {
			return nil, err
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
			for _, entry := range payload.Entries {
				if selected[entry.ImageID] && entry.RetainedPath != "" {
					candidates[filepath.Clean(entry.RetainedPath)] = entry.SHA256
				}
			}
		}
	}
	return candidates, rows.Err()
}

func collectImportPayloadPaths(candidates map[string]string, raw string) {
	var step OpStep
	if err := json.Unmarshal([]byte(raw), &step); err != nil || step.Kind != stepImportBatch {
		return
	}
	var payload importBatchPayload
	if err := json.Unmarshal(step.Payload, &payload); err != nil {
		return
	}
	for _, entry := range payload.Entries {
		if entry.RetainedPath != "" && entry.SHA256 != "" {
			candidates[filepath.Clean(entry.RetainedPath)] = entry.SHA256
		}
	}
}

func cleanupUnreferencedImportRedo(repo *store.Repo, candidates map[string]string) error {
	rows, err := repo.DB.Query(`SELECT forward, inverse FROM operation_log`)
	if err != nil {
		return err
	}
	referenced := make(map[string]bool)
	for rows.Next() {
		var forward, inverse string
		if err := rows.Scan(&forward, &inverse); err != nil {
			rows.Close()
			return err
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
			for _, entry := range payload.Entries {
				if entry.RetainedPath != "" {
					referenced[filepath.Clean(entry.RetainedPath)] = true
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	dir := filepath.Join(repo.Path, ".loom", "trash", "import-redo")
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		expectedHash, wasPruned := candidates[filepath.Clean(path)]
		if !referenced[filepath.Clean(path)] && wasPruned {
			before, err := os.Stat(path)
			if err != nil || !before.Mode().IsRegular() {
				continue
			}
			data, err := os.ReadFile(path)
			if err != nil || fmt.Sprintf("%x", sha256.Sum256(data)) != expectedHash {
				continue
			}
			after, err := os.Stat(path)
			if err != nil || !os.SameFile(before, after) {
				continue
			}
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

func cleanupImportRedoBestEffort(repo *store.Repo, candidates map[string]string, operation string) {
	if err := cleanupUnreferencedImportRedo(repo, candidates); err != nil {
		log.Printf("%s: unable to clean up import snapshots: %v", operation, err)
	}
}

// Once an image is purged, its import-history payload can no longer be replayed.
// Clear only that image's retained path, then let the reference scan safely
// remove bytes that no remaining operation can use.
func forgetPurgedImportHistory(repo *store.Repo, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	candidates, err := collectImportRedoForImages(repo, ids)
	if err != nil {
		return err
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
	cleanupImportRedoBestEffort(repo, candidates, "purge images")
	return nil
}
