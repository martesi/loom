package service

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"loom/internal/store"
)

type ReplacementResult struct {
	Applied             bool   `json:"applied"`
	PendingRecovery     bool   `json:"pendingRecovery"`
	RequestID           string `json:"requestId"`
	ImageID             int64  `json:"imageId"`
	Action              string `json:"action,omitempty"`
	Kind                string `json:"kind,omitempty"`
	Phase               string `json:"phase,omitempty"`
	Message             string `json:"message,omitempty"`
	CurrentPath         string `json:"currentPath,omitempty"`
	OutgoingPath        string `json:"outgoingPath,omitempty"`
	IncomingPath        string `json:"incomingPath,omitempty"`
	ActivePath          string `json:"activePath,omitempty"`
	CurrentFingerprint  string `json:"currentFingerprint,omitempty"`
	IncomingFingerprint string `json:"incomingFingerprint,omitempty"`
}

func (s *ImageService) ListPendingReplacementRecoveries(repoPath string) ([]ReplacementResult, error) {
	repo, unlock, err := openOperationRepoRaw(repoPath)
	if err != nil {
		return nil, err
	}
	defer unlock()
	defer repo.Close()
	if recoveryErr := recoverReplacementJournals(repo); recoveryErr != nil {
		var pending *replacementRecoveryError
		if !errors.As(recoveryErr, &pending) && !isFilesystemHistoryPending(recoveryErr) {
			return nil, recoveryErr
		}
	}
	requestIDs, err := activeReplacementRequestIDs(repo)
	if err != nil {
		return nil, err
	}
	results := make([]ReplacementResult, 0, len(requestIDs))
	for _, requestID := range requestIDs {
		journal, err := scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE request_id=? AND completed_at IS NULL`, requestID))
		if err != nil {
			return nil, err
		}
		result := pendingReplacementResult(journal, "Replacement recovery requires attention.")
		results = append(results, *result)
	}
	return results, nil
}

type replacementJournal struct {
	RequestID              string
	RequestHash            string
	RepoPath               string
	ImageID                int64
	Action                 string
	Phase                  string
	HistorySeq             int64
	ExpectedCursor         int64
	HistoryKind            string
	HistoryForward         string
	HistoryInverse         string
	HistoryCreatedAt       sql.NullString
	CurrentPath            string
	OutgoingPath           string
	IncomingPath           string
	ActivePath             string
	CurrentFingerprint     string
	IncomingFingerprint    string
	IncomingData           []byte
	ExpectedRowPath        string
	ExpectedRowFingerprint string
	ExpectedRowRevision    int64
	ExpectedRowFileSize    int64
	ExpectedRowContentHash string
	TargetFileSize         int64
	TargetContentHash      sql.NullString
	TargetFingerprint      string
	TargetRevision         int64
	ResultJSON             sql.NullString
	CompletedAt            sql.NullString
}

var replacementJournalFaultHook func(string) error
var replacementJournalCrashHook func(string)
var replacementNoReplaceLinkHook func(string, string) error

const replacementJournalSelect = `SELECT request_id,request_hash,repo_path,image_id,action,phase,
	history_seq,expected_cursor,history_kind,history_forward,history_inverse,history_created_at,
	current_path,outgoing_path,incoming_path,active_path,current_fingerprint,incoming_fingerprint,incoming_data,
	expected_row_path,expected_row_fingerprint,expected_row_revision,expected_row_file_size,
	expected_row_content_hash,target_file_size,target_content_hash,target_source_fingerprint,
	target_source_revision,result_json,completed_at FROM replacement_replay_journal`

func scanReplacementJournal(scanner interface{ Scan(...any) error }) (replacementJournal, error) {
	var journal replacementJournal
	err := scanner.Scan(
		&journal.RequestID, &journal.RequestHash, &journal.RepoPath, &journal.ImageID, &journal.Action, &journal.Phase,
		&journal.HistorySeq, &journal.ExpectedCursor, &journal.HistoryKind, &journal.HistoryForward,
		&journal.HistoryInverse, &journal.HistoryCreatedAt, &journal.CurrentPath, &journal.OutgoingPath,
		&journal.IncomingPath, &journal.ActivePath, &journal.CurrentFingerprint, &journal.IncomingFingerprint, &journal.IncomingData,
		&journal.ExpectedRowPath, &journal.ExpectedRowFingerprint, &journal.ExpectedRowRevision,
		&journal.ExpectedRowFileSize, &journal.ExpectedRowContentHash, &journal.TargetFileSize,
		&journal.TargetContentHash, &journal.TargetFingerprint, &journal.TargetRevision,
		&journal.ResultJSON, &journal.CompletedAt,
	)
	return journal, err
}

func replacementRequestHash(repoPath string, imageID int64, name string, data []byte) string {
	hash := sha256.New()
	fmt.Fprintf(hash, "%s\x00%d\x00%s\x00", repoPath, imageID, filepath.Base(name))
	content := sha256.Sum256(data)
	hash.Write(content[:])
	return hex.EncodeToString(hash.Sum(nil))
}

func replacementReplayRequestHash(repoPath string, redo bool, op *store.Operation) string {
	_ = op
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%t", repoPath, redo)))
	return hex.EncodeToString(hash[:])
}

func replacementStashPath(repo *store.Repo, imageID int64, requestID, prefix, ext string) string {
	requestDigest := sha256.Sum256([]byte(requestID))
	return filepath.Join(repo.Path, ".loom", "trash", "replacements", fmt.Sprint(imageID), prefix+hex.EncodeToString(requestDigest[:])+ext)
}

func replacementIncomingAttemptPath(repo *store.Repo, imageID int64, attemptID, ext string) string {
	return filepath.Join(repo.Path, ".loom", "recovery", "replacements", fmt.Sprint(imageID), attemptID+ext)
}

func newReplacementRequestID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(random[:]), nil
}

func finishReplacementRequest(repo *store.Repo, journal replacementJournal) (*ReplacementResult, error) {
	if err := processReplacementJournal(repo, journal); err != nil {
		latest, scanErr := scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE request_id=?`, journal.RequestID))
		if scanErr == nil && latest.CompletedAt.Valid {
			return readReplacementReceiptResult(repo, latest)
		}
		if scanErr == nil {
			return pendingReplacementResult(latest, err.Error()), nil
		}
		return nil, errors.Join(err, scanErr)
	}
	latest, err := scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE request_id=?`, journal.RequestID))
	if err != nil {
		return nil, err
	}
	return readReplacementReceiptResult(repo, latest)
}

func readReplacementReceiptResult(repo *store.Repo, journal replacementJournal) (*ReplacementResult, error) {
	if !journal.CompletedAt.Valid || !journal.ResultJSON.Valid {
		return pendingReplacementResult(journal, "Replacement recovery has not committed."), nil
	}
	var result ReplacementResult
	if err := json.Unmarshal([]byte(journal.ResultJSON.String), &result); err != nil {
		return nil, fmt.Errorf("decode replacement result receipt: %w", err)
	}
	return &result, nil
}

func readReplacementReceipt(repo *store.Repo, requestID, requestHash string) (*ReplacementResult, bool, error) {
	journal, err := scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE request_id=?`, requestID))
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if journal.RequestHash != requestHash {
		return nil, true, fmt.Errorf("replacement request ID was already used with different arguments")
	}
	if journal.CompletedAt.Valid && journal.ResultJSON.Valid {
		var result ReplacementResult
		if err := json.Unmarshal([]byte(journal.ResultJSON.String), &result); err != nil {
			return nil, true, fmt.Errorf("decode replacement receipt: %w", err)
		}
		return &result, true, nil
	}
	result := pendingReplacementResult(journal, "Replacement recovery is still pending.")
	return result, true, nil
}

