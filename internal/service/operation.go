package service

import (
	"errors"
	"loom/internal/store"
)

// openOperationRepo establishes the per-repository coordinator before opening
// the database. Every undo-aware mutation keeps this lock until its state
// change and operation-log append (or compensation) have both completed.
func openOperationRepo(repoPath string) (*store.Repo, func(), error) {
	unlock := store.LockRepoOperations(repoPath)
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		unlock()
		return nil, nil, err
	}
	// An unresolved external Move rolls back independently of ordinary
	// repository reads; its durable record keeps affected paths hidden.
	if err := recoverImportIntents(repo); err != nil && !errors.Is(err, errImportMoveRecoveryDeferred) {
		_ = repo.Close()
		unlock()
		return nil, nil, err
	}
	if err := repo.RetireImportHistoryBeforeSession(); err != nil {
		_ = repo.Close()
		unlock()
		return nil, nil, err
	}
	if err := finishImportCleanup(repo); err != nil {
		_ = repo.Close()
		unlock()
		return nil, nil, err
	}
	return repo, unlock, nil
}
