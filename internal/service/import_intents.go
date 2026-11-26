package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"loom/internal/store"
)

type preparedImport struct {
	Name        string
	Data        []byte
	Fingerprint string
}

type reservedImport struct {
	Path        string
	Fingerprint string
	X           *float64
	Y           *float64
}

type pendingImportRow struct {
	Index       int
	Path        string
	Fingerprint string
	X           sql.NullFloat64
	Y           sql.NullFloat64
}

type PendingImportFile struct {
	Path        string `json:"path"`
	Fingerprint string `json:"fingerprint"`
	FilePresent bool   `json:"filePresent"`
	Verified    bool   `json:"verified"`
}

type PendingImportBatch struct {
	ID    string              `json:"id"`
	Files []PendingImportFile `json:"files"`
}

// Tests terminate a subprocess at these boundaries to verify durable intents.
var importIntentCrashHook func(string)

func prepareImportItems(items []ClipboardMedia) ([]preparedImport, error) {
	if err := validateClipboardMedia(items); err != nil {
		return nil, err
	}
	prepared := make([]preparedImport, 0, len(items))
	for _, item := range items {
		data, err := base64.StdEncoding.Strict().DecodeString(item.Data)
		if err != nil {
			return nil, fmt.Errorf("decode media %q: %w", item.Name, err)
		}
		digest := sha256.Sum256(data)
		prepared = append(prepared, preparedImport{
			Name:        filepath.Base(strings.ReplaceAll(item.Name, "\\", "/")),
			Data:        data,
			Fingerprint: hex.EncodeToString(digest[:]),
		})
	}
	return prepared, nil
}

