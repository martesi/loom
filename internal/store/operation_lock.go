package store

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// repoOperationLocks serializes undo-aware mutations within this process.
// Service RPCs intentionally open short-lived *sql.DB handles, so the lock
// belongs to the canonical repo path rather than to a Repo instance.
var repoOperationLocks sync.Map // map[string]*sync.Mutex

// LockRepoOperations acquires the process-local coordinator for repoPath.
// Callers must defer the returned unlock function immediately. The key is a
// canonical absolute path so relative paths and symlinked spellings of the
// same repository share one coordinator.
func LockRepoOperations(repoPath string) func() {
	key := canonicalRepoPath(repoPath)
	value, _ := repoOperationLocks.LoadOrStore(key, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func canonicalRepoPath(repoPath string) string {
	if canonical, err := CanonicalRepoOperationRoot(repoPath); err == nil {
		return canonical
	}
	abs, err := filepath.Abs(repoPath)
	if err != nil {
		return filepath.Clean(repoPath)
	}
	abs = filepath.Clean(abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved)
	}
	return abs
}

// CanonicalRepoOperationRoot returns the strict identity used by
// LockRepoOperations for an existing repository root. Admission callers must
// fail closed if the root cannot be resolved instead of using the lock's
// fallback spelling for a missing or inaccessible path.
func CanonicalRepoOperationRoot(repoPath string) (string, error) {
	abs, err := filepath.Abs(repoPath)
	if err != nil {
		return "", fmt.Errorf("resolve repository root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(abs))
	if err != nil {
		return "", fmt.Errorf("canonicalize repository root: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("inspect repository root: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("repository root is not a directory")
	}
	return filepath.Clean(resolved), nil
}
