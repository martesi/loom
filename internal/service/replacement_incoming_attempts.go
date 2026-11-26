package service

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"loom/internal/store"
)

var replacementIncomingAttemptHook func(point, path string)
var replacementIncomingWriteHook func(*os.File, []byte) (int, error)

type replacementIncomingAttempt struct {
	id, requestID, path, phase string
	identity, fingerprint      sql.NullString
}

func ensureInitialReplacementIncoming(repo *store.Repo, journal replacementJournal) error {
	if len(journal.IncomingData) == 0 || fingerprintBytes(journal.IncomingData) != journal.IncomingFingerprint {
		return fmt.Errorf("replacement recovery data is missing or does not match the reserved fingerprint; inspect request %s", journal.RequestID)
	}
	if complete, err := activeTargetAlreadyVerified(repo, journal); err != nil {
		return err
	} else if complete {
		state, stateErr := replacementPathState(repo.Path, journal.IncomingPath)
		if stateErr != nil {
			return stateErr
		}
		if !state.exists {
			return nil
		}
	}
	attempt, err := readIncomingAttempt(repo.DB, journal.RequestID, journal.IncomingPath)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		state, stateErr := replacementPathState(repo.Path, attempt.path)
		if stateErr != nil {
			return stateErr
		}
		if !state.exists && attempt.phase == "reserved" {
			return createAndSelectIncomingAttempt(repo, journal, attempt)
		}
		if state.exists && attempt.identity.Valid {
			identity, identityErr := replacementObjectIdentity(state.info)
			if identityErr == nil && identity == attempt.identity.String && state.fingerprint == journal.IncomingFingerprint {
				return selectVerifiedIncomingAttempt(repo, journal, attempt, state)
			}
		}
		if state.exists || attempt.phase != "reserved" {
			if err := markIncomingAttemptUntrusted(repo, journal, attempt.path, ""); err != nil {
				return err
			}
		}
	} else {
		state, stateErr := replacementPathState(repo.Path, journal.IncomingPath)
		if stateErr != nil {
			return stateErr
		}
		if state.exists {
			if err := markIncomingAttemptUntrusted(repo, journal, journal.IncomingPath, state.fingerprint); err != nil {
				return err
			}
		}
	}

	if !canResumeIncomingCreation(repo.Path, journal) {
		return fmt.Errorf("incoming replacement attempts are incomplete or untrusted and the original pre-move layout is no longer verifiable; inspect protected evidence for request %s", journal.RequestID)
	}
	attempts, err := listIncomingAttempts(repo.DB, journal.RequestID)
	if err != nil {
		return err
	}
	for _, candidate := range attempts {
		if candidate.phase != "created" && candidate.phase != "verified" && candidate.phase != "reserved" {
			continue
		}
		state, stateErr := replacementPathState(repo.Path, candidate.path)
		if stateErr != nil {
			return stateErr
		}
		if !state.exists {
			if candidate.phase == "reserved" {
				return createAndSelectIncomingAttempt(repo, journal, candidate)
			}
			continue
		}
		if !candidate.identity.Valid {
			if err := markIncomingAttemptUntrusted(repo, journal, candidate.path, ""); err != nil {
				return err
			}
			continue
		}
		identity, identityErr := replacementObjectIdentity(state.info)
		if identityErr != nil || identity != candidate.identity.String {
			if err := markIncomingAttemptUntrusted(repo, journal, candidate.path, state.fingerprint); err != nil {
				return err
			}
			continue
		}
		if state.fingerprint == journal.IncomingFingerprint {
			return selectVerifiedIncomingAttempt(repo, journal, candidate, state)
		}
		if err := markIncomingAttemptUntrusted(repo, journal, candidate.path, state.fingerprint); err != nil {
			return err
		}
	}
	attempt, err = reserveReplacementIncomingAttempt(repo, journal)
	if err != nil {
		return err
	}
	return createAndSelectIncomingAttempt(repo, journal, attempt)
}

