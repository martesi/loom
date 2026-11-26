package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestReplacementGenerationRejectsPreIntentDiscoveryPublicationAfterRelease(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "asset.png")
	if err := os.WriteFile(path, []byte("pre-intent bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	oldFingerprint, oldInfo, err := FingerprintFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	oldMarker := fmt.Sprintf("stat:%d:%d", oldInfo.Size(), oldInfo.ModTime().UnixNano())
	if _, err := repo.DB.Exec(`INSERT INTO images(file_path,file_size,content_hash,source_fingerprint,source_revision) VALUES(?,?,?,?,1)`, path, oldInfo.Size(), oldMarker, oldFingerprint); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	releaseScan := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(1)
	var scanErr error
	go func() {
		defer wait.Done()
		_, scanErr = repo.scanAndRegisterImagesWithFingerprint(context.Background(), true, func(ctx context.Context, current string) (string, os.FileInfo, error) {
			staleInfo, err := os.Stat(current)
			if err != nil {
				return "", nil, err
			}
			close(started)
			<-releaseScan
			return oldFingerprint, staleInfo, nil
		})
	}()
	<-started
	if err := os.WriteFile(path, []byte("replacement bytes are newer"), 0o600); err != nil {
		close(releaseScan)
		t.Fatal(err)
	}
	newFingerprint, newInfo, err := FingerprintFile(context.Background(), path)
	if err != nil {
		close(releaseScan)
		t.Fatal(err)
	}
	newMarker := fmt.Sprintf("stat:%d:%d", newInfo.Size(), newInfo.ModTime().UnixNano())
	tx, err := repo.DB.Begin()
	if err != nil {
		close(releaseScan)
		t.Fatal(err)
	}
	if _, err := tx.Exec(`UPDATE operation_log SET seq=seq WHERE 0`); err != nil {
		tx.Rollback()
		close(releaseScan)
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO replacement_replay_journal(request_id,request_hash,repo_path,image_id,action,phase,history_seq,expected_cursor,history_kind,history_forward,history_inverse,current_path,outgoing_path,incoming_path,active_path,current_fingerprint,incoming_fingerprint,expected_row_path,expected_row_fingerprint,expected_row_revision,expected_row_file_size,expected_row_content_hash,target_file_size,target_content_hash,target_source_fingerprint,target_source_revision)
		VALUES ('generation-test','hash',? ,1,'initial','reserved',1,0,'kind','f','i',?,?,?,?,?,?,?,?,1,?,?,?,NULL,?,2)`,
		root, path, path+".stash", path+".incoming", path+".target", oldFingerprint, newFingerprint, path, oldFingerprint, oldInfo.Size(), oldMarker, newInfo.Size(), newFingerprint); err != nil {
		tx.Rollback()
		close(releaseScan)
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO replacement_path_reservations(path,request_id) VALUES(?, 'generation-test')`, path); err != nil {
		tx.Rollback()
		close(releaseScan)
		t.Fatal(err)
	}
	if _, err := tx.Exec(`UPDATE images SET file_size=?,content_hash=?,source_fingerprint=?,source_revision=source_revision+1 WHERE file_path=?`, newInfo.Size(), newMarker, newFingerprint, path); err != nil {
		tx.Rollback()
		close(releaseScan)
		t.Fatal(err)
	}
	if _, err := tx.Exec(`UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='discovery_generation'`); err != nil {
		tx.Rollback()
		close(releaseScan)
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		close(releaseScan)
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`DELETE FROM replacement_path_reservations WHERE request_id='generation-test'`); err != nil {
		close(releaseScan)
		t.Fatal(err)
	}
	close(releaseScan)
	wait.Wait()
	if scanErr != nil {
		t.Fatalf("stale discovery pass: %v", scanErr)
	}
	var current string
	if err := repo.DB.QueryRow(`SELECT source_fingerprint FROM images WHERE file_path=?`, path).Scan(&current); err != nil {
		t.Fatal(err)
	}
	if current != newFingerprint {
		t.Fatalf("pre-intent discovery overwrote the replacement fingerprint: got %s want %s", current, newFingerprint)
	}
}
