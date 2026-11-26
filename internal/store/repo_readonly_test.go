package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenExistingReadOnlyDoesNotInitializeOrWrite(t *testing.T) {
	root := filepath.Join(t.TempDir(), "repo with spaces")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenExistingReadOnly(root); err == nil {
		t.Fatal("opened repository without an existing migrated database")
	}
	if _, err := os.Stat(filepath.Join(root, ".loom")); !os.IsNotExist(err) {
		t.Fatalf("read-only open created .loom: %v", err)
	}

	created, err := Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := created.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadDir(filepath.Join(root, ".loom"))
	if err != nil {
		t.Fatal(err)
	}
	repo, err := OpenExistingReadOnly(root)
	if err != nil {
		t.Fatalf("open existing: %v", err)
	}
	if _, err := repo.DB.Exec(`CREATE TABLE forbidden_write (id INTEGER)`); err == nil {
		t.Fatal("read-only database accepted a schema write")
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadDir(filepath.Join(root, ".loom"))
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatalf("read-only open changed repository files: before=%v after=%v", before, after)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(filepath.Join(root, ".loom", "db.sqlite"+suffix)); !os.IsNotExist(err) {
			t.Fatalf("read-only open created WAL sidecar %s: %v", suffix, err)
		}
	}
}

func TestOpenExistingReadOnlyFailsExplicitlyWhenWALStateIsIncomplete(t *testing.T) {
	root := t.TempDir()
	repo, err := Bootstrap(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	walPath := filepath.Join(root, ".loom", "db.sqlite-wal")
	if err := os.WriteFile(walPath, []byte("isolated incomplete WAL fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenExistingReadOnly(root); err == nil {
		t.Fatal("opened a repository with incomplete WAL state")
	}
	if _, err := os.Stat(walPath); err != nil {
		t.Fatalf("read-only open changed the WAL fixture: %v", err)
	}
}
