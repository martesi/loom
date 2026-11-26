package service

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"loom/internal/store"
	"os"
	"strconv"
)

type discardedImportFile struct {
	path     string
	hash     string
	identity string
}

type discardedImportRedo struct {
	active   []discardedImportFile
	retained []discardedImportFile
	released []string
}

func recordOperationInTx(repo *store.Repo, tx *sql.Tx, kind, forward, inverse string) (discardedImportRedo, error) {
	discarded, err := pruneUndoneImportRedoTx(tx)
	if err != nil {
		return discarded, err
	}
	if err := repo.RecordOperationInTx(tx, kind, forward, inverse); err != nil {
		return discarded, err
	}
	return discarded, nil
}

// pruneUndoneImportRedoTx removes hidden import rows whose redo operations are
// about to be discarded. It retains an identity tombstone for the still-present
// visible file and queues the now-unreferenced retained copy for cleanup.
func pruneUndoneImportRedoTx(tx *sql.Tx) (discardedImportRedo, error) {
	result := discardedImportRedo{}
	var cursor int64
	var rawCursor string
	err := tx.QueryRow(`SELECT value FROM settings WHERE scope = 'repo' AND key = 'undo_cursor'`).Scan(&rawCursor)
	if err != nil && err != sql.ErrNoRows {
		return result, err
	}
	if err == nil {
		parsed, err := strconv.ParseInt(rawCursor, 10, 64)
		if err != nil {
			return result, err
		}
		cursor = parsed
	}
	rows, err := tx.Query(`SELECT forward, inverse FROM operation_log WHERE seq > ?`, cursor)
	if err != nil {
		return result, err
	}
	var entries []importHistoryEntry
	for rows.Next() {
		var forward, inverse string
		if err := rows.Scan(&forward, &inverse); err != nil {
			rows.Close()
			return result, err
		}
		for _, raw := range []string{forward, inverse} {
			var step OpStep
			if err := json.Unmarshal([]byte(raw), &step); err != nil || step.Kind != stepImportBatch {
				continue
			}
			var payload importBatchPayload
			if err := json.Unmarshal(step.Payload, &payload); err != nil {
				continue
			}
			entries = append(entries, payload.Entries...)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, err
	}
	if err := rows.Close(); err != nil {
		return result, err
	}
	type imageHistoryResources struct {
		entry      importHistoryEntry
		identities []string
		seen       map[string]bool
	}
	resourcesByID := make(map[int64]*imageHistoryResources)
	var orderedResources []*imageHistoryResources
	retainedSeen := make(map[string]bool)
	for _, entry := range entries {
		resource := resourcesByID[entry.ImageID]
		if resource == nil {
			resource = &imageHistoryResources{entry: entry, seen: make(map[string]bool)}
			resourcesByID[entry.ImageID] = resource
			orderedResources = append(orderedResources, resource)
		} else if resource.entry.SHA256 == "" && entry.SHA256 != "" {
			resource.entry.SHA256 = entry.SHA256
		}
		for _, identity := range append(entry.FileIdentities, entry.FileIdentity, entry.RetainedIdentity) {
			if identity != "" && !resource.seen[identity] {
				resource.identities = append(resource.identities, identity)
				resource.seen[identity] = true
			}
		}
		if entry.RetainedPath != "" && entry.RetainedIdentity != "" && !retainedSeen[entry.RetainedPath] {
			result.retained = append(result.retained, discardedImportFile{path: entry.RetainedPath, hash: entry.SHA256, identity: entry.RetainedIdentity})
			retainedSeen[entry.RetainedPath] = true
		}
	}
	for _, resource := range orderedResources {
		entry := resource.entry
		var path, currentIdentity string
		var importUndone bool
		err := tx.QueryRow(`SELECT file_path, import_file_identity, import_undone FROM images WHERE id = ?`, entry.ImageID).Scan(&path, &currentIdentity, &importUndone)
		if err == sql.ErrNoRows {
			result.released = append(result.released, resource.identities...)
			continue
		}
		if err != nil {
			return result, err
		}
		if !importUndone {
			for _, identity := range resource.identities {
				if identity != currentIdentity {
					result.released = append(result.released, identity)
				}
			}
			continue
		}
		identity := currentIdentity
		if identity == "" {
			identity = entry.FileIdentity
		}
		if identity == "" && len(entry.FileIdentities) != 0 {
			identity = entry.FileIdentities[len(entry.FileIdentities)-1]
		}
		if identity == "" || entry.SHA256 == "" {
			return result, fmt.Errorf("cannot discard undone import %d without a verifiable file identity and hash", entry.ImageID)
		}
		if _, err := tx.Exec(`INSERT INTO discarded_import_files (file_path, sha256, file_identity) VALUES (?, ?, ?)
			ON CONFLICT(file_path) DO UPDATE SET sha256 = excluded.sha256, file_identity = excluded.file_identity`, path, entry.SHA256, identity); err != nil {
			return result, err
		}
		if _, err := tx.Exec(`DELETE FROM images WHERE id = ? AND import_undone = 1`, entry.ImageID); err != nil {
			return result, err
		}
		result.active = append(result.active, discardedImportFile{path: path, hash: entry.SHA256, identity: identity})
		for _, ownedIdentity := range resource.identities {
			if ownedIdentity != identity {
				result.released = append(result.released, ownedIdentity)
			}
		}
	}
	return result, nil
}

func cleanupDiscardedImportRedoBestEffort(repo *store.Repo, discarded discardedImportRedo, operation string) {
	cleanupDiscardedImportRedoBestEffortAfterCheck(repo, discarded, operation, nil)
}

// The test hook replaces a path after its ownership check.
func cleanupDiscardedImportRedoBestEffortAfterCheck(repo *store.Repo, discarded discardedImportRedo, operation string, afterCheck func(string)) {
	cleanupDiscardedImportRedoWithIdentity(repo, discarded, operation, afterCheck, store.FileIdentityAt)
}

func cleanupDiscardedImportRedoWithIdentity(repo *store.Repo, discarded discardedImportRedo, operation string, afterCheck func(string), identityAt func(string, os.FileInfo) string) {
	releasedVisible := make([]string, 0, len(discarded.active))
	for _, file := range discarded.active {
		info, err := os.Stat(file.path)
		if os.IsNotExist(err) {
			clearDiscardedImportSuppression(repo, file.path, operation)
			releasedVisible = append(releasedVisible, file.identity)
			continue
		}
		if err != nil {
			continue
		}
		data, err := os.ReadFile(file.path)
		if err != nil {
			continue
		}
		identity := identityAt(file.path, info)
		if identity == "" || file.identity == "" {
			continue
		}
		if identity != file.identity || fmt.Sprintf("%x", sha256.Sum256(data)) != file.hash {
			clearDiscardedImportSuppression(repo, file.path, operation)
			releasedVisible = append(releasedVisible, file.identity)
			continue
		}
		if afterCheck != nil {
			afterCheck(file.path)
		}
	}
	for _, file := range discarded.retained {
		if _, err := removeOwnedImportFile(file.path, file.identity); err != nil {
			log.Printf("%s: unable to remove discarded retained import %q: %v", operation, file.path, err)
		}
	}
	for _, identity := range append(discarded.released, releasedVisible...) {
		if err := repo.ReleaseImportIdentityAnchors(identity); err != nil {
			log.Printf("%s: unable to remove import identity anchor %q: %v", operation, identity, err)
		}
	}
}

func (s *ImageService) cleanupDiscardedImportRedo(repo *store.Repo, discarded discardedImportRedo, operation string) {
	cleanupDiscardedImportRedoBestEffort(repo, discarded, operation)
}

func clearDiscardedImportSuppression(repo *store.Repo, path, operation string) {
	if _, err := repo.DB.Exec(`DELETE FROM discarded_import_files WHERE file_path = ?`, path); err != nil {
		log.Printf("%s: unable to clear discarded-import suppression for %q: %v", operation, path, err)
	}
}

func recordImportFileSuppression(repo *store.Repo, path, expectedHash string, owned os.FileInfo, operation string) {
	if owned == nil || store.FileIdentityAt(path, owned) == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, owned) {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(data)) != expectedHash {
		return
	}
	identity := store.FileIdentityAt(path, info)
	if identity == "" || store.FileIdentityAt(path, owned) != identity {
		return
	}
	if _, err := repo.DB.Exec(`INSERT INTO discarded_import_files (file_path, sha256, file_identity) VALUES (?, ?, ?)
		ON CONFLICT(file_path) DO UPDATE SET sha256 = excluded.sha256, file_identity = excluded.file_identity`, path, expectedHash, identity); err != nil {
		log.Printf("%s: unable to suppress failed import file %q: %v", operation, path, err)
	}
}

