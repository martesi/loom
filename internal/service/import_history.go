package service

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"loom/internal/store"
)

const stepImportBatch = "import_batch"

type importHistoryEntry struct {
	ImageID          int64    `json:"imageId"`
	RetainedPath     string   `json:"retainedPath"`
	SHA256           string   `json:"sha256"`
	FileIdentity     string   `json:"fileIdentity,omitempty"`
	FileIdentities   []string `json:"fileIdentities,omitempty"`
	RetainedIdentity string   `json:"retainedIdentity,omitempty"`
}

type importBatchPayload struct {
	Entries []importHistoryEntry `json:"entries"`
	Active  bool                 `json:"active"`
}

func updateImportHistoryIdentities(raw string, identities map[int64]string) (string, error) {
	var step OpStep
	if err := json.Unmarshal([]byte(raw), &step); err != nil {
		return "", err
	}
	var payload importBatchPayload
	if err := json.Unmarshal(step.Payload, &payload); err != nil {
		return "", err
	}
	for index := range payload.Entries {
		entry := &payload.Entries[index]
		identity := identities[entry.ImageID]
		if identity == "" {
			return "", fmt.Errorf("import image %d has no current file identity", entry.ImageID)
		}
		entry.FileIdentities = appendImportIdentity(entry.FileIdentities, entry.FileIdentity)
		entry.FileIdentities = appendImportIdentity(entry.FileIdentities, identity)
		entry.FileIdentity = identity
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	step.Payload = payloadBytes
	updated, err := json.Marshal(step)
	if err != nil {
		return "", err
	}
	return string(updated), nil
}

func appendImportIdentity(identities []string, identity string) []string {
	if identity == "" {
		return identities
	}
	for _, existing := range identities {
		if existing == identity {
			return identities
		}
	}
	return append(identities, identity)
}

func writeExclusive(path string, data []byte) (os.FileInfo, error) {
	return writeExclusiveMode(path, data, 0o600)
}

func writeExclusiveWithIdentity(path string, data []byte, identityAt func(string, os.FileInfo) string) (os.FileInfo, string, error) {
	return writeExclusiveModeWithIdentity(path, data, 0o600, identityAt)
}

type exclusiveFile interface {
	Stat() (os.FileInfo, error)
	Write([]byte) (int, error)
	Close() error
}

type unverifiedExclusiveFileError struct {
	path  string
	cause error
}

func (e *unverifiedExclusiveFileError) Error() string { return e.cause.Error() }
func (e *unverifiedExclusiveFileError) Unwrap() error { return e.cause }

type exclusiveCleanupFailure struct {
	path  string
	info  os.FileInfo
	hash  string
	cause error
}

func (e *exclusiveCleanupFailure) Error() string { return e.cause.Error() }
func (e *exclusiveCleanupFailure) Unwrap() error { return e.cause }

func writeExclusiveMode(path string, data []byte, mode os.FileMode) (os.FileInfo, error) {
	info, _, err := writeExclusiveModeWithIdentity(path, data, mode, store.FileIdentityAt)
	return info, err
}

func writeExclusiveModeWithIdentity(path string, data []byte, mode os.FileMode, identityAt func(string, os.FileInfo) string) (os.FileInfo, string, error) {
	return writeExclusiveModeUsingWithIdentity(path, data, mode, func(path string, flags int, mode os.FileMode) (exclusiveFile, error) {
		return os.OpenFile(path, flags, mode)
	}, identityAt)
}

func writeExclusiveModeUsing(path string, data []byte, mode os.FileMode, open func(string, int, os.FileMode) (exclusiveFile, error)) (os.FileInfo, error) {
	info, _, err := writeExclusiveModeUsingWithIdentity(path, data, mode, open, store.FileIdentityAt)
	return info, err
}

func writeExclusiveModeUsingWithIdentity(path string, data []byte, mode os.FileMode, open func(string, int, os.FileMode) (exclusiveFile, error), identityAt func(string, os.FileInfo) string) (os.FileInfo, string, error) {
	if _, err := os.Lstat(path); err == nil {
		return nil, "", os.ErrExist
	} else if !os.IsNotExist(err) {
		return nil, "", err
	}
	stageDir := exclusiveStageDirectory(path)
	var stagePath string
	var file exclusiveFile
	for {
		randomName := make([]byte, 16)
		if _, err := rand.Read(randomName); err != nil {
			return nil, "", err
		}
		stagePath = filepath.Join(stageDir, ".loom-import-stage-"+hex.EncodeToString(randomName))
		var err error
		file, err = open(stagePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return nil, "", err
		}
		break
	}
	info, statErr := file.Stat()
	if statErr != nil {
		retryInfo, retryErr := file.Stat()
		_ = file.Close()
		if retryErr == nil {
			remainingHash, currentInfo, verified := ownedFilePrefixHash(stagePath, retryInfo, data)
			if verified {
				return nil, "", &exclusiveCleanupFailure{path: stagePath, info: currentInfo, hash: remainingHash, cause: statErr}
			}
			return nil, "", statErr
		}
		return nil, "", &unverifiedExclusiveFileError{path: stagePath, cause: errors.Join(statErr, retryErr)}
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		remainingHash, currentInfo, verified := ownedFilePrefixHash(stagePath, info, data)
		if verified {
			return nil, "", &exclusiveCleanupFailure{path: stagePath, info: currentInfo, hash: remainingHash, cause: writeErr}
		}
		return nil, "", writeErr
	}
	if closeErr != nil {
		remainingHash, currentInfo, verified := ownedFilePrefixHash(stagePath, info, data)
		if verified {
			return nil, "", &exclusiveCleanupFailure{path: stagePath, info: currentInfo, hash: remainingHash, cause: closeErr}
		}
		return nil, "", closeErr
	}
	stageInfo, err := os.Stat(stagePath)
	if err != nil || !os.SameFile(info, stageInfo) {
		if err == nil {
			err = fmt.Errorf("staged import file changed before publication")
		}
		return nil, "", err
	}
	if identityAt == nil {
		identityAt = store.FileIdentityAt
	}
	identity := identityAt(stagePath, stageInfo)
	if identity == "" {
		cleanupErr := cleanupStageImportFile(stagePath, stageInfo)
		return nil, "", joinImportCleanupError(fmt.Errorf("staged import file %q has no verifiable identity", stagePath), cleanupErr)
	}
	if err := os.Link(stagePath, path); err != nil {
		return nil, "", joinImportCleanupError(err, cleanupStageImportFile(stagePath, stageInfo))
	}
	// Keep this hidden hard link as an ownership anchor. It pins the inode so
	// the OS cannot reuse its device/inode identity after the visible path is
	// deleted or replaced.
	publishedInfo, err := os.Stat(path)
	if err == nil {
		if os.SameFile(info, publishedInfo) && store.FileIdentityAt(path, publishedInfo) == identity {
			// Return metadata from the staged file handle, not a path stat. On
			// Windows the handle stat contains the stable file index; the path
			// stat exposes only Win32FileAttributeData.
			return info, identity, nil
		}
		cause := fmt.Errorf("import destination changed after publication: %s", path)
		return nil, "", cleanupFailedImportPublication(path, stagePath, info, stageInfo, identity, data, cause)
	}
	return nil, "", cleanupFailedImportPublication(path, stagePath, info, stageInfo, identity, data, err)
}

func cleanupStageImportFile(path string, info os.FileInfo) error {
	identity := store.FileIdentityAt(path, info)
	if identity == "" {
		return nil
	}
	_, err := store.RemoveFileByIdentity(path, identity)
	return err
}

func cleanupFailedImportPublication(path, stagePath string, info, stageInfo os.FileInfo, identity string, data []byte, cause error) error {
	_, visibleErr := store.RemoveFileByIdentity(path, identity)
	stageErr := cleanupStageImportFile(stagePath, stageInfo)
	if visibleErr != nil {
		return &exclusiveCleanupFailure{path: path, info: info, hash: fmt.Sprintf("%x", sha256.Sum256(data)), cause: errors.Join(cause, visibleErr, stageErr)}
	}
	return joinImportCleanupError(cause, stageErr)
}

func joinImportCleanupError(cause, cleanupErr error) error {
	if cleanupErr == nil {
		return cause
	}
	return errors.Join(cause, cleanupErr)
}

func exclusiveStageDirectory(path string) string {
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if filepath.Base(dir) == ".loom" {
			return dir
		}
		loomDir := filepath.Join(dir, ".loom")
		if info, err := os.Stat(loomDir); err == nil && info.IsDir() {
			return loomDir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return filepath.Dir(path)
		}
	}
}

