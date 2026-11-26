package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/store"
)

func removeOwnedImportFile(path, identity string) (bool, error) {
	if identity == "" {
		return false, nil
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || store.FileIdentityAt(path, info) != identity {
		return false, nil
	}
	quarantine, err := cleanupQuarantinePath(filepath.Dir(path))
	if err != nil {
		return false, err
	}
	if err := os.Rename(path, quarantine); err != nil {
		return false, err
	}
	quarantinedInfo, err := os.Lstat(quarantine)
	owned := err == nil && quarantinedInfo.Mode().IsRegular() && store.FileIdentityAt(quarantine, quarantinedInfo) == identity
	if err != nil {
		return false, restoreQuarantinedFile(quarantine, path, err)
	}
	if !owned {
		return false, restoreQuarantinedFile(quarantine, path, nil)
	}
	if err := os.Remove(quarantine); err != nil {
		return false, err
	}
	return true, nil
}

func cleanupQuarantinePath(dir string) (string, error) {
	file, err := os.CreateTemp(dir, ".loom-import-cleanup-*")
	if err != nil {
		return "", err
	}
	path := file.Name()
	closeErr := file.Close()
	removeErr := os.Remove(path)
	if closeErr != nil || removeErr != nil {
		return "", fmt.Errorf("prepare import cleanup path: %w", errors.Join(closeErr, removeErr))
	}
	return path, nil
}

func restoreQuarantinedFile(quarantine, original string, cause error) error {
	if err := os.Link(quarantine, original); err != nil {
		return fmt.Errorf("preserve moved file at %q after cleanup verification: %w", quarantine, errors.Join(cause, err))
	}
	if err := os.Remove(quarantine); err != nil {
		return fmt.Errorf("remove quarantine link %q: %w", quarantine, err)
	}
	return cause
}
