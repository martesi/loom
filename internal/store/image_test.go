package store

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFixture(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestListDirectoryRegistersFiles confirms ListDirectory finds media files
// non-recursively and registers each with a real images row, the same
// INSERT OR IGNORE idiom ScanAndRegisterImages uses for repo-wide scans.
func TestListDirectoryRegistersFiles(t *testing.T) {
	repoPath := t.TempDir()
	writeFixture(t, filepath.Join(repoPath, "top.png"))
	writeFixture(t, filepath.Join(repoPath, "notes.txt")) // non-media, ignored
	writeFixture(t, filepath.Join(repoPath, "sub", "nested.png"))

	repo, err := Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	listing, err := repo.ListDirectory("")
	if err != nil {
		t.Fatalf("ListDirectory: %v", err)
	}
	if len(listing.Files) != 1 || filepath.Base(listing.Files[0].FilePath) != "top.png" {
		t.Fatalf("expected exactly top.png in root listing, got %+v", listing.Files)
	}
	if len(listing.Dirs) != 1 || listing.Dirs[0] != "sub" {
		t.Fatalf("expected 'sub' subdirectory, got %+v", listing.Dirs)
	}
	if listing.Files[0].ID == 0 {
		t.Fatalf("expected a real images row (nonzero id), got %+v", listing.Files[0])
	}

	// The nested file should not appear in the non-recursive root listing,
	// but should appear (and be registered) when listing "sub" directly.
	subListing, err := repo.ListDirectory("sub")
	if err != nil {
		t.Fatalf("ListDirectory(sub): %v", err)
	}
	if len(subListing.Files) != 1 || filepath.Base(subListing.Files[0].FilePath) != "nested.png" {
		t.Fatalf("expected exactly nested.png in sub listing, got %+v", subListing.Files)
	}

	all, err := repo.ListImages()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2 registered images total after both listings, got %d: %+v", len(all), all)
	}

	// Listing the same directory again must not duplicate rows.
	if _, err := repo.ListDirectory(""); err != nil {
		t.Fatalf("ListDirectory (second pass): %v", err)
	}
	all2, err := repo.ListImages()
	if err != nil {
		t.Fatal(err)
	}
	if len(all2) != 2 {
		t.Fatalf("re-listing duplicated rows: got %d, want 2", len(all2))
	}
}

// TestListDirectoryClampsEscape confirms a relPath trying to climb above
// the repo root via ".." is rejected rather than ever resolving outside it,
// and that a real subdirectory still lists fine.
func TestListDirectoryClampsEscape(t *testing.T) {
	repoPath := t.TempDir()
	writeFixture(t, filepath.Join(repoPath, "in.png"))

	// A sibling directory to repoPath that must never become visible via a
	// ".." escape.
	outside := filepath.Dir(repoPath)
	writeFixture(t, filepath.Join(outside, "outside.png"))
	t.Cleanup(func() { os.Remove(filepath.Join(outside, "outside.png")) })

	repo, err := Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	if _, err := repo.ListDirectory("../"); err == nil {
		t.Fatalf("expected ListDirectory(\"../\") to be rejected as an escape attempt")
	}
	if _, err := repo.ListDirectory("../../../etc"); err == nil {
		t.Fatalf("expected ListDirectory to reject a multi-level escape")
	}
	if _, _, err := clampRelPath(repoPath, "../../../etc/passwd"); err == nil {
		t.Fatalf("expected clampRelPath to reject a multi-level escape")
	}

	// A legitimate subdirectory must still work.
	if err := os.MkdirAll(filepath.Join(repoPath, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ListDirectory("sub"); err != nil {
		t.Fatalf("ListDirectory(sub): %v", err)
	}
}

// TestSetTrashedMovesFilePhysically confirms trashing an image moves its
// file into .loom/trash/<relative path>, and restoring moves it back —
// including when the original location is occupied by something else by
// the time of the restore (collision-suffix case).
func TestSetTrashedMovesFilePhysically(t *testing.T) {
	repoPath := t.TempDir()
	origPath := filepath.Join(repoPath, "sub", "pic.png")
	writeFixture(t, origPath)

	repo, err := Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, origPath)
	if err != nil {
		t.Fatal(err)
	}
	imageID, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}

	if err := repo.SetTrashed(imageID, true); err != nil {
		t.Fatalf("SetTrashed(true): %v", err)
	}

	wantTrashPath := filepath.Join(repoPath, loomDirName, "trash", "sub", "pic.png")
	if _, err := os.Stat(wantTrashPath); err != nil {
		t.Fatalf("expected file at %s after trashing: %v", wantTrashPath, err)
	}
	if _, err := os.Stat(origPath); !os.IsNotExist(err) {
		t.Fatalf("expected original path %s to no longer exist, stat err = %v", origPath, err)
	}

	gotPath, err := repo.GetFilePath(imageID)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != wantTrashPath {
		t.Fatalf("file_path not updated: got %q, want %q", gotPath, wantTrashPath)
	}

	// Something else now occupies the original location — restore must
	// collision-suffix rather than overwrite it.
	writeFixture(t, origPath)

	if err := repo.SetTrashed(imageID, false); err != nil {
		t.Fatalf("SetTrashed(false): %v", err)
	}

	wantRestoredPath := filepath.Join(repoPath, "sub", "pic (1).png")
	if _, err := os.Stat(wantRestoredPath); err != nil {
		t.Fatalf("expected collision-suffixed restore at %s: %v", wantRestoredPath, err)
	}
	// The file that was occupying the original spot must be untouched.
	if data, err := os.ReadFile(origPath); err != nil || string(data) != "fixture" {
		t.Fatalf("occupying file at %s was disturbed: data=%q err=%v", origPath, data, err)
	}

	gotPath2, err := repo.GetFilePath(imageID)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath2 != wantRestoredPath {
		t.Fatalf("file_path not updated after restore: got %q, want %q", gotPath2, wantRestoredPath)
	}

	trashed, err := repo.DB.Query(`SELECT trashed FROM images WHERE id = ?`, imageID)
	if err != nil {
		t.Fatal(err)
	}
	defer trashed.Close()
	if !trashed.Next() {
		t.Fatal("expected a row")
	}
	var flag bool
	if err := trashed.Scan(&flag); err != nil {
		t.Fatal(err)
	}
	if flag {
		t.Fatalf("expected trashed flag false after restore")
	}
}

