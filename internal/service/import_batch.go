package service

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"loom/internal/store"
)

type importBatchEntry struct {
	importTransfer
	ImageID    int64  `json:"imageId"`
	ActivePath string `json:"activePath"`
	AnchorPath string `json:"anchorPath"`
	Identity   string `json:"identity"`
	SHA256     string `json:"sha256"`
}

type importBatchPayload struct {
	BatchID string             `json:"batchId"`
	Files   []importBatchEntry `json:"files"`
}

func (s *ImageService) importMediaBatch(repoPath string, media []ClipboardMedia, place bool, x, y float64) ([]int64, error) {
	return importPreparedBatch(repoPath, media, nil, importCopy, place, x, y, os.Symlink, os.Link)
}

func importPreparedBatch(repoPath string, media []ClipboardMedia, sources []nativeImportSource, mode string, place bool, x, y float64, symlink, hardlink func(string, string) error) ([]int64, error) {
	if err := validateClipboardMedia(media); err != nil {
		return nil, err
	}
	repo, unlock, err := openOperationRepo(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	if err := repo.PrepareOperationLog(); err != nil {
		return nil, err
	}

	batchID, err := newImportBatchID()
	if err != nil {
		return nil, err
	}
	anchorDir := filepath.Join(repo.Path, ".loom", "import-anchors", batchID)
	items := make([]ClipboardMedia, len(media))
	transfers := make([]importTransfer, len(media))
	targets := make([]string, len(media))
	anchors := make([]string, len(media))
	checksums := make([]string, len(media))
	identities := make([]string, len(media))
	reserved, err := deferredImportMoveTargets(repo)
	if err != nil {
		return nil, err
	}
	for i, item := range media {
		items[i] = item
		data, err := base64.StdEncoding.Strict().DecodeString(item.Data)
		if err != nil {
			return nil, fmt.Errorf("decode media %q: %w", item.Name, err)
		}
		name := filepath.Base(strings.ReplaceAll(item.Name, "\\", "/"))
		targets[i], err = nextImportPath(repo.Path, name, reserved)
		if err != nil {
			return nil, err
		}
		reserved[targets[i]] = struct{}{}
		anchors[i] = filepath.Join(anchorDir, fmt.Sprintf("%03d", i))
		checksums[i] = fmt.Sprintf("%x", sha256.Sum256(data))
	}
	if mode != importCopy && len(sources) != len(items) {
		return nil, fmt.Errorf("import mode requires native source paths")
	}
	if err := createImportIntent(repo, batchID, items, targets, anchors, checksums); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(anchorDir, 0o700); err != nil {
		return nil, errors.Join(err, recoverImportIntents(repo))
	}
	for i, item := range items {
		var publicationSource string
		switch mode {
		case importMove:
			publicationSource = sources[i].path
			transfers[i] = importTransfer{Kind: transferMove, Original: publicationSource}
			info, statErr := os.Lstat(publicationSource)
			if statErr != nil {
				return nil, errors.Join(statErr, recoverImportIntents(repo))
			}
			identities[i] = sources[i].identity
			if !info.Mode().IsRegular() || !sameOwnedImportFile(publicationSource, identities[i], checksums[i]) {
				return nil, errors.Join(fmt.Errorf("original import file changed"), recoverImportIntents(repo))
			}
			if err := setImportTransfer(repo, batchID, i, transfers[i]); err != nil {
				return nil, errors.Join(err, recoverImportIntents(repo))
			}
			err = markImportStageComplete(repo, batchID, i, identities[i], checksums[i])
		case importLink:
			publicationSource = anchors[i]
			transfers[i] = importTransfer{Kind: transferRename}
			if err := setImportTransfer(repo, batchID, i, transfers[i]); err != nil {
				return nil, errors.Join(err, recoverImportIntents(repo))
			}
			identities[i], checksums[i], err = createImportLinkStage(repo, batchID, i, sources[i], anchors[i], checksums[i], symlink, hardlink)
			if err == nil && strings.HasPrefix(checksums[i], store.ImportHardlinkProofPrefix) {
				// Keep the private hard-link anchor. The user may rename or
				// delete their original name without changing what Loom owns.
				transfers[i] = importTransfer{}
				err = setImportTransfer(repo, batchID, i, transfers[i])
			}
		default:
			publicationSource = anchors[i]
			data, _ := base64.StdEncoding.Strict().DecodeString(item.Data)
			identities[i], err = writeImportStage(repo, batchID, i, anchors[i], data, checksums[i])
		}
		if err != nil {
			return nil, errors.Join(err, recoverImportIntents(repo))
		}
		targets[i], err = publishPreparedStage(repo, batchID, i, publicationSource, targets[i], identities[i], checksums[i], &transfers[i], reserved, hardlink)
		if err != nil {
			return nil, errors.Join(err, recoverImportIntents(repo))
		}
	}
	ids, err := commitImportBatch(repo, batchID, targets, anchors, identities, checksums, transfers, place, x, y)
	if err != nil {
		return nil, errors.Join(err, recoverImportIntents(repo))
	}
	return ids, nil
}

func commitImportBatch(repo *store.Repo, batchID string, targets, anchors, identities, checksums []string, transfers []importTransfer, place bool, x, y float64) ([]int64, error) {
	for i := range targets {
		if !sameOwnedImportFile(targets[i], identities[i], checksums[i]) || (transfers[i].Kind == "" && !sameOwnedImportFile(anchors[i], identities[i], checksums[i])) {
			return nil, fmt.Errorf("published import %q changed before commit", filepath.Base(targets[i]))
		}
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	ids := make([]int64, 0, len(targets))
	entries := make([]importBatchEntry, 0, len(targets))
	for i := range targets {
		var cx, cy any
		if place {
			cx, cy = x+float64(i%6)*190, y+float64(i/6)*160
		}
		result, err := tx.Exec(`INSERT INTO images(file_path, canvas_x, canvas_y) VALUES (?, ?, ?)`, targets[i], cx, cy)
		if err != nil {
			return nil, err
		}
		id, err := result.LastInsertId()
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
		entries = append(entries, importBatchEntry{importTransfer: transfers[i], ImageID: id, ActivePath: targets[i], AnchorPath: anchors[i], Identity: identities[i], SHA256: checksums[i]})
		if _, err := tx.Exec(`INSERT INTO import_file_ownership(image_id, anchor_path, file_identity, sha256, active_file_identity, active_sha256) VALUES (?, ?, ?, ?, ?, ?)`, id, anchors[i], identities[i], checksums[i], identities[i], checksums[i]); err != nil {
			return nil, err
		}
	}
	payload := importBatchPayload{BatchID: batchID, Files: entries}
	fwd, err := json.Marshal(step("import_batch", payload))
	if err != nil {
		return nil, err
	}
	inv, err := json.Marshal(step("import_batch", payload))
	if err != nil {
		return nil, err
	}
	if err := repo.RecordOperationInTx(tx, "import_batch", string(fwd), string(inv)); err != nil {
		return nil, err
	}
	var seq int64
	if err := tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM settings WHERE scope = 'repo' AND key = 'undo_cursor'`).Scan(&seq); err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if _, err := tx.Exec(`INSERT INTO import_replay_refs(seq, image_id, anchor_path, file_identity, sha256) VALUES (?, ?, ?, ?, ?)`, seq, entry.ImageID, entry.AnchorPath, entry.Identity, entry.SHA256); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`DELETE FROM import_batch_intents WHERE batch_id = ?`, batchID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return ids, nil
}

func recoverImportIntents(repo *store.Repo) error {
	rows, err := repo.DB.Query(`SELECT batch_id, action FROM import_batch_intents ORDER BY batch_id`)
	if err != nil {
		return err
	}
	type pending struct{ id, action string }
	var intents []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.action); err != nil {
			rows.Close()
			return err
		}
		intents = append(intents, item)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	var deferred error
	for _, intent := range intents {
		switch intent.action {
		case "publish":
			if err := recoverPendingImportPublication(repo, intent.id); err != nil {
				if errors.Is(err, errImportMoveRecoveryDeferred) {
					deferred = errors.Join(deferred, err)
					continue
				}
				return err
			}
		case "undo", "redo":
			if err := recoverPendingImportReplay(repo, intent.id, intent.action); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported pending import action %q", intent.action)
		}
	}
	return deferred
}

func replayImportBatchHistory(repo *store.Repo, redo bool) (bool, *store.Operation, error) {
	if err := repo.PrepareOperationLog(); err != nil {
		return true, nil, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return true, nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
		return true, nil, err
	}
	op, err := repo.PeekHistoryInTx(tx, redo)
	if err != nil || op == nil || op.Kind != "import_batch" {
		return false, op, err
	}
	raw := op.Inverse
	action := "undo"
	if redo {
		raw = op.Forward
		action = "redo"
	}
	var replay OpStep
	if err := json.Unmarshal([]byte(raw), &replay); err != nil {
		return true, op, err
	}
	var payload importBatchPayload
	if replay.Kind != "import_batch" || json.Unmarshal(replay.Payload, &payload) != nil || len(payload.Files) == 0 {
		return true, op, fmt.Errorf("invalid import batch history payload")
	}
	if err := validateImportReplayTx(tx, repo.Path, payload, action); err != nil {
		return true, op, err
	}
	intentID := fmt.Sprintf("%s-%s-%d", payload.BatchID, action, op.Seq)
	if _, err := tx.Exec(`INSERT INTO import_batch_intents(batch_id, action, op_seq) VALUES (?, ?, ?)`, intentID, action, op.Seq); err != nil {
		return true, op, err
	}
	for ordinal, entry := range payload.Files {
		var source string
		if err := tx.QueryRow(`SELECT file_path FROM images WHERE id = ?`, entry.ImageID).Scan(&source); err != nil {
			return true, op, err
		}
		target := entry.ActivePath
		if action == "undo" {
			target = entry.AnchorPath
			if entry.Kind == transferMove {
				target = entry.Original
			}
		}
		if _, err := tx.Exec(`INSERT INTO import_batch_intent_files(batch_id, ordinal, image_id, source_path, target_path, anchor_path, file_identity, sha256, transfer_kind, original_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, intentID, ordinal, entry.ImageID, source, target, entry.AnchorPath, entry.Identity, entry.SHA256, entry.Kind, entry.Original); err != nil {
			return true, op, err
		}
	}
	if action == "undo" {
		for _, entry := range payload.Files {
			if _, err := tx.Exec(`UPDATE images SET import_undone = 1 WHERE id = ?`, entry.ImageID); err != nil {
				return true, op, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return true, op, err
	}
	err = recoverPendingImportReplay(repo, intentID, action)
	return true, op, err
}

func validateImportReplayTx(tx *sql.Tx, root string, payload importBatchPayload, action string) error {
	for _, entry := range payload.Files {
		var path, anchor, identity, hash string
		var undone bool
		if err := tx.QueryRow(`SELECT images.file_path, images.import_undone, ownership.anchor_path, ownership.file_identity, ownership.sha256
			FROM images JOIN import_file_ownership ownership ON ownership.image_id = images.id WHERE images.id = ?`, entry.ImageID).
			Scan(&path, &undone, &anchor, &identity, &hash); err != nil {
			return fmt.Errorf("imported asset %d is no longer available: %w", entry.ImageID, err)
		}
		if anchor != entry.AnchorPath || identity != entry.Identity || hash != entry.SHA256 {
			return fmt.Errorf("imported asset %d ownership proof changed", entry.ImageID)
		}
		if (action == "undo" && undone) || (action == "redo" && !undone) {
			return fmt.Errorf("imported asset %d is not in the expected history state", entry.ImageID)
		}
		// An occupied target for a rename operation is known before recording
		// the replay intent, so it cannot strand the repository in recovery.
		if entry.Kind != "" {
			if entry.Kind == transferMove && !validMoveOriginal(root, entry.Original) {
				return fmt.Errorf("invalid original path for import replay")
			}
			target := entry.ActivePath
			if action == "undo" {
				target = entry.AnchorPath
				if entry.Kind == transferMove {
					target = entry.Original
				}
			}
			if err := checkTransferTarget(target); err != nil {
				return err
			}
		}
		if !sameOwnedImportFile(path, identity, hash) {
			return fmt.Errorf("imported asset %d changed outside Loom; it was left untouched", entry.ImageID)
		}
	}
	return nil
}

func recoverPendingImportReplay(repo *store.Repo, intentID, action string) error {
	rows, err := repo.DB.Query(`SELECT ordinal, image_id, source_path, target_path, anchor_path, file_identity, sha256, transfer_kind, original_path FROM import_batch_intent_files WHERE batch_id = ? ORDER BY ordinal`, intentID)
	if err != nil {
		return err
	}
	type item struct {
		importTransfer
		ordinal  int
		imageID  int64
		source   string
		target   string
		anchor   string
		identity string
		hash     string
	}
	var files []item
	for rows.Next() {
		var file item
		if err := rows.Scan(&file.ordinal, &file.imageID, &file.source, &file.target, &file.anchor, &file.identity, &file.hash, &file.Kind, &file.Original); err != nil {
			rows.Close()
			return err
		}
		files = append(files, file)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for i := range files {
		file := &files[i]
		if !pathInside(filepath.Join(repo.Path, ".loom", "import-anchors"), file.anchor) {
			return fmt.Errorf("invalid import anchor path %q", file.anchor)
		}
		if file.Kind != "" {
			if err := recoverRenamedReplay(repo.Path, file.source, file.target, file.anchor, file.identity, file.hash, action, file.importTransfer); err != nil {
				return err
			}
			continue
		}
		if (action == "undo" && (!pathInside(repo.Path, file.source) || file.target != file.anchor)) ||
			(action == "redo" && (file.source != file.anchor || !pathInside(repo.Path, file.target))) {
			return fmt.Errorf("invalid import replay path for image %d", file.imageID)
		}
		if !sameOwnedImportFile(file.source, file.identity, file.hash) && action == "undo" {
			// The source path now belongs to an external replacement. Keep it and
			// finish the import undo using only the verified anchor bytes.
		}
		if action == "redo" {
			for {
				if _, err := os.Lstat(file.target); os.IsNotExist(err) {
					break
				} else if err != nil {
					return err
				} else if sameOwnedImportFile(file.target, file.identity, file.hash) {
					break
				} else {
					file.target, err = nextImportPath(repo.Path, filepath.Base(file.target), nil)
					if err != nil {
						return err
					}
					if _, err := repo.DB.Exec(`UPDATE import_batch_intent_files SET target_path = ? WHERE batch_id = ? AND ordinal = ?`, file.target, intentID, file.ordinal); err != nil {
						return err
					}
				}
			}
		}
		if err := os.MkdirAll(filepath.Dir(file.target), 0o700); err != nil {
			return err
		}
		if err := linkImportAnchor(file.anchor, file.target, file.identity, file.hash); err != nil {
			return err
		}
		if sameOwnedImportFile(file.source, file.identity, file.hash) && file.source != file.target && file.source != file.anchor {
			if err := os.Remove(file.source); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, file := range files {
		undone := action == "undo"
		if _, err := tx.Exec(`UPDATE images SET file_path = ?, import_undone = ? WHERE id = ?`, file.target, undone, file.imageID); err != nil {
			return err
		}
	}
	var seq int64
	if err := tx.QueryRow(`SELECT op_seq FROM import_batch_intents WHERE batch_id = ?`, intentID).Scan(&seq); err != nil {
		return err
	}
	cursor := seq
	if action == "undo" {
		cursor--
	}
	if _, err := tx.Exec(`INSERT INTO settings(scope, key, value) VALUES ('repo', 'undo_cursor', ?) ON CONFLICT(scope, key) DO UPDATE SET value=excluded.value`, fmt.Sprint(cursor)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM import_batch_intents WHERE batch_id = ?`, intentID); err != nil {
		return err
	}
	return tx.Commit()
}

func recoverPendingImportPublication(repo *store.Repo, batchID string) error {
	rows, err := repo.DB.Query(`SELECT target_path, anchor_path, file_identity, sha256, stage_complete, transfer_kind, original_path FROM import_batch_intent_files WHERE batch_id = ? ORDER BY ordinal`, batchID)
	if err != nil {
		return err
	}
	type item struct {
		importTransfer
		target, anchor, identity, hash string
		complete                       bool
	}
	var files []item
	for rows.Next() {
		var file item
		if err := rows.Scan(&file.target, &file.anchor, &file.identity, &file.hash, &file.complete, &file.Kind, &file.Original); err != nil {
			rows.Close()
			return err
		}
		files = append(files, file)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	var deferred error
	for _, file := range files {
		if !pathInside(filepath.Join(repo.Path, ".loom", "import-anchors"), file.anchor) || !pathInside(repo.Path, file.target) {
			return fmt.Errorf("invalid pending import path in batch %q", batchID)
		}
		if file.Kind != "" {
			if err := recoverRenamedPublication(repo.Path, file.target, file.identity, file.hash, file.importTransfer); err != nil {
				if errors.Is(err, errImportMoveRecoveryDeferred) {
					deferred = errors.Join(deferred, err)
					continue
				}
				return err
			}
		} else if _, err := os.Lstat(file.anchor); err == nil {
			if _, err := removeImportHardLink(file.anchor, file.target, file.identity, file.hash); err != nil {
				return fmt.Errorf("recover interrupted import publication: %w", err)
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := discardPendingImportStage(repo, file.anchor, file.identity, file.complete, file.hash); err != nil {
			return fmt.Errorf("clean staged import: %w", err)
		}
	}
	if deferred != nil {
		return deferred
	}
	_, err = repo.DB.Exec(`DELETE FROM import_batch_intents WHERE batch_id = ?`, batchID)
	return err
}
