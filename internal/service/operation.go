package service

import "loom/internal/store"

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
	return repo, unlock, nil
}
