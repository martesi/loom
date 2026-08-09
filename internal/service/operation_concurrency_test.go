package service

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"loom/internal/store"
)

func seedImagesForOperationTest(t *testing.T, repoPath string, count int) []int64 {
	t.Helper()
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	ids := make([]int64, count)
	for i := range ids {
		res, err := repo.DB.Exec(`INSERT INTO images (file_path) VALUES (?)`, filepath.Join(repoPath, fmt.Sprintf("image-%d.png", i)))
		if err != nil {
			t.Fatal(err)
		}
		ids[i], err = res.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
	}
	return ids
}

func TestConcurrentUndoAwareMutationsHaveDenseLog(t *testing.T) {
	repoPath := t.TempDir()
	ids := seedImagesForOperationTest(t, repoPath, 2)
	images := &ImageService{}

	start := make(chan struct{})
	results := make(chan error, len(ids))
	var wg sync.WaitGroup
	for _, imageID := range ids {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			<-start
			results <- images.SetArchived(repoPath, id, true)
		}(imageID)
	}
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent SetArchived: %v", err)
		}
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	var count, distinct int
	if err := repo.DB.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT seq) FROM operation_log`).Scan(&count, &distinct); err != nil {
		t.Fatal(err)
	}
	if count != 2 || distinct != 2 {
		t.Fatalf("operation log = count %d, distinct seq %d; want two dense unique entries", count, distinct)
	}
	for want := int64(1); want <= 2; want++ {
		var got int64
		if err := repo.DB.QueryRow(`SELECT seq FROM operation_log WHERE seq = ?`, want).Scan(&got); err != nil {
			t.Fatalf("missing dense operation seq %d: %v", want, err)
		}
	}
	repo.Close()

	undo := &UndoService{}
	undoResults := make(chan *UndoResult, 2)
	undoErrors := make(chan error, 2)
	for range 2 {
		go func() {
			result, err := undo.Undo(repoPath)
			undoResults <- result
			undoErrors <- err
		}()
	}
	for range 2 {
		if err := <-undoErrors; err != nil {
			t.Fatalf("concurrent Undo: %v", err)
		}
		if result := <-undoResults; result == nil || !result.Applied {
			t.Fatalf("concurrent Undo did not apply both operations: %+v", result)
		}
	}

	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var archived int
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM images WHERE archived = 1`).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if archived != 0 {
		t.Fatalf("two undos left %d archived images", archived)
	}
	cursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	if cursor != 0 {
		t.Fatalf("cursor after two undos = %d, want 0", cursor)
	}
}

func TestConcurrentDoubleUndoAppliesAtMostOnce(t *testing.T) {
	repoPath := t.TempDir()
	ids := seedImagesForOperationTest(t, repoPath, 1)
	images := &ImageService{}
	if err := images.SetArchived(repoPath, ids[0], true); err != nil {
		t.Fatal(err)
	}

	undo := &UndoService{}
	results := make(chan *UndoResult, 2)
	errors := make(chan error, 2)
	for range 2 {
		go func() {
			result, err := undo.Undo(repoPath)
			results <- result
			errors <- err
		}()
	}
	var applied int
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatalf("concurrent double Undo: %v", err)
		}
		if result := <-results; result != nil && result.Applied {
			applied++
		}
	}
	if applied != 1 {
		t.Fatalf("concurrent double Undo applied %d times, want exactly once", applied)
	}

	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var archived int
	if err := repo.DB.QueryRow(`SELECT archived FROM images WHERE id = ?`, ids[0]).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if archived != 0 {
		t.Fatalf("image remains archived after undo: %d", archived)
	}
	cursor, err := repo.UndoCursor()
	if err != nil {
		t.Fatal(err)
	}
	if cursor != 0 {
		t.Fatalf("cursor after double undo = %d, want 0", cursor)
	}
}

func TestMutationRollsBackWhenOperationLogAppendFails(t *testing.T) {
	repoPath := t.TempDir()
	ids := seedImagesForOperationTest(t, repoPath, 1)
	repo, err := store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.DB.Exec(`
		CREATE TRIGGER fail_operation_log BEFORE INSERT ON operation_log
		BEGIN
			SELECT RAISE(ABORT, 'forced operation-log failure');
		END`); err != nil {
		repo.Close()
		t.Fatal(err)
	}
	repo.Close()

	err = (&ImageService{}).SetArchived(repoPath, ids[0], true)
	if err == nil {
		t.Fatal("mutation unexpectedly succeeded with a failing operation-log trigger")
	}

	repo, err = store.Bootstrap(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	var archived, logCount int
	if err := repo.DB.QueryRow(`SELECT archived FROM images WHERE id = ?`, ids[0]).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if err := repo.DB.QueryRow(`SELECT COUNT(*) FROM operation_log`).Scan(&logCount); err != nil {
		t.Fatal(err)
	}
	if archived != 0 || logCount != 0 {
		t.Fatalf("failed log append left mutation/log state archived=%d logCount=%d", archived, logCount)
	}
}