// Once an image is purged, its import-history payload can no longer be replayed.
// Clear its file identities and queue the retained copy and identity anchors for
// cleanup after the history update commits.
func forgetPurgedImportHistory(repo *store.Repo, ids []int64) (discardedImportRedo, error) {
	cleanup := discardedImportRedo{}
	if len(ids) == 0 {
		return cleanup, nil
	}
	rows, err := repo.DB.Query(`SELECT seq, forward, inverse FROM operation_log WHERE kind = 'import_batch'`)
	if err != nil {
		return cleanup, err
	}
	type update struct {
		seq              int64
		forward, inverse string
	}
	var updates []update
	for rows.Next() {
		var item update
		if err := rows.Scan(&item.seq, &item.forward, &item.inverse); err != nil {
			rows.Close()
			return cleanup, err
		}
		for _, raw := range []*string{&item.forward, &item.inverse} {
			var step OpStep
			if err := json.Unmarshal([]byte(*raw), &step); err != nil || step.Kind != stepImportBatch {
				continue
			}
			var payload importBatchPayload
			if err := json.Unmarshal(step.Payload, &payload); err != nil {
				continue
			}
			changed := false
			for index := range payload.Entries {
				for _, id := range ids {
					entry := &payload.Entries[index]
					if entry.ImageID == id {
						if entry.RetainedPath != "" && entry.RetainedIdentity != "" {
							cleanup.retained = append(cleanup.retained, discardedImportFile{path: entry.RetainedPath, hash: entry.SHA256, identity: entry.RetainedIdentity})
						}
						cleanup.released = append(cleanup.released, entry.FileIdentity)
						cleanup.released = append(cleanup.released, entry.FileIdentities...)
						cleanup.released = append(cleanup.released, entry.RetainedIdentity)
						entry.RetainedPath = ""
						entry.FileIdentity = ""
						entry.FileIdentities = nil
						entry.RetainedIdentity = ""
						changed = true
					}
				}
			}
			if changed {
				step.Payload, err = json.Marshal(payload)
				if err != nil {
					rows.Close()
					return cleanup, err
				}
				data, err := json.Marshal(step)
				if err != nil {
					rows.Close()
					return cleanup, err
				}
				*raw = string(data)
			}
		}
		updates = append(updates, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return cleanup, err
	}
	if err := rows.Close(); err != nil {
		return cleanup, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return cleanup, err
	}
	defer tx.Rollback()
	for _, item := range updates {
		if _, err := tx.Exec(`UPDATE operation_log SET forward = ?, inverse = ? WHERE seq = ?`, item.forward, item.inverse, item.seq); err != nil {
			return cleanup, err
		}
	}
	if err := tx.Commit(); err != nil {
		return cleanup, err
	}
	return cleanup, nil
}
