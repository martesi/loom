package service

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"loom/internal/store"
)

type trashedBatchEntry struct {
	ImageID       int64   `json:"imageId"`
	FromPath      string  `json:"fromPath"`
	ToPath        string  `json:"toPath"`
	FromTrashed   bool    `json:"fromTrashed"`
	ToTrashed     bool    `json:"toTrashed"`
	FromTrashedAt *string `json:"fromTrashedAt"`
	ToTrashedAt   *string `json:"toTrashedAt"`
	MoveFile      bool    `json:"moveFile"`
}

type trashedBatchPayload struct {
	Entries []trashedBatchEntry `json:"entries"`
}

// TrashImages atomically trashes all requested active images as one history
// entry. Already-trashed targets are preflighted but do not enter the entry.
func (s *ImageService) TrashImages(repoPath string, imageIDs []int64) error {
	return s.setImagesTrashed(repoPath, imageIDs, true)
}

// RestoreImages atomically restores all requested trashed images as one
// history entry. Already-active targets are preflighted but do not enter it.
func (s *ImageService) RestoreImages(repoPath string, imageIDs []int64) error {
	return s.setImagesTrashed(repoPath, imageIDs, false)
}

func (s *ImageService) setImagesTrashed(repoPath string, imageIDs []int64, trashed bool) error {
	ids := uniqueImageIDs(imageIDs)
	if len(ids) == 0 {
		return nil
	}
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
		return fmt.Errorf("begin batch trash transaction: %w", err)
	}
	// Take SQLite's writer reservation before preflight so another connection
	// cannot change rows between planning, file moves and the DB update.
	if _, err := tx.Exec(`UPDATE images SET id = id WHERE 0`); err != nil {
		return abortTrashedBatch(tx, nil, fmt.Errorf("lock batch trash transaction: %w", err))
	}
	entries, err := planTrashedBatch(tx, repo.Path, ids, trashed)
	if err != nil {
		return abortTrashedBatch(tx, nil, err)
	}
	if len(entries) == 0 {
		return tx.Rollback()
	}
	moves := trashedBatchMoves(entries)
	if err := store.MoveFilesWithoutReplace(moves); err != nil {
		return abortTrashedBatch(tx, nil, err)
	}
	if err := applyTrashedBatchRows(tx, entries); err != nil {
		return abortTrashedBatch(tx, moves, fmt.Errorf("update batch trash state: %w", err))
	}
	forward := step(stepSetTrashedBatch, trashedBatchPayload{Entries: entries})
	inverse := step(stepSetTrashedBatch, trashedBatchPayload{Entries: reverseTrashedBatch(entries)})
	forwardJSON, err := json.Marshal(forward)
	if err != nil {
		return abortTrashedBatch(tx, moves, fmt.Errorf("encode batch trash history: %w", err))
	}
	inverseJSON, err := json.Marshal(inverse)
	if err != nil {
		return abortTrashedBatch(tx, moves, fmt.Errorf("encode inverse batch trash history: %w", err))
	}
	if err := repo.RecordOperationInTx(tx, stepSetTrashedBatch, string(forwardJSON), string(inverseJSON)); err != nil {
		return abortTrashedBatch(tx, moves, fmt.Errorf("record batch trash history: %w", err))
	}
	if err := tx.Commit(); err != nil {
		return compensateTrashedBatch(moves, fmt.Errorf("commit batch trash transaction: %w", err))
	}
	return nil
}

func planTrashedBatch(tx *sql.Tx, repoPath string, ids []int64, target bool) ([]trashedBatchEntry, error) {
	entries := make([]trashedBatchEntry, 0, len(ids))
	reserved := make(map[string]int64, len(ids))
	for _, id := range ids {
		var entry trashedBatchEntry
		var timestamp sql.NullString
		if err := tx.QueryRow(`SELECT file_path, trashed, trashed_at FROM images WHERE id = ?`, id).
			Scan(&entry.FromPath, &entry.FromTrashed, &timestamp); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, fmt.Errorf("image %d does not exist", id)
			}
			return nil, fmt.Errorf("preflight image %d for trash: %w", id, err)
		}
		if timestamp.Valid {
			value := timestamp.String
			entry.FromTrashedAt = &value
		}
		entry.ImageID = id
		entry.ToPath = targetBasePath(repoPath, entry.FromPath, target)
		reserved[entry.ToPath] = id
		entries = append(entries, entry)
	}
	planned := entries[:0]
	allocated := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry.FromTrashed == target {
			continue
		}
		entry.ToTrashed = target
		entry.ToTrashedAt = targetTrashedAt(entry.FromTrashedAt, target)
		toPath, moveFile, err := plannedTrashedPath(repoPath, entry.FromPath, target, entry.ImageID, reserved, allocated)
		if err != nil {
			return nil, fmt.Errorf("preflight image %d file move: %w", entry.ImageID, err)
		}
		entry.ToPath = toPath
		entry.MoveFile = moveFile
		planned = append(planned, entry)
		allocated[toPath] = struct{}{}
	}
	return planned, nil
}

