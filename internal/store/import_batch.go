package store

import (
	"database/sql"
	"sync"
)

// ImportHardlinkProofPrefix distinguishes a persistent private inode anchor
// from a retained copy that is needed only while import history is replayable.
const ImportHardlinkProofPrefix = "hardlink:"

var (
	importSessionRetirementMu sync.Mutex
	importSessionRetired      = map[string]bool{}
)

func (r *Repo) retireImportRedoTailTx(tx *sql.Tx, cursor int64) error {
	if _, err := tx.Exec(`
		INSERT OR IGNORE INTO import_cleanup_queue(anchor_path, file_identity, sha256)
		SELECT refs.anchor_path, refs.file_identity, refs.sha256
		FROM import_replay_refs refs
		JOIN images ON images.id = refs.image_id
		WHERE refs.seq > ? AND images.import_undone = 1`, cursor); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM images WHERE import_undone = 1 AND id IN (SELECT image_id FROM import_replay_refs WHERE seq > ?)`, cursor); err != nil {
		return err
	}
	_, err := tx.Exec(`DELETE FROM import_replay_refs WHERE seq > ?`, cursor)
	return err
}

// RetireImportHistoryBeforeSession drops retained import data that is no
// longer reachable under this process's operation-log session boundary.
// Existing hard-link assets keep their private ownership anchors until purge.
func (r *Repo) RetireImportHistoryBeforeSession() error {
	importSessionRetirementMu.Lock()
	defer importSessionRetirementMu.Unlock()
	if importSessionRetired[r.Path] {
		return nil
	}
	boundary, err := r.undoSessionBoundary()
	if err != nil {
		return err
	}
	tx, err := r.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq = seq WHERE 0`); err != nil {
		return err
	}
	if _, err := tx.Exec(`
		INSERT OR IGNORE INTO import_cleanup_queue(anchor_path, file_identity, sha256)
		SELECT refs.anchor_path, refs.file_identity, refs.sha256
		FROM import_replay_refs refs
		LEFT JOIN images ON images.id = refs.image_id
		WHERE refs.seq <= ? AND (refs.sha256 NOT LIKE ? OR COALESCE(images.import_undone, 1) = 1)`, boundary, ImportHardlinkProofPrefix+"%"); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE import_file_ownership SET anchor_path = '' WHERE image_id IN (SELECT image_id FROM import_replay_refs WHERE seq <= ?) AND image_id IN (SELECT id FROM images WHERE import_undone = 0) AND sha256 NOT LIKE ?`, boundary, ImportHardlinkProofPrefix+"%"); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM images WHERE import_undone = 1 AND id IN (SELECT image_id FROM import_replay_refs WHERE seq <= ?)`, boundary); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM import_replay_refs WHERE seq <= ?`, boundary); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	importSessionRetired[r.Path] = true
	return nil
}
