package service

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"loom/internal/store"
)

func TestDirectoryDiscoveryWaitsForRepositoryOperationLock(t *testing.T) {
	repoPath := t.TempDir()
	assetPath := filepath.Join(repoPath, "folder", "new.png")
	if err := os.MkdirAll(filepath.Dir(assetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(assetPath, []byte("isolated media fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}

	unlock := store.LockRepoOperations(repoPath)
	discoveryDone := make(chan error, 1)
	go func() {
		discoveryDone <- (&ImageService{}).DiscoverDirectory(repoPath, "folder")
	}()
	select {
	case err := <-discoveryDone:
		unlock()
		t.Fatalf("directory discovery bypassed the repository lock: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	unlock()
	select {
	case err := <-discoveryDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("directory discovery did not finish after repository lock release")
	}
	listing, err := (&ImageService{}).ListDirectory(repoPath, "folder")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Files) != 1 || listing.Files[0].FileName != "new.png" {
		t.Fatalf("observed folder rows after discovery: %+v", listing.Files)
	}
}

func TestDirectoryObservationUsesCommittedImportAndRetainedVisibility(t *testing.T) {
	repoPath := t.TempDir()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	service := &ImageService{}
	ids, err := service.ImportMedia(repoPath, []ClipboardMedia{
		{Name: "kept.png", Data: "YQ=="},
		{Name: "trashed.png", Data: "Yg=="},
	}, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	listing, err := service.ListDirectory(repoPath, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Files) != 2 {
		t.Fatalf("committed imports not both visible in folder observation: %+v", listing.Files)
	}
	if err := service.TrashImage(repoPath, ids[1]); err != nil {
		t.Fatal(err)
	}
	listing, err = service.ListDirectory(repoPath, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Files) != 1 || listing.Files[0].FileName != "kept.png" {
		t.Fatalf("folder observation did not apply the retained/non-trashed predicate: %+v", listing.Files)
	}
	if err := service.DiscoverDirectory(repoPath, ""); err != nil {
		t.Fatal(err)
	}
	listing, err = service.ListDirectory(repoPath, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Files) != 1 || listing.Files[0].ID != ids[0] {
		t.Fatalf("discovery bypassed the retained visibility predicate: %+v", listing.Files)
	}
}