func pendingReplacementResult(journal replacementJournal, message string) *ReplacementResult {
	return &ReplacementResult{
		PendingRecovery:     true,
		RequestID:           journal.RequestID,
		ImageID:             journal.ImageID,
		Action:              journal.Action,
		Kind:                journal.HistoryKind,
		Phase:               journal.Phase,
		CurrentPath:         journal.CurrentPath,
		OutgoingPath:        journal.OutgoingPath,
		IncomingPath:        journal.IncomingPath,
		ActivePath:          journal.ActivePath,
		CurrentFingerprint:  journal.CurrentFingerprint,
		IncomingFingerprint: journal.IncomingFingerprint,
		Message:             fmt.Sprintf("%s Inspect request %s for image %d (%s -> %s); Loom will not overwrite or delete ambiguous files.", message, journal.RequestID, journal.ImageID, journal.CurrentPath, journal.ActivePath),
	}
}

func activeReplacementRequestIDs(repo *store.Repo) ([]string, error) {
	rows, err := repo.DB.Query(`SELECT request_id FROM replacement_replay_journal WHERE completed_at IS NULL ORDER BY created_at,request_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var requestIDs []string
	for rows.Next() {
		var requestID string
		if err := rows.Scan(&requestID); err != nil {
			return nil, err
		}
		requestIDs = append(requestIDs, requestID)
	}
	return requestIDs, rows.Err()
}

func pendingReplacementForImage(repo *store.Repo, imageID int64) (*replacementJournal, error) {
	journal, err := scanReplacementJournal(repo.DB.QueryRow(replacementJournalSelect+` WHERE image_id=? AND completed_at IS NULL`, imageID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &journal, nil
}

func reserveReplacementJournal(repo *store.Repo, image store.Image, requestID, requestHash, name string, data []byte, currentFingerprint string) (replacementJournal, error) {
	stashDir := filepath.Join(repo.Path, ".loom", "trash", "replacements", fmt.Sprint(image.ID))
	if err := os.MkdirAll(stashDir, 0o755); err != nil {
		return replacementJournal{}, err
	}
	attemptID, err := newReplacementRequestID()
	if err != nil {
		return replacementJournal{}, err
	}
	incomingPath := replacementIncomingAttemptPath(repo, image.ID, attemptID, filepath.Ext(name))
	outgoingPath := replacementStashPath(repo, image.ID, requestID, "original-", filepath.Ext(image.FilePath))
	if err := validateReplacementPathSet(repo.Path, image.FilePath, outgoingPath, incomingPath, image.FilePath); err != nil {
		return replacementJournal{}, err
	}
	if err := requireMissingRegularTarget(repo.Path, outgoingPath); err != nil {
		return replacementJournal{}, err
	}
	if err := requireMissingRegularTarget(repo.Path, incomingPath); err != nil {
		return replacementJournal{}, err
	}
	tx, err := repo.DB.Begin()
	if err != nil {
		return replacementJournal{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		return replacementJournal{}, fmt.Errorf("lock replacement reservation: %w", err)
	}
	if err := rejectLegacyRedoTailRequestID(tx, requestID); err != nil {
		return replacementJournal{}, err
	}
	var historyRequestUsed bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM history_replay_requests WHERE request_id=?)`, requestID).Scan(&historyRequestUsed); err != nil {
		return replacementJournal{}, err
	}
	if historyRequestUsed {
		return replacementJournal{}, fmt.Errorf("replacement request ID was already used for history replay")
	}
	row, err := replacementImageSnapshot(tx, image.ID)
	if err != nil {
		return replacementJournal{}, err
	}
	if row.path != image.FilePath || row.revision != image.SourceRevision || row.fileSize != image.FileSize || row.fingerprint != image.SourceFingerprint {
		return replacementJournal{}, fmt.Errorf("image %d changed before replacement reservation; reload and retry", image.ID)
	}
	activePath, err := chooseReplacementPathTx(tx, repo.Path, image, name)
	if err != nil {
		return replacementJournal{}, err
	}
	if err := validateReplacementPathSet(repo.Path, image.FilePath, outgoingPath, incomingPath, activePath); err != nil {
		return replacementJournal{}, err
	}
	if err := requireMissingRegularTarget(repo.Path, activePath); err != nil && activePath != image.FilePath {
		return replacementJournal{}, err
	}
	if err := requireExistingFingerprint(repo.Path, image.FilePath, currentFingerprint); err != nil {
		return replacementJournal{}, err
	}
	var cursor int64
	if err := tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM settings WHERE scope='repo' AND key='undo_cursor'`).Scan(&cursor); err != nil && err != sql.ErrNoRows {
		return replacementJournal{}, err
	}
	newFingerprint := fingerprintBytes(data)
	targetRevision := row.revision + 1
	if currentFingerprint == newFingerprint {
		targetRevision = row.revision
	}
	journal := replacementJournal{
		RequestID: requestID, RequestHash: requestHash, RepoPath: repo.Path, ImageID: image.ID, Action: "initial", Phase: "reserved",
		HistorySeq: cursor + 1, ExpectedCursor: cursor, HistoryKind: stepRepresentation,
		CurrentPath: image.FilePath, OutgoingPath: outgoingPath, IncomingPath: incomingPath, ActivePath: activePath,
		CurrentFingerprint: currentFingerprint, IncomingFingerprint: newFingerprint, IncomingData: append([]byte(nil), data...),
		ExpectedRowPath: row.path, ExpectedRowFingerprint: row.fingerprint, ExpectedRowRevision: row.revision,
		ExpectedRowFileSize: row.fileSize, ExpectedRowContentHash: row.contentHash,
		TargetFileSize: int64(len(data)), TargetContentHash: sql.NullString{}, TargetFingerprint: newFingerprint,
		TargetRevision: targetRevision,
	}
	forward := representationStepPayload{ImageID: image.ID, OutgoingStash: outgoingPath, IncomingPath: incomingPath, ActivePath: activePath, CurrentFingerprint: currentFingerprint, IncomingFingerprint: newFingerprint}
	inverse := representationStepPayload{ImageID: image.ID, OutgoingStash: incomingPath, IncomingPath: outgoingPath, ActivePath: image.FilePath, CurrentFingerprint: newFingerprint, IncomingFingerprint: currentFingerprint}
	forwardJSON, err := marshalHistoryStep(step(stepRepresentation, forward))
	if err != nil {
		return replacementJournal{}, err
	}
	inverseJSON, err := marshalHistoryStep(step(stepRepresentation, inverse))
	if err != nil {
		return replacementJournal{}, err
	}
	journal.HistoryForward, journal.HistoryInverse = forwardJSON, inverseJSON
	if err := insertReplacementJournalTx(tx, journal); err != nil {
		return replacementJournal{}, err
	}
	if _, err := tx.Exec(`INSERT INTO replacement_incoming_attempts(attempt_id,request_id,image_id,path,phase,protected)
		VALUES(?,?,?,?, 'reserved',1)`, attemptID, requestID, image.ID, incomingPath); err != nil {
		return replacementJournal{}, fmt.Errorf("reserve replacement incoming attempt: %w", err)
	}
	for _, path := range uniqueStrings([]string{image.FilePath, outgoingPath, incomingPath, activePath}) {
		if _, err := tx.Exec(`INSERT INTO replacement_path_reservations(path,request_id) VALUES (?,?)`, path, requestID); err != nil {
			return replacementJournal{}, fmt.Errorf("reserve replacement path %s: %w", path, err)
		}
	}
	if err := bumpDiscoveryGenerationTx(tx); err != nil {
		return replacementJournal{}, err
	}
	if err := tx.Commit(); err != nil {
		return replacementJournal{}, err
	}
	return journal, nil
}

func bumpDiscoveryGenerationTx(tx *sql.Tx) error {
	_, err := tx.Exec(`INSERT INTO settings(scope,key,value) VALUES ('repo','discovery_generation','1')
		ON CONFLICT(scope,key) DO UPDATE SET value=CAST(value AS INTEGER)+1`)
	return err
}

func insertReplacementJournalTx(tx *sql.Tx, journal replacementJournal) error {
	_, err := tx.Exec(`INSERT INTO replacement_replay_journal(
		request_id,request_hash,repo_path,image_id,action,phase,history_seq,expected_cursor,history_kind,
		history_forward,history_inverse,history_created_at,current_path,outgoing_path,incoming_path,
		active_path,current_fingerprint,incoming_fingerprint,incoming_data,expected_row_path,expected_row_fingerprint,
		expected_row_revision,expected_row_file_size,expected_row_content_hash,target_file_size,
		target_content_hash,target_source_fingerprint,target_source_revision)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		journal.RequestID, journal.RequestHash, journal.RepoPath, journal.ImageID, journal.Action, journal.Phase,
		journal.HistorySeq, journal.ExpectedCursor, journal.HistoryKind, journal.HistoryForward,
		journal.HistoryInverse, nullableString(journal.HistoryCreatedAt), journal.CurrentPath,
		journal.OutgoingPath, journal.IncomingPath, journal.ActivePath, journal.CurrentFingerprint,
		journal.IncomingFingerprint, journal.IncomingData, journal.ExpectedRowPath, journal.ExpectedRowFingerprint,
		journal.ExpectedRowRevision, journal.ExpectedRowFileSize, journal.ExpectedRowContentHash,
		journal.TargetFileSize, nullableString(journal.TargetContentHash), journal.TargetFingerprint,
		journal.TargetRevision)
	return err
}

func nullableString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func marshalHistoryStep(step OpStep) (string, error) {
	data, err := json.Marshal(step)
	return string(data), err
}

func fingerprintBytes(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
