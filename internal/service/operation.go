package service

import (
	"database/sql"
	"fmt"

	"loom/internal/store"
)

// openOperationRepo establishes the per-repository coordinator before opening
// the database. Every undo-aware mutation keeps this lock until its state
// change and operation-log append (or compensation) have both completed.
func openOperationRepo(repoPath string) (*store.Repo, func(), error) {
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, nil, err
	}
	if err := recoverReplacementJournals(repo); err != nil {
		repo.Close()
		unlock()
		return nil, nil, err
	}
	if err := rejectPendingHistoryReplay(repo); err != nil {
		repo.Close()
		unlock()
		return nil, nil, err
	}
	return repo, unlock, nil
}

func rejectPendingHistoryReplay(repo *store.Repo) error {
	var reservedID, kind string
	err := repo.DB.QueryRow(`SELECT request_id,COALESCE(selected_kind,'history replay') FROM request_id_registry
		WHERE family='history' AND repo_path=? AND state='reserved' ORDER BY created_at,request_id LIMIT 1`, repo.Path).Scan(&reservedID, &kind)
	if err == nil {
		return fmt.Errorf("history replay request %s for %s is reserved; unrelated repository changes are fenced until it is reconciled", reservedID, kind)
	}
	if err != sql.ErrNoRows {
		return err
	}
	requestID, kind, err := pendingHistoryReplay(repo)
	if err == nil {
		if requestID == "" {
			return nil
		}
		return fmt.Errorf("history replay request %s for %s is pending inspection; unrelated repository changes are fenced until it is resolved", requestID, kind)
	}
	return err
}

func pendingHistoryReplay(repo *store.Repo) (string, string, error) {
	var requestID, kind string
	err := repo.DB.QueryRow(`SELECT request_id,COALESCE(selected_kind,'unknown') FROM history_replay_requests
		WHERE state='pending' ORDER BY created_at,request_id LIMIT 1`).Scan(&requestID, &kind)
	if err == sql.ErrNoRows {
		return "", "", nil
	}
	return requestID, kind, err
}

func openOperationRepoRaw(repoPath string) (*store.Repo, func(), error) {
	unlock := store.LockRepoOperations(repoPath)
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		unlock()
		return nil, nil, err
	}
	return repo, unlock, nil
}
