package service

import "loom/internal/store"

func removeOwnedImportFile(path, identity string) (bool, error) {
	return store.RemoveFileByIdentity(path, identity)
}