// TestMoveFile confirms MoveFile physically relocates the file and updates
// file_path, and that its op-log inverse (moving it back via the same
// function) round-trips.
func TestMoveFile(t *testing.T) {
	repoPath := t.TempDir()
	origPath := filepath.Join(repoPath, "a.png")
	writeFixture(t, origPath)

	repo, err := Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, origPath)
	if err != nil {
		t.Fatal(err)
	}
	imageID, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}

	oldPath, newPath, err := repo.MoveFile(imageID, filepath.Join("renamed", "b.png"))
	if err != nil {
		t.Fatalf("MoveFile: %v", err)
	}
	if oldPath != origPath {
		t.Fatalf("oldPath = %q, want %q", oldPath, origPath)
	}
	wantNew := filepath.Join(repoPath, "renamed", "b.png")
	if newPath != wantNew {
		t.Fatalf("newPath = %q, want %q", newPath, wantNew)
	}
	if _, err := os.Stat(wantNew); err != nil {
		t.Fatalf("expected file at new location: %v", err)
	}
	if _, err := os.Stat(origPath); !os.IsNotExist(err) {
		t.Fatalf("expected original location gone, stat err = %v", err)
	}
	gotPath, err := repo.GetFilePath(imageID)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != wantNew {
		t.Fatalf("file_path not updated: got %q, want %q", gotPath, wantNew)
	}

	// Moving back (undo's inverse) reuses the same function.
	oldPath2, newPath2, err := repo.MoveFile(imageID, "a.png")
	if err != nil {
		t.Fatalf("MoveFile (move back): %v", err)
	}
	if oldPath2 != wantNew || newPath2 != origPath {
		t.Fatalf("move-back paths wrong: old=%q new=%q", oldPath2, newPath2)
	}
	if _, err := os.Stat(origPath); err != nil {
		t.Fatalf("expected file restored to original location: %v", err)
	}
}

// TestMoveFileClampsEscape confirms MoveFile refuses a destination outside
// the repo root, the same clamping ListDirectory applies.
func TestMoveFileClampsEscape(t *testing.T) {
	repoPath := t.TempDir()
	origPath := filepath.Join(repoPath, "a.png")
	writeFixture(t, origPath)

	repo, err := Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, origPath)
	if err != nil {
		t.Fatal(err)
	}
	imageID, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := repo.MoveFile(imageID, "../escaped.png"); err == nil {
		t.Fatalf("expected MoveFile to reject an escaping destination")
	}
	// The file must be untouched after a rejected move.
	if _, err := os.Stat(origPath); err != nil {
		t.Fatalf("expected original file untouched after rejected move: %v", err)
	}
}
