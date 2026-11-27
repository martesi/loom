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
	var transfer importTransfer
	return publishPreparedStage(repo, batchID, ordinal, anchorPath, targetPath, identity, hash, &transfer, os.Link)
}

func publishPreparedStage(repo *store.Repo, batchID string, ordinal int, source, target, identity, hash string, transfer *importTransfer, hardlink func(string, string) error) (string, error) {
	for {
		if !sameOwnedImportFile(source, identity, hash) {
			return target, fmt.Errorf("staged import %q changed before publication", filepath.Base(source))
		}
		var err error
		if transfer.Kind == "" {
			err = hardlink(source, target)
			if err != nil && !os.IsExist(err) && linkCapabilityError(err) {
				transfer.Kind = transferRename
				if dbErr := setImportTransfer(repo, batchID, ordinal, *transfer); dbErr != nil {
					return target, errors.Join(err, dbErr)
				}
				err = renameOwnedImportEntry(source, target, identity, hash)
			}
		} else {
			err = renameOwnedImportEntry(source, target, identity, hash)
		}
		if err == nil {
			return target, nil
		}
		if !os.IsExist(err) {
			return target, fmt.Errorf("publish import %q: %w", filepath.Base(target), err)
		}
		target, err = nextImportPath(repo.Path, filepath.Base(target), nil)
		if err != nil {
			return target, err
		}
		if _, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET target_path = ? WHERE batch_id = ? AND ordinal = ?`, target, batchID, ordinal); err != nil {
			return target, err
		}
	}
}

func createImportLinkStage(repo *store.Repo, batchID string, ordinal int, source nativeImportSource, anchor, sourceHash string) (string, string, error) {
	if !sameOwnedImportFile(source.path, source.identity, sourceHash) {
		return "", "", fmt.Errorf("link source changed; left untouched")
	}
	if err := stageSourceLink(source.path, anchor, os.Symlink, os.Link); err != nil {
		return "", "", err
	}
	info, err := os.Lstat(anchor)
	if err != nil {
		return "", "", err
	}
	identity := store.FileIdentityAt(anchor, info)
	if identity == "" {
		return "", "", fmt.Errorf("link has no verifiable identity")
	}
	digest, err := importEntryDigest(anchor, info)
	if err != nil {
		return "", "", err
	}
	if info.Mode().IsRegular() && (identity != source.identity || digest != sourceHash) {
		return "", "", fmt.Errorf("hard link source changed during import")
	}
	return identity, digest, markImportStageComplete(repo, batchID, ordinal, identity, digest)
}

func stageSourceLink(source, anchor string, symlink, hardlink func(string, string) error) error {
	if err := symlink(source, anchor); err != nil {
		if !linkCapabilityError(err) {
			return fmt.Errorf("create symbolic import link: %w", err)
		}
		if hardErr := hardlink(source, anchor); hardErr != nil {
			return fmt.Errorf("neither symbolic nor hard import links are available: %w", errors.Join(err, hardErr))
		}
	}
	return nil
}
