package service

import (
	"database/sql"
	"errors"
	"fmt"

	"loom/internal/store"
)

func ResolveFilesystemHistoryRecovery(repoPath, requestID, action string) (*UndoResult, error) {
	if action != "retry" && action != "cancel" {
		return nil, fmt.Errorf("filesystem history action must be retry or cancel")
	}
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	ledger, found, err := readFilesystemHistoryLedger(repo.DB, requestID)
	if err != nil {
		return nil, err
	}
	if !found || ledger.repoPath != repo.Path {
		return nil, fmt.Errorf("filesystem history recovery ledger not found")
	}
	release, ok := acquireReplacementImageLock(repo.Path, ledger.imageID)
	if !ok {
		return filesystemPendingResult(requestID, ledger.operationKind, "The affected image is busy in a preview or replacement."), nil
	}
	defer release()
	unlockRendition := lockRenditionRepositoryRead(repo.Path)
	defer unlockRendition()
	return advanceFilesystemHistory(repo, ledger, action)
}

func (s *ImageService) ListPendingFilesystemHistoryRecoveries(repoPath string) ([]FilesystemHistoryRecovery, error) {
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	rows, err := repo.DB.Query(`SELECT request_id,direction,selected_seq,COALESCE(selected_kind,'unknown')
		FROM history_replay_requests WHERE state='pending' AND selected_kind IN ('move_file','set_trashed')
		ORDER BY created_at,request_id`)
	if err != nil {
		return nil, err
	}
	var recoveries []FilesystemHistoryRecovery
	for rows.Next() {
		var item FilesystemHistoryRecovery
		if err := rows.Scan(&item.RequestID, &item.Direction, &item.Sequence, &item.Kind); err != nil {
			rows.Close()
			return nil, err
		}
		recoveries = append(recoveries, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range recoveries {
		item := &recoveries[index]
		ledger, found, err := readFilesystemHistoryLedger(repo.DB, item.RequestID)
		if err != nil {
			return nil, err
		}
		if !found {
			item.LegacyWithoutLog = true
			item.State = "legacy-needs-inspection"
			item.Message = "This pending request predates the filesystem evidence ledger. Its exact chosen destination and source identity were not recorded. Automatic retry and cancellation are disabled; inspect the operation and repository paths manually."
			continue
		}
		item.ImageID = ledger.imageID
		item.SourcePath = ledger.sourcePath
		item.DestinationPath = ledger.destinationPath
		release, ok := acquireReplacementImageLock(repo.Path, ledger.imageID)
		if !ok {
			item.State = "busy"
			item.Message = "The affected image is busy in a preview or replacement."
			continue
		}
		unlockRendition := lockRenditionRepositoryRead(repo.Path)
		layout, inspectErr := inspectFilesystemHistory(repo, ledger)
		unlockRendition()
		release()
		if inspectErr != nil || layout == filesystemUnsafe {
			item.State = "needs-inspection"
			item.Message = "The recorded paths, object identity, full SHA-256, row, or cursor do not match. Loom will not move or delete either path."
			continue
		}
		item.State = string(layout)
		item.CanRetry = true
		item.CanCancel = layout == filesystemSourceOnly
		item.Message = filesystemRecoveryMessage(layout)
	}
	return recoveries, nil
}

func filesystemRecoveryMessage(layout filesystemLayout) string {
	switch layout {
	case filesystemSourceOnly:
		return "The original source object and bytes are verified; the recorded destination is absent. You can retry the no-replace move or cancel without changing the cursor."
	case filesystemLinked:
		return "Both paths are verified as the same recorded object and bytes. Retry will unlink only the source and finish the guarded database update."
	case filesystemDestinationOnly:
		return "The source is absent and the destination is the verified recorded object. Retry will finish the guarded database update."
	default:
		return "Inspect the filesystem history evidence."
	}
}

func pendingFilesystemHistory(repo *store.Repo) (string, string, error) {
	var requestID, kind string
	err := repo.DB.QueryRow(`SELECT request_id,COALESCE(selected_kind,'unknown') FROM history_replay_requests
		WHERE state='pending' AND selected_kind IN ('move_file','set_trashed')
		ORDER BY created_at,request_id LIMIT 1`).Scan(&requestID, &kind)
	if err == sql.ErrNoRows {
		return "", "", nil
	}
	return requestID, kind, err
}

func coordinateRepositoryRecovery(repo *store.Repo) error {
	requestID, kind, err := pendingFilesystemHistory(repo)
	if err != nil {
		return err
	}
	if requestID != "" {
		ledger, found, err := readFilesystemHistoryLedger(repo.DB, requestID)
		if err != nil {
			return err
		}
		if !found {
			return &filesystemHistoryPendingError{RequestID: requestID,
				Message: fmt.Sprintf("History request %s for %s predates the filesystem evidence ledger. Its destination and source identity are unknown; inspect it manually. No automatic replacement recovery was run.", requestID, kind)}
		}
		release, ok := acquireReplacementImageLock(repo.Path, ledger.imageID)
		if !ok {
			return &filesystemHistoryPendingError{RequestID: requestID, Message: "Filesystem history recovery is waiting for the affected image lease."}
		}
		unlockRendition := lockRenditionRepositoryRead(repo.Path)
		result, recoverErr := advanceFilesystemHistory(repo, ledger, "automatic")
		unlockRendition()
		release()
		if recoverErr != nil {
			return recoverErr
		}
		if result == nil || result.PendingRecovery {
			message := "Filesystem history recovery remains pending inspection."
			if result != nil && result.Error != "" {
				message = result.Error
			}
			return &filesystemHistoryPendingError{RequestID: requestID, Message: message}
		}
	}
	return recoverReplacementJournalsOnly(repo)
}

func (s *ImageService) RetryFilesystemHistoryRecovery(repoPath, requestID string) (*UndoResult, error) {
	return ResolveFilesystemHistoryRecovery(repoPath, requestID, "retry")
}

func (s *ImageService) CancelFilesystemHistoryRecovery(repoPath, requestID string) (*UndoResult, error) {
	return ResolveFilesystemHistoryRecovery(repoPath, requestID, "cancel")
}

func isFilesystemHistoryPending(err error) bool {
	var pending *filesystemHistoryPendingError
	return errors.As(err, &pending)
}