func activeTargetAlreadyVerified(repo *store.Repo, journal replacementJournal) (bool, error) {
	if !journal.TargetContentHash.Valid {
		return false, nil
	}
	active, err := replacementPathState(repo.Path, journal.ActivePath)
	if err != nil {
		return false, err
	}
	outgoing, err := replacementPathState(repo.Path, journal.OutgoingPath)
	if err != nil {
		return false, err
	}
	current, err := replacementPathState(repo.Path, journal.CurrentPath)
	if err != nil {
		return false, err
	}
	incoming, err := replacementPathState(repo.Path, journal.IncomingPath)
	if err != nil {
		return false, err
	}
	currentIsTarget := journal.CurrentPath != journal.ActivePath && !current.exists ||
		journal.CurrentPath == journal.ActivePath && fileMatches(active, journal.IncomingFingerprint)
	if !incoming.exists && fileMatches(active, journal.IncomingFingerprint) && fileMatches(outgoing, journal.CurrentFingerprint) &&
		currentIsTarget && active.info.Size() == journal.TargetFileSize &&
		fmt.Sprintf("stat:%d:%d", active.info.Size(), active.info.ModTime().UnixNano()) == journal.TargetContentHash.String {
		return true, nil
	}
	return false, nil
}

func canResumeIncomingCreation(root string, journal replacementJournal) bool {
	if journal.Action != "initial" || len(journal.IncomingData) == 0 || fingerprintBytes(journal.IncomingData) != journal.IncomingFingerprint {
		return false
	}
	current, err := replacementPathState(root, journal.CurrentPath)
	if err != nil || !fileMatches(current, journal.CurrentFingerprint) {
		return false
	}
	outgoing, err := replacementPathState(root, journal.OutgoingPath)
	if err != nil || outgoing.exists {
		return false
	}
	active, err := replacementPathState(root, journal.ActivePath)
	if err != nil {
		return false
	}
	return journal.ActivePath == journal.CurrentPath && samePathState(current, active) ||
		journal.ActivePath != journal.CurrentPath && !active.exists
}

func createAndSelectIncomingAttempt(repo *store.Repo, journal replacementJournal, attempt replacementIncomingAttempt) error {
	if attempt.phase != "reserved" || attempt.requestID != journal.RequestID {
		return fmt.Errorf("incoming attempt reservation is not valid for request %s", journal.RequestID)
	}
	if !canResumeIncomingCreation(repo.Path, journal) {
		return fmt.Errorf("incoming attempt cannot be created because the original representation layout is not verifiable; inspect request %s", journal.RequestID)
	}
	if err := os.MkdirAll(filepath.Dir(attempt.path), 0o700); err != nil {
		return fmt.Errorf("create dedicated replacement recovery directory: %w", err)
	}
	if _, err := replacementPathState(repo.Path, attempt.path); err != nil {
		return err
	}
	file, err := os.OpenFile(attempt.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("create reserved replacement attempt %s without overwrite: %w", attempt.path, err)
		}
		if markErr := markIncomingAttemptUntrusted(repo, journal, attempt.path, ""); markErr != nil {
			return errors.Join(err, markErr)
		}
		return fmt.Errorf("reserved attempt path is occupied by an unverified file; it was preserved: %s", attempt.path)
	}
	info, statErr := file.Stat()
	if statErr != nil {
		_ = file.Close()
		return statErr
	}
	identity, identityErr := replacementObjectIdentity(info)
	if identityErr != nil {
		_ = file.Close()
		return identityErr
	}
	replacementCrash("after-attempt-create")
	if err := replacementFault("incoming-after-exclusive-create"); err != nil {
		if closeErr := file.Close(); closeErr != nil {
			return errors.Join(err, closeErr)
		}
		return fmt.Errorf("new incoming attempt is unreceipted and preserved for inspection: %w", err)
	}
	if err := recordIncomingAttemptCreated(repo, attempt, identity); err != nil {
		if closeErr := file.Close(); closeErr != nil {
			return errors.Join(err, closeErr)
		}
		return fmt.Errorf("created attempt identity could not be receipted; file was preserved: %w", err)
	}
	attempt.identity = sql.NullString{String: identity, Valid: true}
	attempt.phase = "created"
	replacementCrash("after-attempt-receipt")
	if err := replacementFault("incoming-after-attempt-receipt"); err != nil {
		if closeErr := file.Close(); closeErr != nil {
			return errors.Join(err, closeErr)
		}
		return err
	}
	var written int
	if replacementIncomingWriteHook != nil {
		written, err = replacementIncomingWriteHook(file, journal.IncomingData)
	} else {
		written, err = file.Write(journal.IncomingData)
	}
	if err == nil && written != len(journal.IncomingData) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = replacementFault("incoming-after-short-write")
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return fmt.Errorf("replacement attempt write did not complete; partial evidence was preserved: %w", errors.Join(err, closeErr))
	}
	replacementCrash("after-attempt-write")
	state, err := replacementPathState(repo.Path, attempt.path)
	if err != nil {
		return err
	}
	if !state.exists || state.fingerprint != journal.IncomingFingerprint {
		return fmt.Errorf("replacement attempt failed full fingerprint verification; partial evidence was preserved: %s", attempt.path)
	}
	actualIdentity, err := replacementObjectIdentity(state.info)
	if err != nil || actualIdentity != identity {
		return fmt.Errorf("replacement attempt identity changed before verification; evidence was preserved: %s", attempt.path)
	}
	if replacementIncomingAttemptHook != nil {
		replacementIncomingAttemptHook("before-selection", attempt.path)
	}
	state, err = replacementPathState(repo.Path, attempt.path)
	if err != nil {
		return err
	}
	actualIdentity, err = replacementObjectIdentity(state.info)
	if err != nil || actualIdentity != identity || state.fingerprint != journal.IncomingFingerprint {
		if markErr := markIncomingAttemptUntrusted(repo, journal, attempt.path, state.fingerprint); markErr != nil {
			return errors.Join(fmt.Errorf("replacement attempt identity or bytes changed before selection; evidence was preserved"), markErr)
		}
		return fmt.Errorf("replacement attempt identity or bytes changed before selection; evidence was preserved: %s", attempt.path)
	}
	return selectVerifiedIncomingAttempt(repo, journal, attempt, state)
}