// applyImportBatchTx retains all active media and changes only the imported
// rows. A redo rejects a changed file at its original path. If the original
// file is absent, it restores the captured bytes at a new, exclusive path.
type ownedImportFile struct {
	path     string
	info     os.FileInfo
	hash     string
	identity string
}

func applyImportBatchTx(tx *sql.Tx, payload importBatchPayload, created, validate *[]ownedImportFile, afterWrite func(string), writeFile ...func(string, []byte) (os.FileInfo, error)) error {
	if len(payload.Entries) == 0 {
		return fmt.Errorf("import history batch is empty")
	}
	type validatedEntry struct {
		entry       importHistoryEntry
		currentPath string
		data        []byte
	}
	validated := make([]validatedEntry, 0, len(payload.Entries))
	for _, entry := range payload.Entries {
		var currentPath string
		if err := tx.QueryRow(`SELECT file_path FROM images WHERE id = ?`, entry.ImageID).Scan(&currentPath); err != nil {
			if err == sql.ErrNoRows {
				return purgedErr(entry.ImageID)
			}
			return err
		}
		item := validatedEntry{entry: entry, currentPath: currentPath}
		if payload.Active {
			data, info, err := readOwnedImportCopy(entry.RetainedPath, entry.SHA256, entry.RetainedIdentity)
			if err != nil {
				return fmt.Errorf("read retained import bytes for image %d: %w", entry.ImageID, err)
			}
			item.data = data
			*validate = append(*validate, ownedImportFile{path: entry.RetainedPath, info: info, hash: entry.SHA256, identity: entry.RetainedIdentity})
		}
		validated = append(validated, item)
	}
	for _, item := range validated {
		entry, currentPath := item.entry, item.currentPath
		if !payload.Active {
			var importIdentity, importHash string
			if err := tx.QueryRow(`SELECT import_file_identity, import_file_sha256 FROM images WHERE id = ?`, entry.ImageID).Scan(&importIdentity, &importHash); err != nil {
				return err
			}
			if importIdentity == "" || importHash == "" {
				return fmt.Errorf("imported file %d is detached and cannot be undone", entry.ImageID)
			}
			info, err := os.Stat(currentPath)
			if err == nil {
				if !info.Mode().IsRegular() {
					return fmt.Errorf("imported file %d is no longer a regular file", entry.ImageID)
				}
				identity := store.FileIdentityAt(currentPath, info)
				if identity == "" || identity != importIdentity {
					return fmt.Errorf("imported file %d was replaced and cannot be undone", entry.ImageID)
				}
				data, err := os.ReadFile(currentPath)
				if err != nil {
					return fmt.Errorf("read imported file %d before undo: %w", entry.ImageID, err)
				}
				if fmt.Sprintf("%x", sha256.Sum256(data)) != importHash {
					return fmt.Errorf("imported file %d changed and cannot be undone", entry.ImageID)
				}
				*validate = append(*validate, ownedImportFile{path: currentPath, info: info, hash: importHash, identity: importIdentity})
			} else if !os.IsNotExist(err) {
				return fmt.Errorf("inspect imported file %d before undo: %w", entry.ImageID, err)
			}
			if _, err := tx.Exec(`UPDATE images SET trashed = 0, import_undone = 1 WHERE id = ?`, entry.ImageID); err != nil {
				return err
			}
			continue
		}
		var importUndone bool
		if err := tx.QueryRow(`SELECT import_undone FROM images WHERE id = ?`, entry.ImageID).Scan(&importUndone); err != nil {
			return err
		}
		if !importUndone {
			return fmt.Errorf("imported file %d was replaced and cannot be redone", entry.ImageID)
		}
		activePath := currentPath
		var activeInfo os.FileInfo
		activeIdentity := ""
		current, readErr := os.ReadFile(currentPath)
		currentInfo, statErr := os.Stat(currentPath)
		if readErr == nil && statErr == nil {
			identity := store.FileIdentityAt(currentPath, currentInfo)
			if identity == "" || entry.FileIdentity == "" || identity != entry.FileIdentity {
				return fmt.Errorf("imported file %d was replaced and cannot be redone", entry.ImageID)
			}
			if fmt.Sprintf("%x", sha256.Sum256(current)) != entry.SHA256 {
				return fmt.Errorf("imported file %d changed and cannot be redone", entry.ImageID)
			}
			activeInfo = currentInfo
			activeIdentity = identity
		}
		if (readErr != nil && !os.IsNotExist(readErr)) || (statErr != nil && !os.IsNotExist(statErr)) {
			return fmt.Errorf("inspect import path: %w", errors.Join(readErr, statErr))
		}
		if os.IsNotExist(readErr) || os.IsNotExist(statErr) {
			var info os.FileInfo
			var err error
			activePath, info, err = writeRetainedImport(currentPath, item.data, writeFile...)
			if err != nil {
				var cleanupFailure *exclusiveCleanupFailure
				if errors.As(err, &cleanupFailure) {
					*created = append(*created, ownedImportFile{path: cleanupFailure.path, info: cleanupFailure.info, hash: cleanupFailure.hash})
				}
				return err
			}
			activeInfo = info
			activeIdentity = store.FileIdentityAt(activePath, info)
			if activeIdentity == "" {
				return fmt.Errorf("restored import file %d has no verifiable identity", entry.ImageID)
			}
			*created = append(*created, ownedImportFile{path: activePath, info: info, hash: entry.SHA256, identity: activeIdentity})
			if afterWrite != nil {
				afterWrite(activePath)
			}
		}
		if activePath != currentPath {
			if _, err := tx.Exec(`UPDATE images SET file_path = ?, trashed = 0, import_undone = 0, import_file_identity = ?, import_file_sha256 = ?, thumb_path = NULL, width = NULL, height = NULL, file_size = ?, content_hash = NULL, source_fingerprint = NULL, source_revision = source_revision + 1 WHERE id = ?`, activePath, activeIdentity, entry.SHA256, len(item.data), entry.ImageID); err != nil {
				return err
			}
		} else if _, err := tx.Exec(`UPDATE images SET trashed = 0, import_undone = 0 WHERE id = ?`, entry.ImageID); err != nil {
			return err
		}
		*validate = append(*validate, ownedImportFile{path: activePath, info: activeInfo, hash: entry.SHA256, identity: activeIdentity})
	}
	return nil
}

