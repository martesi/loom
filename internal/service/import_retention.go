package service

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/store"
)

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
			data, err := os.ReadFile(path)
			if err != nil || fmt.Sprintf("%x", sha256.Sum256(data)) != expectedHash {
				continue
			}
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
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
	if err := cleanupUnreferencedImportRedo(repo, candidates); err != nil {
		return fmt.Errorf("clean up purged import snapshots: %w", err)
	}
	return nil
}