func targetTrashedAt(from *string, target bool) *string {
	if !target {
		return nil
	}
	if from != nil {
		value := *from
		return &value
	}
	value := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	return &value
}

func plannedTrashedPath(repoPath, currentPath string, target bool, imageID int64, reserved map[string]int64, allocated map[string]struct{}) (string, bool, error) {
	trashRoot := filepath.Join(repoPath, ".loom", "trash")
	candidate := targetBasePath(repoPath, currentPath, target)
	if candidate == currentPath {
		return currentPath, false, nil
	}
	info, exists, err := inspectTrashedSource(repoPath, trashRoot, currentPath)
	if err != nil {
		return "", false, err
	}
	if !exists {
		// Keep legacy flag-only behavior for a file deleted outside Loom. Do
		// not infer that other stat errors mean the file is missing.
		return currentPath, false, nil
	}
	if info.IsDir() {
		return "", false, fmt.Errorf("file path %q is a directory", currentPath)
	}
	available, err := nextUnoccupiedBatchPath(candidate, imageID, reserved, allocated)
	if err != nil {
		return "", false, err
	}
	return available, true, nil
}

func targetBasePath(repoPath, currentPath string, target bool) string {
	trashRoot := filepath.Join(repoPath, ".loom", "trash")
	if target {
		if isPathInside(trashRoot, currentPath) {
			return currentPath
		}
		rel, ok := pathRelativeInside(repoPath, currentPath)
		if !ok {
			return currentPath
		}
		return filepath.Join(trashRoot, rel)
	}
	rel, ok := pathRelativeInside(trashRoot, currentPath)
	if !ok {
		return currentPath
	}
	return filepath.Join(repoPath, rel)
}