func writeRetainedImport(currentPath string, data []byte, writeFile ...func(string, []byte) (os.FileInfo, error)) (string, os.FileInfo, error) {
	dir := filepath.Dir(currentPath)
	ext := filepath.Ext(currentPath)
	base := strings.TrimSuffix(filepath.Base(currentPath), ext)
	for index := 1; ; index++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s (redo %d)%s", base, index, ext))
		write := func(path string, bytes []byte) (os.FileInfo, error) { return writeExclusive(path, bytes) }
		if len(writeFile) > 0 && writeFile[0] != nil {
			write = writeFile[0]
		}
		if info, err := write(candidate, data); err == nil {
			return candidate, info, nil
		} else if !os.IsExist(err) {
			return "", nil, err
		}
	}
}

func ownedFilePrefixHash(path string, owned os.FileInfo, data []byte) (string, os.FileInfo, bool) {
	current, err := os.Stat(path)
	if err != nil || owned == nil || !os.SameFile(current, owned) {
		return "", nil, false
	}
	onDisk, err := os.ReadFile(path)
	if err != nil || len(onDisk) > len(data) || !bytes.Equal(onDisk, data[:len(onDisk)]) {
		return "", nil, false
	}
	return fmt.Sprintf("%x", sha256.Sum256(onDisk)), current, true
}

