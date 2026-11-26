package service

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"loom/internal/store"
)

func newImportBatchID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func nextImportPath(root, name string, reserved map[string]struct{}) (string, error) {
	for n := 0; ; n++ {
		candidate := name
		if n > 0 {
			ext := filepath.Ext(name)
			candidate = fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, ext), n, ext)
		}
		path := filepath.Join(root, candidate)
		if _, exists := reserved[path]; exists {
			continue
		}
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			return path, nil
		} else if err != nil {
			return "", err
		}
	}
}

func createImportIntent(repo *store.Repo, batchID string, items []ClipboardMedia, targets, anchors, checksums []string) error {
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO import_batch_intents(batch_id, action) VALUES (?, 'publish')`, batchID); err != nil {
		return err
	}
	for i := range items {
		if _, err := tx.Exec(`INSERT INTO import_batch_intent_files(batch_id, ordinal, target_path, anchor_path, sha256) VALUES (?, ?, ?, ?, ?)`, batchID, i, targets[i], anchors[i], checksums[i]); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func writeImportStage(repo *store.Repo, batchID string, ordinal int, path string, data []byte, wantHash string) (string, error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", err
	}
	info, statErr := file.Stat()
	if statErr != nil {
		return "", errors.Join(statErr, file.Close())
	}
	identity := store.FileIdentityAt(path, info)
	if identity == "" {
		return "", errors.Join(fmt.Errorf("staged import %q has no verifiable file identity", filepath.Base(path)), file.Close())
	}
	if _, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET file_identity = ? WHERE batch_id = ? AND ordinal = ?`, identity, batchID, ordinal); err != nil {
		return "", errors.Join(err, file.Close())
	}
	written, writeErr := io.Copy(file, bytes.NewReader(data))
	if writeErr == nil && written != int64(len(data)) {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	err = errors.Join(statErr, writeErr, closeErr)
	if err != nil {
		return identity, err
	}
	if !sameOwnedImportFile(path, identity, wantHash) {
		return identity, fmt.Errorf("staged import %q failed byte verification", filepath.Base(path))
	}
	if _, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET stage_complete = 1 WHERE batch_id = ? AND ordinal = ? AND file_identity = ?`, batchID, ordinal, identity); err != nil {
		return identity, err
	}
	return identity, nil
}

func publishImportStage(repo *store.Repo, batchID string, ordinal int, anchorPath, targetPath, identity, hash string) (string, error) {
	for {
		if !sameOwnedImportFile(anchorPath, identity, hash) {
			return targetPath, fmt.Errorf("staged import %q changed before publication", filepath.Base(anchorPath))
		}
		if err := os.Link(anchorPath, targetPath); err == nil {
			return targetPath, nil
		} else if !os.IsExist(err) {
			return targetPath, fmt.Errorf("publish import %q: %w", filepath.Base(targetPath), err)
		}
		nextTarget, err := nextImportPath(repo.Path, filepath.Base(targetPath), nil)
		if err != nil {
			return targetPath, err
		}
		targetPath = nextTarget
		if _, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET target_path = ? WHERE batch_id = ? AND ordinal = ?`, targetPath, batchID, ordinal); err != nil {
			return targetPath, err
		}
		if _, err := os.Stat(anchorPath); err != nil {
			return targetPath, err
		}
		if got, err := hashImportFile(anchorPath); err != nil || got != hash {
			return targetPath, fmt.Errorf("staged import %q changed before publication", filepath.Base(anchorPath))
		}
	}
}