func inspectTrashedSource(repoPath, trashRoot, path string) (os.FileInfo, bool, error) {
	root := repoPath
	rel, ok := pathRelativeInside(repoPath, path)
	if !ok {
		root = trashRoot
		rel, ok = pathRelativeInside(trashRoot, path)
	}
	if !ok {
		return nil, false, fmt.Errorf("file path %q is outside the repository", path)
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return nil, false, fmt.Errorf("inspect repository path %q: %w", root, err)
	}
	if !rootInfo.IsDir() {
		return nil, false, fmt.Errorf("repository path %q is not a directory", root)
	}
	parent := filepath.Dir(rel)
	if parent != "." {
		current := root
		for _, component := range strings.Split(parent, string(filepath.Separator)) {
			current = filepath.Join(current, component)
			info, err := os.Stat(current)
			if os.IsNotExist(err) {
				return nil, false, nil
			}
			if err != nil {
				return nil, false, fmt.Errorf("inspect file parent %q: %w", current, err)
			}
			if !info.IsDir() {
				return nil, false, fmt.Errorf("file parent %q is not a directory", current)
			}
		}
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return info, true, nil
}

func nextUnoccupiedBatchPath(path string, imageID int64, reserved map[string]int64, allocated map[string]struct{}) (string, error) {
	for suffix := 0; ; suffix++ {
		candidate := path
		if suffix > 0 {
			ext := filepath.Ext(path)
			base := strings.TrimSuffix(filepath.Base(path), ext)
			candidate = filepath.Join(filepath.Dir(path), fmt.Sprintf("%s (%d)%s", base, suffix, ext))
		}
		if owner, exists := reserved[candidate]; exists && owner != imageID {
			continue
		}
		if _, exists := allocated[candidate]; exists {
			continue
		}
		_, err := os.Lstat(candidate)
		if os.IsNotExist(err) {
			return candidate, nil
		}
		if err != nil {
			return "", err
		}
	}
}

func isPathInside(root, path string) bool {
	_, ok := pathRelativeInside(root, path)
	return ok
}

func pathRelativeInside(root, path string) (string, bool) {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

func applyTrashedBatchRows(tx *sql.Tx, entries []trashedBatchEntry) error {
	for _, entry := range entries {
		result, err := tx.Exec(`UPDATE images SET file_path = ?, trashed = ?, trashed_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE id = ? AND file_path = ? AND trashed = ? AND trashed_at IS ?`,
			entry.ToPath, entry.ToTrashed, nullableTrashTimestamp(entry.ToTrashedAt), entry.ImageID,
			entry.FromPath, entry.FromTrashed, nullableTrashTimestamp(entry.FromTrashedAt))
		if err != nil {
			return err
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if rows != 1 {
			return fmt.Errorf("image %d changed during batch trash", entry.ImageID)
		}
	}
	return nil
}

func applyTrashedBatchTx(repoPath string, tx *sql.Tx, raw json.RawMessage) ([]store.FileMove, error) {
	var payload trashedBatchPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("decode batch trash history: %w", err)
	}
	if len(payload.Entries) == 0 {
		return nil, fmt.Errorf("batch trash history has no entries")
	}
	seen := make(map[int64]struct{}, len(payload.Entries))
	for _, entry := range payload.Entries {
		if _, ok := seen[entry.ImageID]; ok {
			return nil, fmt.Errorf("batch trash history repeats image %d", entry.ImageID)
		}
		seen[entry.ImageID] = struct{}{}
		if entry.MoveFile {
			if entry.FromPath == entry.ToPath || !isPathInside(repoPath, entry.FromPath) || !isPathInside(repoPath, entry.ToPath) {
				return nil, fmt.Errorf("invalid batch trash paths for image %d", entry.ImageID)
			}
		} else if entry.FromPath != entry.ToPath {
			return nil, fmt.Errorf("invalid flag-only batch trash paths for image %d", entry.ImageID)
		}
		var currentPath string
		var currentTrashed bool
		var currentTimestamp sql.NullString
		err := tx.QueryRow(`SELECT file_path, trashed, trashed_at FROM images WHERE id = ?`, entry.ImageID).
			Scan(&currentPath, &currentTrashed, &currentTimestamp)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, purgedErr(entry.ImageID)
		}
		if err != nil {
			return nil, fmt.Errorf("check replay state for image %d: %w", entry.ImageID, err)
		}
		if currentPath != entry.FromPath || currentTrashed != entry.FromTrashed || !equalNullableTimestamp(currentTimestamp, entry.FromTrashedAt) {
			return nil, fmt.Errorf("can't replay batch trash: image %d changed since history was recorded", entry.ImageID)
		}
	}
	moves := trashedBatchMoves(payload.Entries)
	if err := store.MoveFilesWithoutReplace(moves); err != nil {
		return nil, err
	}
	if err := applyTrashedBatchRows(tx, payload.Entries); err != nil {
		return nil, errors.Join(fmt.Errorf("replay batch trash state: %w", err), store.RollbackFileMoves(moves))
	}
	return moves, nil
}

func equalNullableTimestamp(value sql.NullString, expected *string) bool {
	if value.Valid != (expected != nil) {
		return false
	}
	return !value.Valid || value.String == *expected
}

func nullableTrashTimestamp(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func reverseTrashedBatch(entries []trashedBatchEntry) []trashedBatchEntry {
	reversed := make([]trashedBatchEntry, len(entries))
	for i, entry := range entries {
		reversed[i] = trashedBatchEntry{
			ImageID:       entry.ImageID,
			FromPath:      entry.ToPath,
			ToPath:        entry.FromPath,
			FromTrashed:   entry.ToTrashed,
			ToTrashed:     entry.FromTrashed,
			FromTrashedAt: entry.ToTrashedAt,
			ToTrashedAt:   entry.FromTrashedAt,
			MoveFile:      entry.MoveFile,
		}
	}
	return reversed
}

func trashedBatchMoves(entries []trashedBatchEntry) []store.FileMove {
	moves := make([]store.FileMove, 0, len(entries))
	for _, entry := range entries {
		if entry.MoveFile {
			moves = append(moves, store.FileMove{Source: entry.FromPath, Destination: entry.ToPath})
		}
	}
	return moves
}

func abortTrashedBatch(tx *sql.Tx, moves []store.FileMove, cause error) error {
	rollbackErr := tx.Rollback()
	if errors.Is(rollbackErr, sql.ErrTxDone) {
		rollbackErr = nil
	}
	return errors.Join(cause, wrapTrashError("rollback batch trash transaction", rollbackErr), store.RollbackFileMoves(moves))
}

func compensateTrashedBatch(moves []store.FileMove, cause error) error {
	if err := store.RollbackFileMoves(moves); err != nil {
		return errors.Join(cause, fmt.Errorf("filesystem compensation failed: %w", err))
	}
	return cause
}

func wrapTrashError(message string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", message, err)
}
