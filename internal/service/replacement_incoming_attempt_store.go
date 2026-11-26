package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"

	"loom/internal/store"
)

func rewriteRepresentationHistoryPath(raw, oldPath, newPath string) (string, error) {
	var history OpStep
	if err := json.Unmarshal([]byte(raw), &history); err != nil {
		return "", err
	}
	if history.Kind != stepRepresentation {
		return "", fmt.Errorf("replacement history payload has kind %q", history.Kind)
	}
	var payload representationStepPayload
	if err := json.Unmarshal(history.Payload, &payload); err != nil {
		return "", err
	}
	changed := false
	if payload.IncomingPath == oldPath {
		payload.IncomingPath = newPath
		changed = true
	}
	if payload.OutgoingStash == oldPath {
		payload.OutgoingStash = newPath
		changed = true
	}
	if !changed {
		return "", fmt.Errorf("replacement history payload does not reference selected incoming path %s", oldPath)
	}
	encoded, err := json.Marshal(step(stepRepresentation, payload))
	return string(encoded), err
}

func markIncomingAttemptUntrusted(repo *store.Repo, journal replacementJournal, path, fingerprint string) error {
	var attemptID string
	err := repo.DB.QueryRow(`SELECT attempt_id FROM replacement_incoming_attempts WHERE request_id=? AND path=?`, journal.RequestID, path).Scan(&attemptID)
	if err == sql.ErrNoRows {
		attemptID, err = newReplacementRequestID()
		if err != nil {
			return err
		}
		_, err = repo.DB.Exec(`INSERT INTO replacement_incoming_attempts(attempt_id,request_id,image_id,path,phase,fingerprint,protected)
			VALUES(?,?,?,?,'untrusted',?,1)`, attemptID, journal.RequestID, journal.ImageID, path, nullableFingerprint(fingerprint))
		return err
	}
	if err != nil {
		return err
	}
	_, err = repo.DB.Exec(`UPDATE replacement_incoming_attempts SET phase='untrusted',fingerprint=COALESCE(?,fingerprint),
		updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE attempt_id=?`, nullableFingerprint(fingerprint), attemptID)
	return err
}

func nullableFingerprint(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func readIncomingAttempt(db *sql.DB, requestID, path string) (replacementIncomingAttempt, error) {
	var attempt replacementIncomingAttempt
	err := db.QueryRow(`SELECT attempt_id,request_id,path,phase,object_identity,fingerprint
		FROM replacement_incoming_attempts WHERE request_id=? AND path=?`, requestID, path).
		Scan(&attempt.id, &attempt.requestID, &attempt.path, &attempt.phase, &attempt.identity, &attempt.fingerprint)
	return attempt, err
}

func listIncomingAttempts(db *sql.DB, requestID string) ([]replacementIncomingAttempt, error) {
	rows, err := db.Query(`SELECT attempt_id,request_id,path,phase,object_identity,fingerprint
		FROM replacement_incoming_attempts WHERE request_id=? ORDER BY created_at DESC,attempt_id DESC`, requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var attempts []replacementIncomingAttempt
	for rows.Next() {
		var attempt replacementIncomingAttempt
		if err := rows.Scan(&attempt.id, &attempt.requestID, &attempt.path, &attempt.phase, &attempt.identity, &attempt.fingerprint); err != nil {
			return nil, err
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

func replacementObjectIdentity(info os.FileInfo) (string, error) {
	value := reflect.ValueOf(info.Sys())
	for value.IsValid() && value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return "", fmt.Errorf("filesystem does not expose a stable file identity")
	}
	field := func(name string) (string, bool) {
		item := value.FieldByName(name)
		if !item.IsValid() {
			return "", false
		}
		return fmt.Sprint(item.Interface()), true
	}
	device, hasDevice := field("Dev")
	inode, hasInode := field("Ino")
	if hasDevice && hasInode {
		return device + ":" + inode, nil
	}
	volume, hasVolume := field("VolumeSerialNumber")
	high, hasHigh := field("FileIndexHigh")
	low, hasLow := field("FileIndexLow")
	if hasVolume && hasHigh && hasLow {
		return strings.Join([]string{volume, high, low}, ":"), nil
	}
	return "", fmt.Errorf("filesystem does not expose a stable file identity")
}