func verifyOwnedImportFile(file ownedImportFile) error {
	if file.info == nil || file.identity == "" {
		return fmt.Errorf("import file %q has no verifiable identity", file.path)
	}
	if store.FileIdentityAt(file.path, file.info) != file.identity {
		return fmt.Errorf("import file %q identity differs from recorded identity", file.path)
	}
	before, err := os.Stat(file.path)
	if err != nil {
		return fmt.Errorf("inspect import file %q before commit: %w", file.path, err)
	}
	if !before.Mode().IsRegular() || !os.SameFile(before, file.info) || store.FileIdentityAt(file.path, before) != file.identity {
		return fmt.Errorf("import file %q changed before commit", file.path)
	}
	data, err := os.ReadFile(file.path)
	if err != nil {
		return fmt.Errorf("read import file %q before commit: %w", file.path, err)
	}
	if fmt.Sprintf("%x", sha256.Sum256(data)) != file.hash {
		return fmt.Errorf("import file %q content changed before commit", file.path)
	}
	after, err := os.Stat(file.path)
	if err != nil || !os.SameFile(before, after) || !os.SameFile(after, file.info) || store.FileIdentityAt(file.path, after) != file.identity {
		return fmt.Errorf("import file %q changed during commit validation", file.path)
	}
	return nil
}

func readOwnedImportCopy(path, expectedHash, expectedIdentity string) ([]byte, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	before, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !before.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, fmt.Errorf("retained import copy is not a regular file")
	}
	data, readErr := io.ReadAll(file)
	after, statErr := file.Stat()
	closeErr := file.Close()
	if readErr != nil || statErr != nil || closeErr != nil {
		return nil, nil, errors.Join(readErr, statErr, closeErr)
	}
	pathInfo, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	identity := store.FileIdentityAt(path, after)
	if !os.SameFile(before, after) || !os.SameFile(after, pathInfo) || identity == "" {
		return nil, nil, fmt.Errorf("retained import copy changed while reading")
	}
	if expectedIdentity == "" || identity != expectedIdentity {
		return nil, nil, fmt.Errorf("retained import copy identity changed")
	}
	if fmt.Sprintf("%x", sha256.Sum256(data)) != expectedHash {
		return nil, nil, fmt.Errorf("retained import copy content changed")
	}
	return data, after, nil
}