func reserveReplacementIncomingAttempt(repo *store.Repo, journal replacementJournal) (replacementIncomingAttempt, error) {
	attemptID, err := newReplacementRequestID()
	if err != nil {
		return replacementIncomingAttempt{}, err
	}
	path := replacementIncomingAttemptPath(repo, journal.ImageID, attemptID, filepath.Ext(journal.IncomingPath))
	if _, err := replacementPathState(repo.Path, path); err != nil {
		return replacementIncomingAttempt{}, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return replacementIncomingAttempt{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return replacementIncomingAttempt{}, err
	}
	current, err := scanReplacementJournal(tx.QueryRow(replacementJournalSelect+` WHERE request_id=? AND completed_at IS NULL`, journal.RequestID))
	if err != nil {
		return replacementIncomingAttempt{}, err
	}
	if current.Action != "initial" || current.IncomingFingerprint != journal.IncomingFingerprint ||
		current.CurrentPath != journal.CurrentPath || current.OutgoingPath != journal.OutgoingPath {
		return replacementIncomingAttempt{}, fmt.Errorf("replacement journal changed before reserving a new incoming attempt")
	}
	var collision bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM replacement_path_reservations WHERE path=?)
		OR EXISTS(SELECT 1 FROM replacement_incoming_attempts WHERE path=?)`, path, path).Scan(&collision); err != nil {
		return replacementIncomingAttempt{}, err
	}
	if collision {
		return replacementIncomingAttempt{}, fmt.Errorf("unpredictable replacement attempt path is already reserved: %s", path)
	}
	if _, err := tx.Exec(`INSERT INTO replacement_incoming_attempts(attempt_id,request_id,image_id,path,phase,protected)
		VALUES(?,?,?,?,'reserved',1)`, attemptID, journal.RequestID, journal.ImageID, path); err != nil {
		return replacementIncomingAttempt{}, err
	}
	if _, err := tx.Exec(`INSERT INTO replacement_path_reservations(path,request_id) VALUES(?,?)`, path, journal.RequestID); err != nil {
		return replacementIncomingAttempt{}, err
	}
	if err := tx.Commit(); err != nil {
		return replacementIncomingAttempt{}, err
	}
	replacementCrash("after-attempt-reserve")
	return replacementIncomingAttempt{id: attemptID, requestID: journal.RequestID, path: path, phase: "reserved"}, nil
}

func recordIncomingAttemptCreated(repo *store.Repo, attempt replacementIncomingAttempt, identity string) error {
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	updated, err := tx.Exec(`UPDATE replacement_incoming_attempts SET phase='created',object_identity=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE attempt_id=? AND request_id=? AND phase='reserved' AND object_identity IS NULL`, identity, attempt.id, attempt.requestID)
	if err != nil {
		return err
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("incoming attempt identity receipt was not recorded: rows=%d err=%v", count, err)
	}
	return tx.Commit()
}

func selectVerifiedIncomingAttempt(repo *store.Repo, journal replacementJournal, attempt replacementIncomingAttempt, state replacementPath) error {
	if !state.exists || state.fingerprint != journal.IncomingFingerprint {
		return fmt.Errorf("incoming replacement attempt is not complete and verified: %s", attempt.path)
	}
	identity, err := replacementObjectIdentity(state.info)
	if err != nil {
		return err
	}
	if !attempt.identity.Valid || attempt.identity.String != identity {
		return fmt.Errorf("incoming attempt identity has not been receipted: %s", attempt.path)
	}
	forward, err := rewriteRepresentationHistoryPath(journal.HistoryForward, journal.IncomingPath, attempt.path)
	if err != nil {
		return err
	}
	inverse, err := rewriteRepresentationHistoryPath(journal.HistoryInverse, journal.IncomingPath, attempt.path)
	if err != nil {
		return err
	}
	marker := fmt.Sprintf("stat:%d:%d", state.info.Size(), state.info.ModTime().UnixNano())
	if replacementIncomingAttemptHook != nil {
		replacementIncomingAttemptHook("selection-transaction", attempt.path)
	}
	state, err = replacementPathState(repo.Path, attempt.path)
	if err != nil {
		return err
	}
	identityNow, err := replacementObjectIdentity(state.info)
	if err != nil || identityNow != identity || state.fingerprint != journal.IncomingFingerprint {
		if markErr := markIncomingAttemptUntrusted(repo, journal, attempt.path, state.fingerprint); markErr != nil {
			return errors.Join(fmt.Errorf("incoming attempt changed before selection; evidence was preserved"), markErr)
		}
		return fmt.Errorf("incoming attempt changed before selection; evidence was preserved: %s", attempt.path)
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return err
	}
	updated, err := tx.Exec(`UPDATE replacement_replay_journal SET incoming_path=?,history_forward=?,history_inverse=?,
		target_file_size=?,target_content_hash=?,phase='incoming-ready'
		WHERE request_id=? AND completed_at IS NULL AND action='initial' AND incoming_fingerprint=?`,
		attempt.path, forward, inverse, state.info.Size(), marker, journal.RequestID, journal.IncomingFingerprint)
	if err != nil {
		return err
	}
	count, err := updated.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("verified replacement attempt could not be selected: rows=%d err=%v", count, err)
	}
	if _, err := tx.Exec(`UPDATE replacement_incoming_attempts SET phase='superseded',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE request_id=? AND attempt_id!=? AND phase IN ('reserved','created','verified','selected')`, journal.RequestID, attempt.id); err != nil {
		return err
	}
	selected, err := tx.Exec(`UPDATE replacement_incoming_attempts SET phase='selected',fingerprint=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		WHERE attempt_id=? AND request_id=? AND phase IN ('created','verified','selected') AND object_identity=?`,
		journal.IncomingFingerprint, attempt.id, journal.RequestID, identity)
	if err != nil {
		return err
	}
	count, err = selected.RowsAffected()
	if err != nil || count != 1 {
		return fmt.Errorf("verified attempt was not receipted as selected: rows=%d err=%v", count, err)
	}
	if err := bumpDiscoveryGenerationTx(tx); err != nil {
		return err
	}
	return tx.Commit()
}
