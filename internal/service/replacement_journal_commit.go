package service

import (
	"database/sql"
	"errors"
	"fmt"
	"strconv"

	"loom/internal/store"
)

func finalizeReplacementJournal(repo *store.Repo, journal replacementJournal) error {
	if err := replacementFault("before-final-transaction"); err != nil {
		return err
	}
	active, err := replacementPathState(repo.Path, journal.ActivePath)
	if err != nil {
		return err
	}
	if !fileMatches(active, journal.IncomingFingerprint) || active.info.Size() != journal.TargetFileSize {
		return fmt.Errorf("replacement destination does not match the journaled target bytes")
	}
	marker := fmt.Sprintf("stat:%d:%d", active.info.Size(), active.info.ModTime().UnixNano())
	if !journal.TargetContentHash.Valid || journal.TargetContentHash.String != marker {
		return fmt.Errorf("replacement target metadata changed; manual inspection is required")
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	current, err := scanReplacementJournal(tx.QueryRow(replacementJournalSelect+` WHERE request_id=? AND completed_at IS NULL`, journal.RequestID))
	if err != nil {
		return err
	}
	if current.RepoPath != repo.Path {
		return fmt.Errorf("replacement journal repository identity changed")
	}
	row, err := replacementImageSnapshot(tx, journal.ImageID)
	if err != nil {
		return err
	}
	if row.path != current.ExpectedRowPath || row.fingerprint != current.ExpectedRowFingerprint || row.revision != current.ExpectedRowRevision || row.fileSize != current.ExpectedRowFileSize || row.contentHash != current.ExpectedRowContentHash {
		return fmt.Errorf("replacement image row changed before final transaction")
	}
	updated, err := tx.Exec(`UPDATE images SET file_path=?,file_size=?,content_hash=?,source_fingerprint=?,source_revision=?,thumb_path=NULL,width=NULL,height=NULL,
		updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE id=? AND file_path=? AND COALESCE(source_fingerprint,'')=? AND COALESCE(source_revision,0)=? AND COALESCE(file_size,0)=? AND COALESCE(content_hash,'')=?`,
		current.ActivePath, current.TargetFileSize, marker, current.TargetFingerprint, current.TargetRevision,
		current.ImageID, current.ExpectedRowPath, current.ExpectedRowFingerprint, current.ExpectedRowRevision,
		current.ExpectedRowFileSize, current.ExpectedRowContentHash)
	if err != nil {
		return fmt.Errorf("update replacement image row: %w", err)
	}
	if affected, err := updated.RowsAffected(); err != nil || affected != 1 {
		return fmt.Errorf("replacement image row update did not match the journal snapshot: rows=%d err=%v", affected, err)
	}
	if current.Action == "initial" {
		cursor, err := replacementUndoCursor(tx)
		if err != nil {
			return err
		}
		if cursor != current.ExpectedCursor || current.HistorySeq != cursor+1 {
			return fmt.Errorf("history cursor changed before replacement commit")
		}
		previous, err := repo.RecordOperationInTx(tx, current.HistoryKind, current.HistoryForward, current.HistoryInverse)
		if err != nil {
			return fmt.Errorf("append replacement history: %w", err)
		}
		if previous != current.ExpectedCursor {
			return fmt.Errorf("replacement history cursor changed during append")
		}
	} else if err := moveReplacementHistoryCursor(tx, current); err != nil {
		return err
	}
	receipt := replacementReplayReceipt{Applied: true, RequestID: current.RequestID, ImageID: current.ImageID, Action: current.Action, Kind: current.HistoryKind}
	receiptJSON, err := jsonMarshalReplacementReceipt(receipt)
	if err != nil {
		return err
	}
	if err := bumpDiscoveryGenerationTx(tx); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE replacement_replay_journal SET phase='complete',result_json=?,incoming_data=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id=? AND completed_at IS NULL`, receiptJSON, current.RequestID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM replacement_path_reservations WHERE request_id=?`, current.RequestID); err != nil {
		return err
	}
	replacementCrash("before-final-commit")
	if current.Action == "initial" {
		if err := repo.CommitOperation(tx, current.ExpectedCursor); err != nil {
			return replacementCommitResult(repo, current, err)
		}
	} else if err := tx.Commit(); err != nil {
		return replacementCommitResult(repo, current, err)
	}
	replacementCrash("after-final-commit")
	return replacementFault("after-final-commit")
}

func replacementCommitResult(repo *store.Repo, journal replacementJournal, commitErr error) error {
	result, found, receiptErr := readReplacementReceipt(repo, journal.RequestID, journal.RequestHash)
	if receiptErr == nil && found && result != nil && result.Applied {
		if journal.Action == "initial" {
			repo.ConfirmCommittedOperation(journal.ExpectedCursor)
		}
		return nil
	}
	return fmt.Errorf("replacement final transaction outcome is uncertain; request %s remains fenced: %w", journal.RequestID, errors.Join(commitErr, receiptErr))
}

func replacementUndoCursor(tx *sql.Tx) (int64, error) {
	var value string
	err := tx.QueryRow(`SELECT value FROM settings WHERE scope='repo' AND key='undo_cursor'`).Scan(&value)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(value, 10, 64)
}

func moveReplacementHistoryCursor(tx *sql.Tx, journal replacementJournal) error {
	expected, next := journal.HistorySeq, journal.HistorySeq-1
	if journal.Action == "redo" {
		expected, next = journal.HistorySeq-1, journal.HistorySeq
	}
	res, err := tx.Exec(`UPDATE settings SET value=? WHERE scope='repo' AND key='undo_cursor' AND CAST(value AS INTEGER)=?
		AND EXISTS(SELECT 1 FROM operation_log WHERE seq=? AND kind=? AND forward=? AND inverse=? AND created_at=?)`,
		strconv.FormatInt(next, 10), expected, journal.HistorySeq, journal.HistoryKind,
		journal.HistoryForward, journal.HistoryInverse, journal.HistoryCreatedAt.String)
	if err != nil {
		return fmt.Errorf("move replacement history cursor: %w", err)
	}
	count, err := res.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("replacement history entry or cursor changed; cursor was not advanced: rows=%d err=%v", count, err)
	}
	return nil
}