func reserveImportPaths(repo *store.Repo, items []preparedImport, place bool, x, y float64) (string, []reservedImport, error) {
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", nil, err
	}
	batchID := hex.EncodeToString(tokenBytes)
	tx, err := repo.DB.Begin()
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
		return "", nil, fmt.Errorf("lock import path reservation: %w", err)
	}
	paths := make([]reservedImport, 0, len(items))
	for index, item := range items {
		base := filepath.Join(repo.Path, item.Name)
		for suffix := 0; ; suffix++ {
			candidate := suffixedPath(base, suffix)
			var reserved bool
			if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE file_path = ?) OR EXISTS(SELECT 1 FROM import_intents WHERE file_path = ?)`, candidate, candidate).Scan(&reserved); err != nil {
				return "", nil, err
			}
			if reserved {
				continue
			}
			if _, err := os.Lstat(candidate); err == nil {
				continue
			} else if !os.IsNotExist(err) {
				return "", nil, fmt.Errorf("inspect import path %s: %w", candidate, err)
			}
			var px, py any
			entry := reservedImport{Path: candidate, Fingerprint: item.Fingerprint}
			if place {
				cx, cy := x+float64(index%6)*190, y+float64(index/6)*160
				px, py = cx, cy
				entry.X, entry.Y = &cx, &cy
			}
			if _, err := tx.Exec(`INSERT INTO import_intents(batch_id,item_index,file_path,fingerprint,canvas_x,canvas_y) VALUES (?,?,?,?,?,?)`, batchID, index, candidate, item.Fingerprint, px, py); err != nil {
				return "", nil, fmt.Errorf("reserve import path %s: %w", candidate, err)
			}
			paths = append(paths, entry)
			break
		}
	}
	if err := tx.Commit(); err != nil {
		return "", nil, err
	}
	return batchID, paths, nil
}

func suffixedPath(path string, suffix int) string {
	if suffix == 0 {
		return path
	}
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(path, ext)
	return fmt.Sprintf("%s (%d)%s", base, suffix, ext)
}

func createReservedFiles(items []preparedImport, paths []reservedImport) error {
	for i, item := range items {
		file, err := os.OpenFile(paths[i].Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return fmt.Errorf("create reserved import file %s: %w", paths[i].Path, err)
		}
		_, writeErr := file.Write(item.Data)
		closeErr := file.Close()
		if writeErr != nil {
			return fmt.Errorf("write reserved import file %s: %w", paths[i].Path, writeErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close reserved import file %s: %w", paths[i].Path, closeErr)
		}
	}
	return nil
}

func finalizeImportBatch(repo *store.Repo, batchID string, requireNoRedo bool) ([]int64, error) {
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
		return nil, fmt.Errorf("lock import transaction: %w", err)
	}
	if requireNoRedo {
		if err := requireNoRedoTail(tx); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(`SELECT item_index,file_path,fingerprint,canvas_x,canvas_y FROM import_intents WHERE batch_id=? ORDER BY item_index`, batchID)
	if err != nil {
		return nil, err
	}
	var pending []pendingImportRow
	for rows.Next() {
		var row pendingImportRow
		if err := rows.Scan(&row.Index, &row.Path, &row.Fingerprint, &row.X, &row.Y); err != nil {
			rows.Close()
			return nil, err
		}
		pending = append(pending, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(pending) == 0 {
		return nil, fmt.Errorf("pending import batch %s not found", batchID)
	}
	entries := make([]importHistoryEntry, 0, len(pending))
	ids := make([]int64, 0, len(pending))
	for i, item := range pending {
		if item.Index != i {
			return nil, fmt.Errorf("pending import batch %s has an incomplete item sequence", batchID)
		}
		info, err := os.Lstat(item.Path)
		if err != nil {
			return nil, fmt.Errorf("pending import file %s is unavailable: %w", item.Path, err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("pending import file %s is not a regular file", item.Path)
		}
		fingerprint, stableInfo, err := store.FingerprintFile(context.Background(), item.Path)
		if err != nil || fingerprint != item.Fingerprint {
			return nil, fmt.Errorf("pending import file %s cannot be verified; no database rows were created", item.Path)
		}
		var x, y any
		entry := importHistoryEntry{Path: item.Path, Fingerprint: item.Fingerprint}
		if item.X.Valid && item.Y.Valid {
			x, y = item.X.Float64, item.Y.Float64
			entry.X, entry.Y = &item.X.Float64, &item.Y.Float64
		}
		marker := fmt.Sprintf("stat:%d:%d", stableInfo.Size(), stableInfo.ModTime().UnixNano())
		result, err := tx.Exec(`INSERT INTO images(file_path,canvas_x,canvas_y,file_size,content_hash,source_fingerprint,source_revision) VALUES (?,?,?,?,?,?,1)`, item.Path, x, y, stableInfo.Size(), marker, item.Fingerprint)
		if err != nil {
			return nil, err
		}
		id, err := result.LastInsertId()
		if err != nil {
			return nil, err
		}
		entry.ID = id
		entries = append(entries, entry)
		ids = append(ids, id)
		if _, err := tx.Exec(`INSERT INTO import_recovery(image_id,file_path,fingerprint) VALUES (?,?,?)`, id, item.Path, item.Fingerprint); err != nil {
			return nil, err
		}
	}
	if err := recordImportHistory(repo, tx, entries); err != nil {
		return nil, fmt.Errorf("record import history: %w", err)
	}
	result, err := tx.Exec(`DELETE FROM import_intents WHERE batch_id=?`, batchID)
	if err != nil {
		return nil, err
	}
	deleted, err := result.RowsAffected()
	if err != nil || int(deleted) != len(pending) {
		return nil, fmt.Errorf("pending import batch changed while being finalized")
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return ids, nil
}

func listPendingImportBatches(repo *store.Repo) ([]PendingImportBatch, error) {
	rows, err := repo.DB.Query(`SELECT batch_id,file_path,fingerprint FROM import_intents ORDER BY created_at,batch_id,item_index`)
	if err != nil {
		return nil, err
	}
	type pending struct{ batchID, path, fingerprint string }
	var files []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.batchID, &item.path, &item.fingerprint); err != nil {
			rows.Close()
			return nil, err
		}
		files = append(files, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	byID := make(map[string]int)
	var batches []PendingImportBatch
	for _, item := range files {
		index, exists := byID[item.batchID]
		if !exists {
			batches = append(batches, PendingImportBatch{ID: item.batchID})
			index = len(batches) - 1
			byID[item.batchID] = index
		}
		status := PendingImportFile{Path: item.path, Fingerprint: item.fingerprint}
		info, err := os.Lstat(item.path)
		if err == nil && info.Mode().IsRegular() {
			status.FilePresent = true
			fingerprint, _, fingerprintErr := store.FingerprintFile(context.Background(), item.path)
			status.Verified = fingerprintErr == nil && fingerprint == item.fingerprint
		}
		batches[index].Files = append(batches[index].Files, status)
	}
	return batches, nil
}

// ListPendingImportBatches exposes pre-commit work that survived an error or
// process exit. Unverified files remain reserved and are never auto-discovered.
func (s *ImageService) ListPendingImportBatches(repoPath string) ([]PendingImportBatch, error) {
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		return nil, err
	}
	defer repo.Close()
	return listPendingImportBatches(repo)
}

// RecoverPendingImportBatch explicitly finalizes one verified interrupted batch
// as a single undoable import. It refuses to discard an existing redo branch.
func (s *ImageService) RecoverPendingImportBatch(repoPath, batchID string) ([]int64, error) {
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return nil, err
	}
	return finalizeImportBatch(repo, batchID, true)
}
