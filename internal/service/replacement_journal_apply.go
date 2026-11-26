package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	"loom/internal/store"
)

type replacementReplayReceipt struct {
	Applied   bool   `json:"applied"`
	RequestID string `json:"requestId"`
	ImageID   int64  `json:"imageId"`
	Action    string `json:"action"`
	Kind      string `json:"kind"`
}

type replacementRecoveryError struct {
	Journal replacementJournal
	Cause   error
}

func (err *replacementRecoveryError) Error() string {
	return pendingReplacementResult(err.Journal, "Replacement replay is pending inspection: "+err.Cause.Error()).Message
}

func (err *replacementRecoveryError) Unwrap() error { return err.Cause }

func processReplacementJournal(repo *store.Repo, journal replacementJournal) error {
	if journal.CompletedAt.Valid {
		return nil
	}
	if journal.RepoPath != repo.Path {
		return fmt.Errorf("replacement journal repository identity does not match the opened repository")
	}
	if err := ensureIncomingMetadata(repo, journal); err != nil {
		return err
	}
	var err error
	journal, err = scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE request_id=?`, journal.RequestID))
	if err != nil {
		return err
	}
	if err := checkReplacementRowSnapshot(repo, journal); err != nil {
		return err
	}
	for stepIndex := 0; stepIndex < 4; {
		layout, err := classifyReplacementLayout(repo.Path, journal)
		if err != nil {
			return err
		}
		switch layout {
		case replacementLayoutBefore:
			if err := replacementFault("before-current-move"); err != nil {
				return err
			}
			if err := moveFileNoReplace(journal.CurrentPath, journal.OutgoingPath); err != nil {
				return err
			}
			replacementCrash("after-current-move")
			if err := recordReplacementPhase(repo, journal, "current-moved"); err != nil {
				return err
			}
			replacementCrash("after-current-receipt")
			stepIndex++
		case replacementLayoutCurrentDuplicate:
			if err := removeVerifiedDuplicate(repo.Path, journal.CurrentPath, journal.OutgoingPath, journal.CurrentFingerprint); err != nil {
				return err
			}
			replacementCrash("after-current-unlink")
			if err := recordReplacementPhase(repo, journal, "current-moved"); err != nil {
				return err
			}
			stepIndex++
		case replacementLayoutAfterCurrent:
			if err := replacementFault("before-incoming-move"); err != nil {
				return err
			}
			if err := moveFileNoReplace(journal.IncomingPath, journal.ActivePath); err != nil {
				return err
			}
			replacementCrash("after-incoming-move")
			if err := recordReplacementPhase(repo, journal, "incoming-moved"); err != nil {
				return err
			}
			replacementCrash("after-incoming-receipt")
			stepIndex++
		case replacementLayoutIncomingDuplicate:
			if err := removeVerifiedDuplicate(repo.Path, journal.IncomingPath, journal.ActivePath, journal.IncomingFingerprint); err != nil {
				return err
			}
			replacementCrash("after-incoming-unlink")
			if err := recordReplacementPhase(repo, journal, "incoming-moved"); err != nil {
				return err
			}
			stepIndex++
		case replacementLayoutComplete:
			return finalizeReplacementJournal(repo, journal)
		default:
			return fmt.Errorf("replacement files do not match a known journal phase; no file was changed")
		}
	}
	return finalizeReplacementJournal(repo, journal)
}

type replacementLayout int

const (
	replacementLayoutUnknown replacementLayout = iota
	replacementLayoutBefore
	replacementLayoutCurrentDuplicate
	replacementLayoutAfterCurrent
	replacementLayoutIncomingDuplicate
	replacementLayoutComplete
)

func classifyReplacementLayout(root string, journal replacementJournal) (replacementLayout, error) {
	current, err := replacementPathState(root, journal.CurrentPath)
	if err != nil {
		return replacementLayoutUnknown, err
	}
	outgoing, err := replacementPathState(root, journal.OutgoingPath)
	if err != nil {
		return replacementLayoutUnknown, err
	}
	incoming, err := replacementPathState(root, journal.IncomingPath)
	if err != nil {
		return replacementLayoutUnknown, err
	}
	active, err := replacementPathState(root, journal.ActivePath)
	if err != nil {
		return replacementLayoutUnknown, err
	}
	currentAlias := journal.CurrentPath == journal.ActivePath
	beforeActive := !active.exists || currentAlias && samePathState(current, active)
	if fileMatches(current, journal.CurrentFingerprint) &&
		fileMissing(outgoing) && fileMatches(incoming, journal.IncomingFingerprint) && beforeActive {
		return replacementLayoutBefore, nil
	}
	if fileMatches(current, journal.CurrentFingerprint) && fileMatches(outgoing, journal.CurrentFingerprint) &&
		fileMatches(incoming, journal.IncomingFingerprint) && beforeActive &&
		sameFile(journal.CurrentPath, journal.OutgoingPath) {
		return replacementLayoutCurrentDuplicate, nil
	}
	currentGone := fileMissing(current)
	activeGone := fileMissing(active)
	if currentAlias {
		currentGone = fileMissing(current)
		activeGone = currentGone
	}
	if currentGone && fileMatches(outgoing, journal.CurrentFingerprint) &&
		fileMatches(incoming, journal.IncomingFingerprint) && activeGone {
		return replacementLayoutAfterCurrent, nil
	}
	if currentGone && fileMatches(outgoing, journal.CurrentFingerprint) &&
		fileMatches(incoming, journal.IncomingFingerprint) && fileMatches(active, journal.IncomingFingerprint) &&
		sameFile(journal.IncomingPath, journal.ActivePath) {
		return replacementLayoutIncomingDuplicate, nil
	}
	if currentAlias && fileMatches(current, journal.IncomingFingerprint) &&
		fileMatches(outgoing, journal.CurrentFingerprint) &&
		fileMatches(incoming, journal.IncomingFingerprint) && sameFile(journal.IncomingPath, journal.ActivePath) {
		return replacementLayoutIncomingDuplicate, nil
	}
	if (!currentAlias && currentGone || currentAlias && fileMatches(current, journal.IncomingFingerprint)) &&
		fileMatches(outgoing, journal.CurrentFingerprint) && fileMissing(incoming) &&
		fileMatches(active, journal.IncomingFingerprint) {
		return replacementLayoutComplete, nil
	}
	return replacementLayoutUnknown, fmt.Errorf("replacement files do not match a known journal phase; current=%+v outgoing=%+v incoming=%+v active=%+v", current, outgoing, incoming, active)
}

func samePathState(left, right replacementPath) bool {
	return left.exists == right.exists && (!left.exists || left.fingerprint == right.fingerprint)
}

func fileMatches(path replacementPath, fingerprint string) bool {
	return path.exists && path.fingerprint == fingerprint
}

func fileMissing(path replacementPath) bool { return !path.exists }

func sameFile(left, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
}

func moveFileNoReplace(source, destination string) error {
	linkErr := error(nil)
	if replacementNoReplaceLinkHook != nil {
		linkErr = replacementNoReplaceLinkHook(source, destination)
	} else {
		linkErr = os.Link(source, destination)
	}
	if linkErr != nil {
		return fmt.Errorf("no-replace move from %s to %s failed (no fallback was used): %w", source, destination, linkErr)
	}
	replacementCrash("after-no-replace-link")
	if err := replacementFault("after-no-replace-link"); err != nil {
		return fmt.Errorf("no-replace move linked both paths; the verified duplicate was preserved: %w", err)
	}
	if err := os.Remove(source); err != nil {
		return fmt.Errorf("no-replace move linked %s to %s but could not unlink the source: %w", source, destination, err)
	}
	return nil
}

func removeVerifiedDuplicate(root, source, destination, expectedFingerprint string) error {
	sourceState, err := replacementPathState(root, source)
	if err != nil {
		return err
	}
	destinationState, err := replacementPathState(root, destination)
	if err != nil {
		return err
	}
	if !fileMatches(sourceState, expectedFingerprint) || !fileMatches(destinationState, expectedFingerprint) || !sameFile(source, destination) {
		return fmt.Errorf("duplicate replacement paths are not the exact same verified file")
	}
	return os.Remove(source)
}

func ensureIncomingMetadata(repo *store.Repo, journal replacementJournal) error {
	if journal.Action == "initial" {
		return ensureInitialReplacementIncoming(repo, journal)
	}
	state, err := replacementPathState(repo.Path, journal.IncomingPath)
	if err != nil {
		return err
	}
	if !state.exists && journal.TargetContentHash.Valid {
		active, activeErr := replacementPathState(repo.Path, journal.ActivePath)
		if activeErr != nil {
			return activeErr
		}
		outgoing, outgoingErr := replacementPathState(repo.Path, journal.OutgoingPath)
		if outgoingErr != nil {
			return outgoingErr
		}
		current, currentErr := replacementPathState(repo.Path, journal.CurrentPath)
		if currentErr != nil {
			return currentErr
		}
		currentIsTarget := journal.CurrentPath != journal.ActivePath && !current.exists ||
			journal.CurrentPath == journal.ActivePath && fileMatches(active, journal.IncomingFingerprint)
		if fileMatches(active, journal.IncomingFingerprint) && fileMatches(outgoing, journal.CurrentFingerprint) &&
			currentIsTarget && active.info.Size() == journal.TargetFileSize &&
			fmt.Sprintf("stat:%d:%d", active.info.Size(), active.info.ModTime().UnixNano()) == journal.TargetContentHash.String {
			return nil
		}
	}
	if !fileMatches(state, journal.IncomingFingerprint) {
		return fmt.Errorf("incoming replacement file is missing or changed at %s", journal.IncomingPath)
	}
	marker := fmt.Sprintf("stat:%d:%d", state.info.Size(), state.info.ModTime().UnixNano())
	if journal.TargetContentHash.Valid && journal.TargetFileSize == state.info.Size() && journal.TargetContentHash.String == marker {
		return nil
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE replacement_replay_journal SET target_file_size=?,target_content_hash=?,phase='incoming-ready'
		WHERE request_id=? AND completed_at IS NULL AND incoming_fingerprint=?`, state.info.Size(), marker, journal.RequestID, journal.IncomingFingerprint)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	journal.TargetFileSize = state.info.Size()
	journal.TargetContentHash = sql.NullString{String: marker, Valid: true}
	journal.Phase = "incoming-ready"
	return nil
}

