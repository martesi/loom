package service

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"loom/internal/store"
)

type PendingImportResolutionRequest struct {
	BatchID                   string `json:"batchId"`
	RequestID                 string `json:"requestId"`
	SelectedItemIndexes       []int  `json:"selectedItemIndexes"`
	ReleasedItemIndexes       []int  `json:"releasedItemIndexes"`
	ConfirmReservationRelease bool   `json:"confirmReservationRelease"`
	RedoTailConfirmation      string `json:"redoTailConfirmation,omitempty"`
}

type PendingImportResolutionResult struct {
	ImageIDs              []int64 `json:"imageIds"`
	ReleasedItemIndexes   []int   `json:"releasedItemIndexes"`
	NeedsRedoConfirmation bool    `json:"needsRedoConfirmation"`
	RedoTailConfirmation  string  `json:"redoTailConfirmation,omitempty"`
	IdempotentReplay      bool    `json:"idempotentReplay"`
}

type pendingResolutionItem struct {
	Index       int
	Path        string
	Fingerprint string
	X           sql.NullFloat64
	Y           sql.NullFloat64
}

// Tests terminate a child process after all resolution writes but before commit.
var importResolutionCrashHook func(string)

// ResolvePendingImportBatch can import a verified subset and release only
// explicitly confirmed changed or missing reservations. It never modifies
// media files. requestID makes a committed result safe to retry after a lost
// IPC response.
func (s *ImageService) ResolvePendingImportBatch(repoPath string, request PendingImportResolutionRequest) (*PendingImportResolutionResult, error) {
	selected, err := uniqueSortedIndexes(request.SelectedItemIndexes)
	if err != nil {
		return nil, fmt.Errorf("selected item indexes: %w", err)
	}
	released, err := uniqueSortedIndexes(request.ReleasedItemIndexes)
	if err != nil {
		return nil, fmt.Errorf("released item indexes: %w", err)
	}
	if strings.TrimSpace(request.RequestID) == "" || len(request.RequestID) > 128 || strings.TrimSpace(request.BatchID) == "" || len(request.BatchID) > 128 || len(selected)+len(released) == 0 {
		return nil, fmt.Errorf("request ID, batch ID, and at least one selected or released item are required")
	}
	if len(released) > 0 && !request.ConfirmReservationRelease {
		return nil, fmt.Errorf("reservation release requires explicit confirmation")
	}
	for _, index := range selected {
		if containsIndex(released, index) {
			return nil, fmt.Errorf("item index %d cannot be both imported and released", index)
		}
	}
	actionHash := hashPendingResolution(request.BatchID, selected, released, request.ConfirmReservationRelease)

	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	if len(selected) > 0 {
		if err := repo.PrepareOperationLog(); err != nil {
			return nil, err
		}
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return nil, fmt.Errorf("lock pending import resolution: %w", err)
	}

	if prior, priorHash, err := pendingResolutionReceipt(tx, request.RequestID); err != nil {
		return nil, err
	} else if prior != nil {
		if priorHash != actionHash {
			return nil, fmt.Errorf("request ID was already used for a different resolution")
		}
		prior.IdempotentReplay = true
		return prior, nil
	}

	items, err := loadPendingResolutionItems(tx, request.BatchID)
	if err != nil {
		return nil, err
	}
	byIndex := make(map[int]pendingResolutionItem, len(items))
	for _, item := range items {
		byIndex[item.Index] = item
	}
	for _, index := range selected {
		item, ok := byIndex[index]
		if !ok {
			return nil, fmt.Errorf("pending item %d is no longer reserved", index)
		}
		evidence, _ := inspectImportEvidence(repo.Path, item.Path, item.Fingerprint, true)
		if evidence.Status != ImportStatusVerified {
			return nil, fmt.Errorf("pending item %d cannot be imported: status=%s current=%s error=%s", index, evidence.Status, evidence.CurrentFingerprint, evidence.Error)
		}
		var alreadyRegistered bool
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM images WHERE file_path=?)`, item.Path).Scan(&alreadyRegistered); err != nil {
			return nil, err
		}
		if alreadyRegistered {
			return nil, fmt.Errorf("pending item %d path is already registered; reservation remains", index)
		}
	}
	for _, index := range released {
		item, ok := byIndex[index]
		if !ok {
			return nil, fmt.Errorf("pending item %d is no longer reserved", index)
		}
		evidence, _ := inspectImportEvidence(repo.Path, item.Path, item.Fingerprint, true)
		if evidence.Status != ImportStatusMissing && evidence.Status != ImportStatusChanged {
			return nil, fmt.Errorf("pending item %d cannot be released: status=%s error=%s", index, evidence.Status, evidence.Error)
		}
	}

	result := &PendingImportResolutionResult{ReleasedItemIndexes: released}
	if len(selected) > 0 {
		cursor, tailHash, hasTail, err := redoTailSnapshot(tx)
		if err != nil {
			return nil, err
		}
		confirmation := pendingRedoConfirmation(repo.Path, request, actionHash, cursor, tailHash)
		if hasTail && request.RedoTailConfirmation == "" {
			return &PendingImportResolutionResult{
				NeedsRedoConfirmation: true,
				RedoTailConfirmation:  confirmation,
			}, nil
		}
		if hasTail && request.RedoTailConfirmation != confirmation {
			return nil, fmt.Errorf("redo-tail confirmation is stale; refresh the recovery list and confirm again")
		}
		if !hasTail && request.RedoTailConfirmation != "" {
			return nil, fmt.Errorf("redo-tail confirmation is stale; refresh the recovery list and confirm again")
		}
		result.ImageIDs, err = createResolvedPendingImports(repo, tx, items, selected)
		if err != nil {
			return nil, err
		}
		result.IdempotentReplay = false
		previousCursor, err := recordResolvedImportHistory(repo, tx, items, selected, result.ImageIDs)
		if err != nil {
			return nil, err
		}
		if err := deleteResolvedPendingItems(tx, request.BatchID, append(append([]int(nil), selected...), released...)); err != nil {
			return nil, err
		}
		if err := insertPendingResolutionReceipt(tx, request.RequestID, actionHash, result); err != nil {
			return nil, err
		}
		if importResolutionCrashHook != nil {
			importResolutionCrashHook("before_commit")
		}
		if err := repo.CommitOperation(tx, previousCursor); err != nil {
			return nil, err
		}
		return result, nil
	}

	if err := deleteResolvedPendingItems(tx, request.BatchID, released); err != nil {
		return nil, err
	}
	if err := insertPendingResolutionReceipt(tx, request.RequestID, actionHash, result); err != nil {
		return nil, err
	}
	if importResolutionCrashHook != nil {
		importResolutionCrashHook("before_commit")
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

// ResolveRetainedImport makes a verified retained import visible, or performs
// a separately confirmed show-unverified visibility action without rewriting
// the stored provenance. Both actions are receipt-backed and redo-tail bound.
func uniqueSortedIndexes(indexes []int) ([]int, error) {
	copyOf := append([]int(nil), indexes...)
	sort.Ints(copyOf)
	for index, value := range copyOf {
		if value < 0 || (index > 0 && copyOf[index-1] == value) {
			return nil, fmt.Errorf("invalid or duplicate index %d", value)
		}
	}
	return copyOf, nil
}

func containsIndex(indexes []int, target int) bool {
	index := sort.SearchInts(indexes, target)
	return index < len(indexes) && indexes[index] == target
}

func hashPendingResolution(batchID string, selected, released []int, confirmed bool) string {
	bound := fmt.Sprintf("%q\x00%v\x00%v\x00%t", batchID, selected, released, confirmed)
	digest := sha256.Sum256([]byte(bound))
	return hex.EncodeToString(digest[:])
}

func loadPendingResolutionItems(tx *sql.Tx, batchID string) ([]pendingResolutionItem, error) {
	rows, err := tx.Query(`SELECT item_index,file_path,fingerprint,canvas_x,canvas_y FROM import_intents WHERE batch_id=? ORDER BY item_index`, batchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []pendingResolutionItem
	for rows.Next() {
		var item pendingResolutionItem
		if err := rows.Scan(&item.Index, &item.Path, &item.Fingerprint, &item.X, &item.Y); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("pending import batch %s not found", batchID)
	}
	return items, nil
}

func redoTailSnapshot(tx *sql.Tx) (int64, string, bool, error) {
	cursor, err := transactionUndoCursor(tx)
	if err != nil {
		return 0, "", false, err
	}
	rows, err := tx.Query(`SELECT seq,kind,forward,inverse,created_at FROM operation_log WHERE seq>? ORDER BY seq`, cursor)
	if err != nil {
		return 0, "", false, err
	}
	hash := sha256.New()
	var hasTail bool
	for rows.Next() {
		var seq int64
		var kind, forward, inverse, createdAt string
		if err := rows.Scan(&seq, &kind, &forward, &inverse, &createdAt); err != nil {
			rows.Close()
			return 0, "", false, err
		}
		hasTail = true
		fmt.Fprintf(hash, "%d\x00%s\x00%s\x00%s\x00%s\x00", seq, kind, forward, inverse, createdAt)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, "", false, err
	}
	if err := rows.Close(); err != nil {
		return 0, "", false, err
	}
	return cursor, hex.EncodeToString(hash.Sum(nil)), hasTail, nil
}

func transactionUndoCursor(tx *sql.Tx) (int64, error) {
	var raw string
	err := tx.QueryRow(`SELECT value FROM settings WHERE scope='repo' AND key='undo_cursor'`).Scan(&raw)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	cursor, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid undo cursor: %w", err)
	}
	return cursor, nil
}

func pendingRedoConfirmation(repoPath string, request PendingImportResolutionRequest, actionHash string, cursor int64, tailHash string) string {
	bound := fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%d\x00%s", repoPath, request.RequestID, request.BatchID, actionHash, cursor, tailHash)
	digest := sha256.Sum256([]byte(bound))
	return hex.EncodeToString(digest[:])
}

func createResolvedPendingImports(repo *store.Repo, tx *sql.Tx, items []pendingResolutionItem, selected []int) ([]int64, error) {
	byIndex := make(map[int]pendingResolutionItem, len(items))
	for _, item := range items {
		byIndex[item.Index] = item
	}
	ids := make([]int64, 0, len(selected))
	for _, index := range selected {
		item := byIndex[index]
		evidence, stableInfo := inspectImportEvidence(repo.Path, item.Path, item.Fingerprint, true)
		if evidence.Status != ImportStatusVerified || stableInfo == nil {
			return nil, fmt.Errorf("pending item %d changed during resolution: status=%s error=%s", index, evidence.Status, evidence.Error)
		}
		var x, y any
		if item.X.Valid && item.Y.Valid {
			x, y = item.X.Float64, item.Y.Float64
		}
		marker := fmt.Sprintf("stat:%d:%d", stableInfo.Size(), stableInfo.ModTime().UnixNano())
		inserted, err := tx.Exec(`INSERT INTO images(file_path,canvas_x,canvas_y,file_size,content_hash,source_fingerprint,source_revision) VALUES (?,?,?,?,?,?,1)`, item.Path, x, y, stableInfo.Size(), marker, item.Fingerprint)
		if err != nil {
			return nil, fmt.Errorf("create image for pending item %d: %w", index, err)
		}
		id, err := inserted.LastInsertId()
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`INSERT INTO import_recovery(image_id,file_path,fingerprint) VALUES (?,?,?)`, id, item.Path, item.Fingerprint); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func recordResolvedImportHistory(repo *store.Repo, tx *sql.Tx, items []pendingResolutionItem, selected []int, ids []int64) (int64, error) {
	byIndex := make(map[int]pendingResolutionItem, len(items))
	for _, item := range items {
		byIndex[item.Index] = item
	}
	entries := make([]importHistoryEntry, 0, len(selected))
	for index, itemIndex := range selected {
		item := byIndex[itemIndex]
		entry := importHistoryEntry{ID: ids[index], Path: item.Path, Fingerprint: item.Fingerprint}
		if item.X.Valid && item.Y.Valid {
			x, y := item.X.Float64, item.Y.Float64
			entry.X, entry.Y = &x, &y
		}
		entries = append(entries, entry)
	}
	return recordImportHistory(repo, tx, entries)
}

func deleteResolvedPendingItems(tx *sql.Tx, batchID string, indexes []int) error {
	for _, index := range indexes {
		result, err := tx.Exec(`DELETE FROM import_intents WHERE batch_id=? AND item_index=?`, batchID, index)
		if err != nil {
			return err
		}
		rows, err := result.RowsAffected()
		if err != nil || rows != 1 {
			return fmt.Errorf("pending item %d changed during resolution", index)
		}
	}
	return nil
}

func insertPendingResolutionReceipt(tx *sql.Tx, requestID, requestHash string, result *PendingImportResolutionResult) error {
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO import_resolution_receipts(request_id,request_hash,result_json) VALUES (?,?,?)`, requestID, requestHash, string(resultJSON))
	return err
}

func pendingResolutionReceipt(tx *sql.Tx, requestID string) (*PendingImportResolutionResult, string, error) {
	var requestHash, resultJSON string
	err := tx.QueryRow(`SELECT request_hash,result_json FROM import_resolution_receipts WHERE request_id=?`, requestID).Scan(&requestHash, &resultJSON)
	if err == sql.ErrNoRows {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	var result PendingImportResolutionResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		return nil, "", fmt.Errorf("decode pending resolution receipt: %w", err)
	}
	return &result, requestHash, nil
}