func recordReplacementPhase(repo *store.Repo, journal replacementJournal, phase string) error {
	if err := replacementFault("phase-" + phase); err != nil {
		return err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE replacement_replay_journal SET phase=? WHERE request_id=? AND completed_at IS NULL`, phase, journal.RequestID); err != nil {
		return err
	}
	return tx.Commit()
}

func checkReplacementRowSnapshot(repo *store.Repo, journal replacementJournal) error {
	var row replacementRowSnapshot
	err := repo.DB.QueryRow(`SELECT file_path,COALESCE(source_fingerprint,''),COALESCE(source_revision,0),COALESCE(file_size,0),COALESCE(content_hash,'') FROM images WHERE id=?`, journal.ImageID).
		Scan(&row.path, &row.fingerprint, &row.revision, &row.fileSize, &row.contentHash)
	if err != nil {
		return fmt.Errorf("replacement image %d row is unavailable: %w", journal.ImageID, err)
	}
	if row.path != journal.ExpectedRowPath || row.fingerprint != journal.ExpectedRowFingerprint ||
		row.revision != journal.ExpectedRowRevision || row.fileSize != journal.ExpectedRowFileSize ||
		row.contentHash != journal.ExpectedRowContentHash {
		return fmt.Errorf("replacement image row changed while recovery was pending")
	}
	return nil
}

func replacementFault(point string) error {
	if replacementJournalFaultHook != nil {
		return replacementJournalFaultHook(point)
	}
	return nil
}

func replacementCrash(point string) {
	if replacementJournalCrashHook != nil {
		replacementJournalCrashHook(point)
	}
}

func recoverReplacementJournalsOnly(repo *store.Repo) error {
	requestIDs, err := activeReplacementRequestIDs(repo)
	if err != nil {
		return err
	}
	if len(requestIDs) > 0 {
		if err := repo.PrepareOperationLog(); err != nil {
			return err
		}
	}
	for _, requestID := range requestIDs {
		journal, err := scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE request_id=? AND completed_at IS NULL`, requestID))
		if err != nil {
			return err
		}
		release, ok := acquireReplacementImageLock(repo.Path, journal.ImageID)
		if !ok {
			return &replacementRecoveryError{Journal: journal, Cause: fmt.Errorf("replacement image is busy in a preview")}
		}
		if err := processReplacementJournal(repo, journal); err != nil {
			release()
			return &replacementRecoveryError{Journal: journal, Cause: err}
		}
		release()
	}
	return nil
}

func acquireReplacementImageLock(repoPath string, imageID int64) (func(), bool) {
	return acquirePreviewLock(context.Background(), fmt.Sprintf("%s\x00%d", repoPath, imageID))
}

func jsonMarshalReplacementReceipt(receipt replacementReplayReceipt) (string, error) {
	data, err := json.Marshal(receipt)
	return string(data), err
}
